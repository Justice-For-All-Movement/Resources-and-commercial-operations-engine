// End-to-end over real HTTP against the standalone server (`serve.ts`), real PostgreSQL, the sandbox payment simulator and LibreOffice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { generateSigningKey, signAccessToken, verifyAuditChain, withDisposableDatabase } from '../src/service-kit.ts';
import { signPayload } from '../src/engine/index.ts';
import type { AuditRecord } from '../src/service-kit.ts';
import { main } from '../src/engine/serve.ts';
import { ADMIN, ALL, needsPg, sleep } from './engine-helpers.ts';

test('HTTP end-to-end: budgets, usage, lanes, invoice, sandbox payment, isolation and fail-closed authorization', needsPg, async () => {
  await withDisposableDatabase(pg, ADMIN, async (url, sql) => {
    const key = generateSigningKey('k1'); const store = mkdtempSync(join(tmpdir(), 'e13-http-'));
    const server = await main({ DATABASE_URL: url, PORT: '0', IDENTITY_PUBLIC_KEYS: JSON.stringify({ k1: key.publicKeyPem }), IDENTITY_ISSUER: 'iap', PAYMENT_SANDBOX: '1', SANDBOX_WEBHOOK_SECRET: 'http-test-sandbox-secret-0001', JOB_POLL_MS: '100', OBJECT_STORE_PATH: store, INVOICE_ISSUER: JSON.stringify({ name: 'Example Films Cooperative', taxId: 'XX-99' }) });
    const base = `http://127.0.0.1:${server.port}`; const now = Math.floor(Date.now() / 1000);
    const token = (sub: string, o: { kind?: 'human' | 'agent' | 'service'; tid?: string; pid?: string; caps?: string[]; exp?: number } = {}) => signAccessToken({ iss: 'iap', sub, kind: o.kind ?? 'human', tid: o.tid ?? 'org-a', pid: o.pid ?? 'proj-1', roles: [], caps: o.caps ?? ALL, cmp: [], purpose: 'test', pv: '1', iat: now, exp: o.exp ?? now + 600, jti: `${sub}-${Math.random()}` }, key);
    const call = async (tok: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: any; bytes: Uint8Array; type: string }> => {
      const res = await fetch(`${base}${path}`, { method, headers: { ...(tok === null ? {} : { authorization: `Bearer ${tok}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const bytes = new Uint8Array(await res.arrayBuffer()); let json: unknown = null; try { json = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { /* binary */ }
      return { status: res.status, json, bytes, type: res.headers.get('content-type') ?? '' };
    };
    const alice = token('alice'), bob = token('bob'), agent = token('agent-7', { kind: 'agent', caps: ['resources:spend', 'resources:write', 'resources:read'] });
    const outsider = token('zed', { tid: 'org-b' }), otherProject = token('alice', { pid: 'proj-2' });
    try {
      assert.equal((await call(null, 'GET', '/healthz')).status, 200);
      assert.equal((await call(null, 'GET', '/v1/manifest')).json.id, 'E13');
      // fail closed
      assert.equal((await call(null, 'GET', '/v1/budgets')).status, 401);
      assert.equal((await call(token('alice', { exp: now - 10 }), 'GET', '/v1/budgets')).status, 401);
      assert.equal((await call(token('alice', { caps: [] }), 'GET', '/v1/budgets')).status, 403);
      assert.equal((await call(token('alice', { caps: ['resources:read'] }), 'POST', '/v1/budgets', { name: 'x', level: 'project', unit: 'EUR', ceiling: 1 })).status, 403);
      assert.equal((await call(token('alice', { caps: ['resources:*'] }), 'POST', '/v1/reservations', { category: 'c', amount: 1, unit: 'EUR', subject: 's', idempotencyKey: 'k' })).status, 403, 'spend is never granted by a wildcard');
      assert.equal((await call(token('alice', { caps: ['resources:*'] }), 'GET', '/v1/events')).status, 403);
      assert.equal((await call(token('alice', { caps: ['resources:*'] }), 'GET', '/v1/exports/journal')).status, 403);
      assert.equal((await call(token('alice', { caps: ['evidence:read', 'evidence:spend'] }), 'GET', '/v1/budgets')).status, 403);
      // budgets and the BudgetPort over HTTP
      const project = await call(alice, 'POST', '/v1/budgets', { name: 'Model tokens', level: 'project', unit: 'tokens_out', ceiling: 1000, warnBps: [5000] });
      assert.equal(project.status, 201);
      const cap = await call(alice, 'POST', '/v1/budgets', { name: 'Agent 7 cap', level: 'agent', unit: 'tokens_out', ceiling: 300, actorId: 'agent-7', parentId: project.json.id });
      assert.equal((await call(agent, 'POST', '/v1/budgets', { name: 'self-serve', level: 'project', unit: 'tokens_out', ceiling: 1e9 })).status, 403);
      const rq = { category: 'model', unit: 'tokens_out', subject: 'E06:job:j1', lane: 'domestic' };
      const r1 = await call(agent, 'POST', '/v1/reservations', { ...rq, amount: 250, idempotencyKey: 'r1' });
      assert.equal(r1.status, 201);
      assert.equal((await call(agent, 'POST', '/v1/reservations', { ...rq, amount: 250, idempotencyKey: 'r1' })).json.reservationId, r1.json.reservationId);
      const denied = await call(agent, 'POST', '/v1/reservations', { ...rq, amount: 100, idempotencyKey: 'r2' });
      assert.equal(denied.status, 402); assert.equal(denied.json.error.code, 'budget_exhausted');
      assert.equal((await call(token('agent-9', { kind: 'agent', caps: ['resources:spend'] }), 'POST', '/v1/reservations', { ...rq, amount: 1, idempotencyKey: 'r3' })).status, 402, 'unassigned agent');
      assert.equal((await call(agent, 'POST', `/v1/reservations/${r1.json.reservationId}/commit`, { amount: 240 })).status, 204);
      assert.equal((await call(agent, 'POST', `/v1/budgets/${cap.json.id}/state`, { action: 'unfreeze', reason: 'x' })).status, 403);
      const tree = (await call(alice, 'GET', '/v1/budgets')).json;
      assert.deepEqual([tree[0].committed, tree[0].children[0].committed, tree[0].children[0].available], [240, 240, 60]);
      // usage, work, lanes
      assert.equal((await call(alice, 'POST', '/v1/rates', { provider: 'model-co', meter: 'tokens_out', currency: 'EUR', pricePerMillion: 2_000_000, effectiveFrom: '2020-01-01T00:00:00Z' })).status, 201);
      assert.equal((await call(agent, 'POST', '/v1/usage', { kind: 'model_call', provider: 'model-co', quantities: { tokens_out: 240 }, subject: 'E06:job:j1', lane: 'domestic', workRef: 'E09:work:film', idempotencyKey: 'u1' })).json.costMinor, 480);
      assert.equal((await call(alice, 'POST', '/v1/lanes/policy', { allocation: 'equal', lanes: [{ key: 'domestic', name: 'Domestic' }, { key: 'comparison', name: 'Comparison', configuration: { selection: 'Republic of Examplia', reviewedBy: 'editor-2' } }] })).status, 201);
      const w = { task: 'E08:task:t1', startedAt: '2030-01-01T00:00:00Z', endedAt: '2030-01-01T01:00:00Z', activeSeconds: 1800 };
      assert.equal((await call(agent, 'POST', '/v1/work', { ...w, lane: 'domestic', idempotencyKey: 'w1' })).status, 201);
      assert.equal((await call(agent, 'POST', '/v1/work', { ...w, lane: 'comparison', idempotencyKey: 'w2' })).status, 201);
      assert.equal((await call(agent, 'POST', '/v1/work', { ...w, lane: 'comparison', idempotencyKey: 'w3', findingsCount: 2 })).status, 400);
      const lanes = (await call(alice, 'GET', '/v1/lanes/report')).json;
      assert.equal(lanes.withinTolerance, true); assert.deepEqual(lanes.lanes.map((l: any) => l.actualShareBps.active_seconds), [5000, 5000]);
      // invoice → PDF → sandbox payment → webhook delivered by the server's worker loop
      const draft = await call(alice, 'POST', '/v1/invoices', { customer: { name: 'Example Broadcasting Cooperative' }, currency: 'EUR', idempotencyKey: 'i1', lines: [{ description: 'License', quantity: 1, unitPriceMinor: 90_000, taxRateBps: 1000, workRef: 'E09:work:film', channel: 'broadcast' }] });
      assert.equal(draft.status, 201);
      assert.equal((await call(agent, 'POST', `/v1/invoices/${draft.json.id}/issue`)).status, 403);
      assert.equal((await call(bob, 'POST', `/v1/invoices/${draft.json.id}/issue`)).json.number, 'INV-000001');
      const pdf = await call(alice, 'GET', `/v1/invoices/${draft.json.id}/document?format=pdf`);
      assert.equal(pdf.type, 'application/pdf'); assert.equal(Buffer.from(pdf.bytes.subarray(0, 5)).toString(), '%PDF-');
      assert.deepEqual(readdirSync(store), ['org-a'], 'object keys start with the tenant'); assert.deepEqual(readdirSync(join(store, 'org-a')), ['proj-1']);
      assert.equal((await call(alice, 'POST', `/v1/invoices/${draft.json.id}/sent`, { channel: 'email' })).json.state, 'sent');
      const pay = await call(alice, 'POST', '/v1/payments', { invoiceId: draft.json.id, provider: 'sandbox', method: 'sandbox_delay', idempotencyKey: 'p1' });
      assert.equal(pay.status, 201); assert.equal(pay.json.state, 'processing'); assert.equal(pay.json.mode, 'sandbox');
      await sql.query(`update e13_resources.sandbox_payments set status='succeeded' where id=$1`, [pay.json.providerRef]); // the simulated bank settles
      let state = '';
      for (let i = 0; i < 100 && state !== 'succeeded'; i++) { await sleep(100); state = (await call(alice, 'GET', `/v1/payments/${pay.json.id}`)).json.state; if (i === 5) await call(alice, 'POST', `/v1/payments/${pay.json.id}/reconcile`); }
      assert.equal(state, 'succeeded');
      assert.equal((await call(alice, 'GET', `/v1/invoices/${draft.json.id}`)).json.state, 'paid');
      // webhook endpoint: public but signature-authenticated
      const evil = JSON.stringify({ id: 'sbx_evt_forged', type: 'payment.succeeded', created: now, data: { payment: { id: 'x', status: 'succeeded', metadata: { payment_id: pay.json.id } } } });
      const hook = (sig: string) => fetch(`${base}/v1/payments/webhooks/sandbox`, { method: 'POST', headers: { 'content-type': 'application/json', 'sandbox-signature': sig }, body: evil });
      assert.equal((await hook(signPayload('guessed-secret-000000000', evil, now))).status, 400);
      assert.equal((await hook(signPayload('http-test-sandbox-secret-0001', evil, now - 4000))).status, 400);
      assert.equal((await hook(signPayload('http-test-sandbox-secret-0001', evil, now))).status, 200, 'correctly signed');
      assert.equal((await sql.query(`select 1 from e13_resources.journal_entries where source_kind='payment'`)).length, 1, 'still exactly one receipt');
      assert.equal((await fetch(`${base}/v1/payments/webhooks/stripe`, { method: 'POST', body: '{}' })).status, 503, 'Stripe is explicitly unavailable without credentials');
      // operator views
      const costs = (await call(alice, 'GET', '/v1/projects/proj-1/costs')).json;
      assert.equal(costs.pnl.currencies.EUR.revenueMinor, 90_000); assert.equal(costs.pnl.currencies.EUR.usageCostsMinor, 480); assert.equal(costs.usageByLane[0].key, 'domestic'); assert.equal(costs.budgets.length, 1);
      assert.equal((await call(alice, 'GET', '/v1/projects/proj-2/costs')).status, 404);
      assert.equal((await call(alice, 'GET', '/v1/ledger/trial-balance')).json.balanced, true);
      assert.equal((await call(alice, 'GET', '/v1/incidents?kind=exhausted')).json.length, 1);
      const csv = await call(alice, 'GET', '/v1/exports/invoices?format=csv');
      assert.match(csv.type, /text\/csv/); assert.match(Buffer.from(csv.bytes).toString(), /INV-000001/);
      assert.equal((await call(alice, 'GET', `/v1/inspect?ref=${encodeURIComponent(`E13:invoice:${draft.json.id}`)}`)).json.state, 'paid');
      assert.ok((await call(alice, 'GET', '/v1/search?q=Model')).json.length >= 1);
      assert.ok((await call(alice, 'GET', '/v1/events?limit=1000')).json.some((e: any) => e.type === 'resources.payment_succeeded'));
      const audit = (await call(alice, 'GET', '/v1/audit?limit=1000')).json as AuditRecord[];
      assert.ok(audit.length > 15); assert.ok(verifyAuditChain(audit)); assert.doesNotMatch(JSON.stringify(audit), /sandbox-secret|sbx_key_/);
      // upstream change over HTTP
      const lic = await call(alice, 'POST', '/v1/licenses', { direction: 'outbound', title: 'Broadcast', counterparty: 'Example Broadcasting Cooperative', subjectRef: 'E09:work:film', scope: 'one territory', startsOn: '2030-01-01', permissionRefs: ['E11:permission:p1'] });
      const up = await call(alice, 'POST', '/v1/upstream-changes', { eventId: 'e-1', kind: 'permission_withdrawn', refs: ['E11:permission:p1'], reason: 'withdrawn' });
      assert.deepEqual(up.json.affected, [`E13:license:${lic.json.id}`]);
      // tenant and project isolation through every read surface
      for (const who of [outsider, otherProject]) {
        for (const path of ['/v1/budgets', '/v1/reservations', '/v1/incidents', '/v1/rates', '/v1/usage/report', '/v1/usage/top', '/v1/work', '/v1/ledger/entries', '/v1/contributors', '/v1/agreements', '/v1/licenses', '/v1/expenses', '/v1/invoices', '/v1/revenue', '/v1/revenue/by-work', '/v1/statements', '/v1/payments', '/v1/burn', '/v1/search?q=e', '/v1/audit', '/v1/exports/invoices', '/v1/exports/journal', '/v1/exports/payments', '/v1/exports/usage']) {
          const r = await call(who, 'GET', path);
          assert.equal(r.status, 200, path); assert.deepEqual(r.json, [], `${path} leaks nothing`);
        }
        assert.equal((await call(who, 'GET', '/v1/lanes/policy')).json, null);
        assert.equal((await call(who, 'GET', '/v1/lanes/report')).json.lanes.length, 0);
        assert.deepEqual((await call(who, 'GET', '/v1/pnl')).json.works, []);
        assert.deepEqual((await call(who, 'GET', '/v1/ledger/trial-balance')).json.accounts, []);
        for (const path of [`/v1/budgets/${project.json.id}`, `/v1/reservations/${r1.json.reservationId}`, `/v1/invoices/${draft.json.id}`, `/v1/invoices/${draft.json.id}/document?format=html`, `/v1/payments/${pay.json.id}`, `/v1/inspect?ref=${encodeURIComponent(`E13:invoice:${draft.json.id}`)}`, `/v1/inspect?ref=${encodeURIComponent(`E13:budget:${project.json.id}`)}`]) {
          const r = await call(who, 'GET', path); assert.equal(r.status, 404, path); assert.equal(r.json.error.message, 'Not found');
        }
        assert.equal((await call(who, 'POST', `/v1/reservations/${r1.json.reservationId}/commit`, { amount: 1 })).status, 404);
        assert.equal((await call(who, 'POST', `/v1/invoices/${draft.json.id}/void`, { reason: 'x' })).status, 404);
        assert.equal((await call(who, 'POST', '/v1/payments', { invoiceId: draft.json.id, provider: 'sandbox', idempotencyKey: 'x1' })).status, 404);
        assert.equal((await call(who, 'POST', `/v1/payments/${pay.json.id}/reconcile`)).status, 404);
        assert.deepEqual((await call(who, 'POST', '/v1/payments/reconcile', {})).json.checked, 0);
        assert.deepEqual((await call(who, 'POST', '/v1/upstream-changes', { eventId: 'e-2', kind: 'permission_withdrawn', refs: ['E11:permission:p1'], reason: 'x' })).json.affected, []);
        assert.equal((await call(who, 'POST', '/v1/reservations', { ...rq, amount: 1, idempotencyKey: 'r1' })).status, 402, 'another scope has no budget here, and the same idempotency key is not shared');
      }
      assert.ok((await call(outsider, 'GET', '/v1/events')).json.every((e: any) => e.tenantId === 'org-b' && e.type === 'resources.budget_exhausted'), 'the other tenant sees only its own denial event');
      assert.ok((await call(otherProject, 'GET', '/v1/events')).json.every((e: any) => e.tenantId === 'org-a'), 'the event feed is tenant-wide for the router, never cross-tenant');
      assert.equal((await sql.query(`select 1 from e13_resources._jobs where tenant_id='org-b' and result is not null`)).length, 0);
    } finally { await server.close(); }
  });
});
