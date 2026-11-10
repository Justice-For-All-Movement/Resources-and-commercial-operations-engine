import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgSql } from '../src/service-kit.ts';
import type { BudgetPort } from '../src/service-kit.ts';
import { createEngine } from '../src/engine/index.ts';
import { code, ctx, needsPg, sleep, withEngine } from './engine-helpers.ts';

const human = ctx();
const agent = ctx({ actorId: 'agent-7', kind: 'agent', capabilities: ['resources:spend', 'resources:write', 'resources:read'] });
const req = (key: string, amount = 1, over: object = {}) => ({ category: 'model', amount, unit: 'tokens_out', subject: 'E06:job:j1', idempotencyKey: key, ...over });

test('50 parallel reservations racing a ceiling never oversubscribe (real parallel sessions)', needsPg, async () => {
  await withEngine(async (engine, _sql, url) => {
    const project = await engine.createBudget(human, { name: 'Project tokens', level: 'project', unit: 'tokens_out', ceiling: 1000 });
    const b = await engine.createBudget(human, { name: 'Agent 7', level: 'agent', unit: 'tokens_out', ceiling: 20, actorId: 'agent-7', parentId: project.id });
    const pool = new pg.Pool({ connectionString: url, max: 25 });
    try {
      const wide = createEngine({ sql: pgSql(pool) });
      const port: BudgetPort = wide.budgetPort;
      const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => port.reserve(agent, req(`race-${i}`))));
      const ok = results.filter((r) => r.status === 'fulfilled');
      assert.equal(ok.length, 20);
      for (const r of results) if (r.status === 'rejected') code('budget_exhausted')(r.reason);
      const node = (await engine.budgetTree(human))[0]!.children[0]!;
      assert.equal(node.id, b.id); assert.equal(node.reserved, 20); assert.equal(node.available, 0);
      assert.equal((await engine.budgetTree(human))[0]!.reserved, 20, 'parent accounts the same reservations');
      // mixed commit/release/reserve under contention keeps the counters exact
      const ids = ok.map((r) => (r as PromiseFulfilledResult<{ reservationId: string }>).value.reservationId);
      await Promise.all(ids.map((id, i) => (i % 2 === 0 ? port.commit(agent, id, { amount: 1 }) : port.release(agent, id, 'not needed'))));
      const again = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => port.reserve(agent, req(`race2-${i}`))));
      assert.equal(again.filter((r) => r.status === 'fulfilled').length, 10);
      const after = (await engine.budgetTree(human))[0]!.children[0]!;
      assert.deepEqual([after.committed, after.reserved, after.available], [10, 10, 0]);
    } finally { await pool.end(); }
    const exhausted = (await engine.events(human)).filter((e) => e.type === 'resources.budget_exhausted');
    assert.equal(exhausted.length, 1, 'one exhausted event per budget period, not one per denial');
    const inc = await engine.listIncidents(human, { kind: 'exhausted' });
    assert.equal(inc.length, 1); assert.equal(inc[0]!.count, 50);
  });
});

test('idempotent reserve/commit replay, release, validation', needsPg, async () => {
  await withEngine(async (engine) => {
    await engine.createBudget(human, { name: 'P', level: 'project', unit: 'money:EUR', ceiling: 10_000, warnBps: [5000, 9000] });
    const a = await engine.reserve(human, req('k1', 4000, { unit: 'EUR' }));
    assert.deepEqual(await engine.reserve(human, req('k1', 4000, { unit: 'EUR' })), a, 'replay returns the same reservation');
    await assert.rejects(engine.reserve(human, req('k1', 4001, { unit: 'EUR' })), code('idempotency_conflict'));
    assert.equal((await engine.budgetTree(human))[0]!.reserved, 4000);
    await engine.commit(human, a.reservationId, { amount: 3500, detail: { note: 'lower than reserved' } });
    await engine.commit(human, a.reservationId, { amount: 3500 });
    await assert.rejects(engine.commit(human, a.reservationId, { amount: 3600 }), code('invalid_state'));
    await assert.rejects(engine.release(human, a.reservationId, 'late'), code('invalid_state'));
    const b = await engine.reserve(human, req('k2', 2000, { unit: 'money:EUR' }));
    await engine.release(human, b.reservationId, 'cancelled'); await engine.release(human, b.reservationId, 'cancelled');
    const node = (await engine.budgetTree(human))[0]!;
    assert.deepEqual([node.committed, node.reserved, node.available], [3500, 0, 6500]);
    await assert.rejects(engine.commit(human, b.reservationId, { amount: 1 }), code('invalid_state'));
    await assert.rejects(engine.reserve(human, req('k3', 0, { unit: 'EUR' })), code('invalid_input'));
    await assert.rejects(engine.reserve(human, req('k3', 1.5, { unit: 'EUR' })), code('invalid_input'));
    await assert.rejects(engine.reserve(human, req('k3', 1, { unit: 'bananas' })), code('invalid_input'));
    await assert.rejects(engine.commit(human, '00000000-0000-4000-8000-000000000000', { amount: 1 }), code('not_found'));
    // warnings: 4000 reserved = 40% (none); +2000 = 60% → 5000 bps; each threshold once
    await engine.reserve(human, req('k4', 2500, { unit: 'EUR' }));
    await engine.reserve(human, req('k5', 3500, { unit: 'EUR' }));
    const warnings = (await engine.events(human)).filter((e) => e.type === 'resources.budget_warning').map((e) => (e.payload as { thresholdBps: number }).thresholdBps);
    assert.deepEqual(warnings, [5000, 9000]);
    await assert.rejects(engine.reserve(human, req('k6', 501, { unit: 'EUR' })), code('budget_exhausted'));
    assert.equal((await engine.reserve(human, req('k6', 500, { unit: 'EUR' }))).reservationId.length, 36, 'a denied key is not poisoned; a later attempt that fits succeeds');
    assert.ok((await engine.burn(human, { unit: 'EUR' })).some((x) => x.committed === 3500));
  });
});

test('agents and services without an explicit budget assignment are denied; no budget means no spend', needsPg, async () => {
  await withEngine(async (engine) => {
    await assert.rejects(engine.reserve(human, req('h0')), code('budget_exhausted'));
    const project = await engine.createBudget(human, { name: 'P', level: 'project', unit: 'tokens_out', ceiling: 100 });
    await engine.reserve(human, req('h1'));
    await assert.rejects(engine.reserve(agent, req('a1')), code('budget_exhausted'));
    await assert.rejects(engine.reserve(ctx({ actorId: 'svc-1', kind: 'service' }), req('s1')), code('budget_exhausted'));
    assert.equal((await engine.listIncidents(human, { kind: 'unassigned_actor' })).length, 2);
    await engine.assignBudget(human, project.id, 'agent-7');
    await engine.reserve(agent, req('a1'));
    await engine.assignBudget(human, project.id, 'agent-7', false);
    await assert.rejects(engine.reserve(agent, req('a2')), code('budget_exhausted'));
    // an agent-level cap bounds unattended spending even inside a large project budget
    await engine.createBudget(human, { name: 'cap', level: 'agent', unit: 'tokens_out', ceiling: 3, actorId: 'agent-7', parentId: project.id, period: 'monthly' });
    await engine.reserve(agent, req('a3', 3));
    await assert.rejects(engine.reserve(agent, req('a4', 1)), code('budget_exhausted'));
    // capability is required and fails closed; agents cannot define or unfreeze budgets
    await assert.rejects(engine.reserve(ctx({ capabilities: ['resources:*'] }), req('w1')), code('forbidden'));
    await assert.rejects(engine.createBudget(agent, { name: 'x', level: 'project', unit: 'EUR', ceiling: 1 }), code('forbidden'));
    await assert.rejects(engine.setBudgetState(ctx({ actorId: 'agent-7', kind: 'agent' }), project.id, 'freeze', 'x'), code('forbidden'));
  });
});

test('overage: within tolerance commits quietly; beyond tolerance commits, records an incident and freezes', needsPg, async () => {
  await withEngine(async (engine) => {
    const p = await engine.createBudget(human, { name: 'P', level: 'project', unit: 'render_seconds', ceiling: 1000, overageToleranceBps: 1000 });
    const lane = await engine.createBudget(human, { name: 'Lane A', level: 'lane', unit: 'render_seconds', ceiling: 500, lane: 'a', parentId: p.id, overageToleranceBps: 1000 });
    const r = (o: object) => ({ category: 'render', unit: 'render_seconds', subject: 'E10:render:r1', lane: 'a', ...o }) as never;
    const a = await engine.reserve(human, r({ amount: 100, idempotencyKey: 'o1' }));
    await engine.commit(human, a.reservationId, { amount: 110 });
    assert.equal((await engine.getBudget(human, lane.id)).state, 'active');
    const b = await engine.reserve(human, r({ amount: 100, idempotencyKey: 'o2' }));
    await engine.commit(human, b.reservationId, { amount: 150 });
    assert.equal((await engine.getBudget(human, lane.id)).state, 'frozen');
    assert.equal((await engine.getBudget(human, p.id)).state, 'active', 'only the most specific budget is frozen');
    const tree = (await engine.budgetTree(human))[0]!;
    assert.equal(tree.committed, 260, 'in-flight work beyond tolerance is still accounted'); assert.equal(tree.children[0]!.committed, 260);
    assert.equal((await engine.listIncidents(human, { kind: 'overage' })).length, 1);
    const types = (await engine.events(human)).map((e) => e.type);
    assert.ok(types.includes('resources.budget_exceeded') && types.includes('resources.budget_frozen'));
    await assert.rejects(engine.reserve(human, r({ amount: 1, idempotencyKey: 'o3' })), code('budget_exhausted'));
    await engine.setBudgetState(human, lane.id, 'unfreeze', 'reviewed the overage');
    await engine.reserve(human, r({ amount: 1, idempotencyKey: 'o3' }));
    assert.equal((await engine.listIncidents(human, { open: true })).length, 0);
  });
});

test('reservations expire through the kit job and return capacity; late commits are still accounted', needsPg, async () => {
  await withEngine(async (engine, sql) => {
    const short = createEngine({ sql, config: { reservationTtlSeconds: 1 } });
    await short.createBudget(human, { name: 'P', level: 'project', unit: 'compute_seconds', ceiling: 10 });
    const q = (key: string, amount: number) => ({ category: 'ocr', amount, unit: 'compute_seconds', subject: 'E06:job:x', idempotencyKey: key });
    const fresh = ctx();
    const a = await short.reserve(fresh, q('e1', 10));
    await assert.rejects(short.reserve(fresh, q('e2', 1)), code('budget_exhausted'));
    assert.equal(await short.runJobs(), 0, 'not due yet');
    await sleep(1200);
    assert.equal(await short.runJobs(), 1);
    assert.equal((await short.getReservation(human, a.reservationId)).state, 'expired');
    assert.equal((await short.budgetTree(human))[0]!.available, 10);
    const b = await short.reserve(ctx(), q('e2', 4));
    await short.commit(human, a.reservationId, { amount: 3 });
    const node = (await short.budgetTree(human))[0]!;
    assert.deepEqual([node.committed, node.reserved], [3, 4]);
    // lazy reclaim: an expired hold never blocks a new reservation even if the job has not run yet
    await sleep(1100);
    const later = { ...human, now: new Date().toISOString() };
    await short.reserve(later, q('e3', 7));
    assert.equal((await short.getReservation(human, b.reservationId)).state, 'expired');
    assert.equal((await engine.expireReservations(human)).expired, 0);
  });
});

test('monthly budgets reset by period; previously authorized smaller plan is used with visible tradeoffs', needsPg, async () => {
  await withEngine(async (engine) => {
    await engine.createBudget(human, { name: 'Render month', level: 'project', unit: 'render_seconds', ceiling: 100, period: 'monthly' });
    const jan = { ...human, now: '2031-01-15T00:00:00.000Z' }, feb = { ...human, now: '2031-02-01T00:00:00.000Z' };
    const q = (key: string, amount: number) => ({ category: 'render', amount, unit: 'render_seconds', subject: 'E10:render:film', idempotencyKey: key });
    await engine.reserve(jan, q('m1', 70));
    await assert.rejects(engine.reserveWithPlans(jan, q('m2', 60)), code('budget_exhausted'));
    await assert.rejects(engine.authorizeFallbackPlan(ctx({ actorId: 'agent-7', kind: 'agent' }), { category: 'render', unit: 'render_seconds', name: 'preview', amount: 20, tradeoffs: 'x' }), code('forbidden'));
    await engine.authorizeFallbackPlan(human, { category: 'render', unit: 'render_seconds', name: 'half-resolution', amount: 40, tradeoffs: '540p instead of 1080p' });
    await engine.authorizeFallbackPlan(human, { category: 'render', unit: 'render_seconds', name: 'preview', amount: 20, tradeoffs: 'Watermarked 360p preview only' });
    const out = await engine.reserveWithPlans(jan, q('m2', 60));
    assert.equal(out.plan, 'preview'); assert.equal(out.amount, 20); assert.match(out.tradeoffs!, /preview/);
    assert.deepEqual(out.skipped.map((s) => s.plan), ['preferred', 'half-resolution']);
    assert.equal((await engine.getReservation(human, out.reservationId)).plan, 'preview');
    assert.deepEqual(await engine.reserveWithPlans(jan, q('m2', 60)), out);
    assert.equal((await engine.reserveWithPlans(feb, q('m3', 60))).plan, 'preferred', 'new month, fresh capacity');
    const node = (await engine.budgetTree(feb))[0]!;
    assert.equal(node.periodKey, '2031-02'); assert.equal(node.reserved, 60); assert.equal(node.forecast!.method, 'linear_projection');
  });
});
