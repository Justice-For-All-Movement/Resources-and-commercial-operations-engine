import test from 'node:test';
import assert from 'node:assert/strict';
import { code, ctx, needsPg, withEngine } from './engine-helpers.ts';

const human = ctx();
test('usage metering: rate card with effective dates, declared costs, unpriced usage, commit through usage', needsPg, async () => {
  await withEngine(async (engine) => {
    await engine.setRate(human, { provider: 'model-co', model: 'large', meter: 'tokens_in', currency: 'USD', pricePerMillion: 300, effectiveFrom: '2030-01-01T00:00:00Z' });
    await engine.setRate(human, { provider: 'model-co', model: 'large', meter: 'tokens_out', currency: 'USD', pricePerMillion: 1500, effectiveFrom: '2030-01-01T00:00:00Z' });
    await engine.setRate(human, { provider: 'model-co', model: 'large', meter: 'tokens_out', currency: 'USD', pricePerMillion: 3000, effectiveFrom: '2030-06-01T00:00:00Z', organizationWide: true });
    await assert.rejects(engine.setRate(human, { provider: 'model-co', model: 'large', meter: 'tokens_in', currency: 'USD', pricePerMillion: 1, effectiveFrom: '2030-01-01T00:00:00Z' }), code('conflict'));
    const base = { kind: 'model_call' as const, provider: 'model-co', model: 'large', subject: 'E06:job:j1', lane: 'a' };
    const u1 = await engine.recordUsage(human, { ...base, quantities: { tokens_in: 2_000_000, tokens_out: 1_000_000 }, occurredAt: '2030-03-01T00:00:00Z', idempotencyKey: 'u1' });
    assert.equal(u1.costMinor, 2100); assert.equal(u1.costSource, 'rate_card');
    assert.deepEqual(await engine.recordUsage(human, { ...base, quantities: { tokens_in: 2_000_000, tokens_out: 1_000_000 }, occurredAt: '2030-03-01T00:00:00Z', idempotencyKey: 'u1' }), u1, 'replay records nothing new');
    const u2 = await engine.recordUsage(human, { ...base, quantities: { tokens_out: 1_000_000 }, occurredAt: '2030-07-01T00:00:00Z', idempotencyKey: 'u2' });
    assert.equal(u2.costMinor, 1500, 'the project rate still wins over the later organization-wide rate');
    const u3 = await engine.recordUsage(human, { ...base, model: 'small', quantities: { tokens_out: 10, compute_seconds: 5 }, idempotencyKey: 'u3' });
    assert.equal(u3.costMinor, null); assert.equal(u3.costSource, 'unpriced'); assert.deepEqual(u3.unpricedMeters, ['tokens_out', 'compute_seconds']);
    const u4 = await engine.recordUsage(human, { kind: 'rendering', provider: 'render-farm', quantities: { render_seconds: 90 }, cost: { amountMinor: 450, currency: 'USD' }, subject: 'E10:render:r1', workRef: 'E09:work:film', lane: 'b', idempotencyKey: 'u4' });
    assert.equal(u4.costSource, 'declared');
    await assert.rejects(engine.recordUsage(human, { ...base, quantities: { bananas: 1 } as never, idempotencyKey: 'u5' }), code('invalid_input'));
    await assert.rejects(engine.recordUsage(human, { ...base, quantities: {}, workRef: 'E08:finding:f1', idempotencyKey: 'u6' }), code('invalid_incentive_linkage'));
    // commit a token reservation with the actual metered quantity
    await engine.createBudget(human, { name: 'tokens', level: 'project', unit: 'tokens_out', ceiling: 5000 });
    const r = await engine.reserve(human, { category: 'model', amount: 1000, unit: 'tokens_out', subject: 'E06:job:j2', idempotencyKey: 'r1' });
    await engine.recordUsage(human, { ...base, quantities: { tokens_in: 50, tokens_out: 640 }, reservationId: r.reservationId, idempotencyKey: 'u7' });
    const res = await engine.getReservation(human, r.reservationId);
    assert.equal(res.state, 'committed'); assert.equal(res.actual, 640);
    const byModel = await engine.usageReport(human, { groupBy: 'model' });
    const large = byModel.find((x) => x.key === 'model-co/large' && x.currency === 'USD')!;
    assert.equal(large.tokensOut, 2_000_000); assert.equal(large.costMinor, 3600);
    assert.equal(byModel.find((x) => x.key === 'model-co/large' && x.currency === null)!.tokensOut, 640, 'usage before any rate took effect is reported as unpriced');
    assert.equal(byModel.find((x) => x.key === 'model-co/small')!.unpricedRecords, 1);
    assert.equal((await engine.usageReport(human, { groupBy: 'lane' })).find((x) => x.key === 'b')!.costMinor, 450);
    assert.equal((await engine.topCosts(human, { limit: 1 }))[0]!.costMinor, 2100);
    assert.equal((await engine.projectPnl(human)).works.find((w) => w.workRef === 'E09:work:film')!.usageCostsMinor, 450);
    assert.equal((await engine.usageReport(ctx({ tenantId: 'org-b' }))).length, 0);
  });
});

test('research lanes: equal-effort policy as configuration; report measures actual work, never conclusions', needsPg, async () => {
  await withEngine(async (engine) => {
    const empty = await engine.laneAllocationReport(human);
    assert.equal(empty.policyVersion, null); assert.equal(empty.withinTolerance, true);
    // the comparison selection is reviewed deployment configuration carried as data; code does not choose it
    const policy = await engine.setLanePolicy(human, { allocation: 'equal', driftToleranceBps: 500, lanes: [
      { key: 'domestic', name: 'Domestic lane' },
      { key: 'comparison', name: 'Comparison lane', configuration: { selection: 'Republic of Examplia', reviewedBy: 'editor-2', reviewRef: 'E09:decision:d1' } },
    ] });
    assert.equal(policy.version, 1);
    assert.deepEqual((policy.lanes as { targetShareBps: number }[]).map((l) => l.targetShareBps), [5000, 5000]);
    assert.deepEqual(((await engine.setLanePolicy(human, { allocation: 'equal', lanes: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }, { key: 'c', name: 'C' }] })).lanes as { targetShareBps: number }[]).map((l) => l.targetShareBps), [3334, 3333, 3333]);
    await assert.rejects(engine.setLanePolicy(human, { allocation: 'explicit', lanes: [{ key: 'a', name: 'A', targetShareBps: 6000 }, { key: 'b', name: 'B', targetShareBps: 3000 }] }), code('invalid_input'));
    await assert.rejects(engine.setLanePolicy(human, { allocation: 'equal', lanes: [{ key: 'a', name: 'A' }, { key: 'a', name: 'again' }] }), code('invalid_input'));
    // no mechanism ties effort to conclusions
    await assert.rejects(engine.setLanePolicy(human, { allocation: 'equal', lanes: [{ key: 'a', name: 'A', configuration: { findingsQuota: 3 } }] }), code('invalid_incentive_linkage'));
    await assert.rejects(engine.setLanePolicy(human, { allocation: 'equal', lanes: [{ key: 'a', name: 'A', configuration: { target: 'E08:finding:f1' } }] }), code('invalid_incentive_linkage'));
    await engine.setLanePolicy(human, { allocation: 'equal', driftToleranceBps: 500, lanes: [{ key: 'domestic', name: 'Domestic lane' }, { key: 'comparison', name: 'Comparison lane' }] });
    const work = (lane: string, key: string, seconds: number, attempts = 1, actor = 'agent-1') => engine.recordWork(human, { lane, task: 'E08:task:t1', objective: 'E00:objective:o1', startedAt: '2030-01-01T00:00:00Z', endedAt: '2030-01-01T02:00:00Z', activeSeconds: seconds, attempts, actorId: actor, actorKind: 'agent', idempotencyKey: key });
    await work('domestic', 'w1', 3600, 2); await work('domestic', 'w2', 3000); await work('comparison', 'w3', 3400, 3, 'agent-2');
    assert.deepEqual(await work('comparison', 'w3', 3400, 3, 'agent-2'), await work('comparison', 'w3', 3400, 3, 'agent-2'));
    await assert.rejects(work('domestic', 'w4', 99999), code('invalid_input'));
    await assert.rejects(engine.recordWork(human, { lane: 'domestic', task: 'E08:task:t1', startedAt: '2030-01-01T00:00:00Z', endedAt: '2030-01-01T01:00:00Z', activeSeconds: 1, idempotencyKey: 'w5', findings: 4 } as never), code('invalid_incentive_linkage'));
    await engine.setRate(human, { provider: 'm', meter: 'tokens_out', currency: 'EUR', pricePerMillion: 1_000_000, effectiveFrom: '2020-01-01T00:00:00Z' });
    await engine.recordUsage(human, { kind: 'model_call', provider: 'm', quantities: { tokens_out: 300, compute_seconds: 10 }, subject: 'E08:task:t1', lane: 'domestic', idempotencyKey: 'lu1' });
    await engine.recordUsage(human, { kind: 'model_call', provider: 'm', quantities: { tokens_out: 100, compute_seconds: 30 }, subject: 'E08:task:t2', lane: 'comparison', idempotencyKey: 'lu2' });
    await engine.recordUsage(human, { kind: 'processing', provider: 'm', quantities: { compute_seconds: 5 }, subject: 'E06:job:x', lane: 'stray', idempotencyKey: 'lu3' });
    const report = await engine.laneAllocationReport(human);
    const dom = report.lanes.find((l) => l.key === 'domestic')!, cmp = report.lanes.find((l) => l.key === 'comparison')!, stray = report.lanes.find((l) => l.key === 'stray')!;
    assert.deepEqual([dom.activeSeconds, dom.attempts, dom.workRecords, dom.tokensOut, dom.computeSeconds, dom.cost.EUR], [6600, 3, 2, 300, 10, 300]);
    assert.deepEqual([cmp.activeSeconds, cmp.attempts, cmp.workRecords, cmp.tokensOut, cmp.cost.EUR], [3400, 3, 1, 100, 100]);
    assert.equal(dom.targetShareBps, 5000); assert.equal(dom.actualShareBps.active_seconds, 6600); assert.equal(dom.driftBps, 1600);
    assert.equal(cmp.driftBps, -1600); assert.equal(cmp.actualShareBps.money, 2500); assert.equal(cmp.actualShareBps.attempts, 5000);
    assert.equal(stray.configured, false);
    assert.equal(report.maxAbsDriftBps, 1600); assert.equal(report.withinTolerance, false);
    assert.deepEqual(report.underAllocated, ['comparison']); assert.deepEqual(report.overAllocated, ['domestic']);
    assert.doesNotMatch(JSON.stringify(report), /finding|claim|accus|conclusion/i);
    const balanced = await engine.laneAllocationReport(human, { from: '2031-01-01T00:00:00Z' });
    assert.equal(balanced.totals.active_seconds, 0); assert.equal(balanced.withinTolerance, true);
    assert.equal((await engine.laneAllocationReport(ctx({ projectId: 'proj-2' }))).lanes.length, 0);
    assert.equal((await engine.listWork(ctx({ tenantId: 'org-b' }))).length, 0);
  });
});
