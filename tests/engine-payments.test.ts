// Payment tests use ONLY the built-in sandbox simulator and a local fake HTTP server standing in for Stripe.
// No real processor is contacted and no real charge or obligation can be created.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { createHttpHandler, serve } from '../src/service-kit.ts';
import type { Sql } from '../src/service-kit.ts';
import { PaymentOutcomeUnknown, SandboxProcessor, SandboxProvider, StripeProvider, createEngine, sandboxHttpApi, sandboxProcessorRoutes, signPayload, stripeFromEnv, verifySignature } from '../src/engine/index.ts';
import type { PaymentProvider, ResourcesEngine } from '../src/engine/index.ts';
import { code, ctx, needsPg, sleep, withEngine, settled, track } from './engine-helpers.ts';

const alice = ctx({ actorId: 'alice' }), bob = ctx({ actorId: 'bob' });
const SECRET = 'sandbox-webhook-secret-for-tests';
function sandbox(sql: Sql, extra: Record<string, PaymentProvider> = {}, config = {}): { engine: ResourcesEngine; processor: SandboxProcessor } {
  const processor = new SandboxProcessor({ sql, schema: 'e13_resources', webhookSecret: SECRET });
  const engine = createEngine({ sql, ports: { payments: { sandbox: new SandboxProvider(processor, SECRET), ...extra } }, config: { reconcileAfterSeconds: 0, ...config } });
  processor.setSink(async (raw, headers) => { try { await engine.handleProviderWebhook('sandbox', raw, headers); return 200; } catch { return 400; } });
  return { engine: track(engine, sql), processor };
}
async function invoice(engine: ResourcesEngine, key: string, total = 50_000): Promise<string> {
  const d = await engine.createInvoice(alice, { customer: { name: 'Example Customer' }, currency: 'EUR', idempotencyKey: key, lines: [{ description: 'License', quantity: 1, unitPriceMinor: total, workRef: 'E09:work:film' }] });
  await engine.issueInvoice(bob, d.id as string);
  return d.id as string;
}
const counts = async (sql: Sql) => {
  const one = async (q: string) => Number((await sql.query<{ n: string }>(q))[0]!.n);
  return { payments: await one(`select count(*) n from e13_resources.payments`), paymentEntries: await one(`select count(*) n from e13_resources.journal_entries where source_kind='payment'`), revenue: await one(`select count(*) n from e13_resources.revenue_records`), sandboxPayments: await one(`select count(*) n from e13_resources.sandbox_payments`) };
};

test('sandbox: happy path, duplicate webhook, replayed invoice webhook creates no duplicate payment or income', needsPg, async () => {
  await withEngine(async (_e, sql) => {
    const { engine, processor } = sandbox(sql);
    const inv = await invoice(engine, 'i1');
    await assert.rejects(engine.createPayment(ctx({ capabilities: ['resources:*'] }), { invoiceId: inv, provider: 'sandbox', idempotencyKey: 'p1' }), code('forbidden'));
    await assert.rejects(engine.createPayment(alice, { invoiceId: inv, provider: 'nope', idempotencyKey: 'p1' }), code('provider_unavailable'));
    const pay = await engine.createPayment(alice, { invoiceId: inv, provider: 'sandbox', idempotencyKey: 'p1' });
    assert.equal(pay.state, 'succeeded'); assert.equal(pay.mode, 'sandbox'); assert.match(pay.providerRef!, /^sbx_pay_/); assert.equal(pay.amountMinor, 50_000);
    assert.equal((await engine.createPayment(alice, { invoiceId: inv, provider: 'sandbox', idempotencyKey: 'p1' })).id, pay.id, 'replay returns the same payment');
    await assert.rejects(engine.createPayment(alice, { invoiceId: inv, provider: 'sandbox', idempotencyKey: 'p2' }), code('invalid_state'));
    assert.equal((await engine.getInvoice(alice, inv)).state, 'paid');
    const before = await counts(sql);
    assert.deepEqual(before, { payments: 1, paymentEntries: 1, revenue: 1, sandboxPayments: 1 });
    // the provider now delivers its webhook, then delivers it again, then twice concurrently
    const [evt] = await processor.events(pay.providerRef!);
    assert.equal(await processor.deliver(evt!.id), 200);
    const d = await processor.signedDelivery(evt!.id);
    assert.equal((await engine.handleProviderWebhook('sandbox', d.raw, d.headers)).handling, 'duplicate');
    await Promise.all([processor.deliver(evt!.id), processor.deliver(evt!.id), processor.deliver(evt!.id)]);
    assert.deepEqual(await counts(sql), before);
    assert.equal((await engine.listRevenue(alice))[0]!.state, 'reconciled');
    const ev = (await settled(engine, alice)).map((e) => e.type);
    assert.equal(ev.filter((t) => t === 'resources.payment_succeeded').length, 1); assert.equal(ev.filter((t) => t === 'resources.revenue_reconciled').length, 1); assert.equal(ev.filter((t) => t === 'resources.invoice_paid').length, 1);
    const tb = await engine.trialBalance(alice); const bal = (c: string) => tb.accounts.find((a) => a.code === c)!.balance;
    assert.deepEqual([bal('1100'), bal('1200'), bal('4000')], [0, 50_000, -50_000]); assert.ok(tb.balanced);
    await assert.rejects(engine.voidInvoice(bob, inv, 'too late'), code('invalid_state'));
    // tenant isolation
    await assert.rejects(engine.getPayment(ctx({ tenantId: 'org-b' }), pay.id), code('not_found'));
    assert.equal((await engine.listPayments(ctx({ projectId: 'proj-2' }))).length, 0);
  });
});

test('sandbox: bad signature, replayed old timestamp, tampered body, unknown payment', needsPg, async () => {
  await withEngine(async (_e, sql) => {
    const { engine, processor } = sandbox(sql);
    const inv = await invoice(engine, 'i1');
    const pay = await engine.createPayment(alice, { invoiceId: inv, provider: 'sandbox', method: 'sandbox_delay', idempotencyKey: 'p1' });
    assert.equal(pay.state, 'processing');
    await processor.advance(pay.providerRef!, 'succeeded');
    const succeeded = (await processor.events(pay.providerRef!)).find((e) => e.type === 'payment.succeeded')!;
    const good = await processor.signedDelivery(succeeded.id);
    const sig = code('invalid_signature');
    await assert.rejects(engine.handleProviderWebhook('sandbox', good.raw, { ...good.headers, 'sandbox-signature': signPayload('some-other-secret-0000', good.raw, Math.floor(Date.now() / 1000)) }), sig);
    await assert.rejects(engine.handleProviderWebhook('sandbox', good.raw, {}), sig);
    await assert.rejects(engine.handleProviderWebhook('sandbox', good.raw, { 'sandbox-signature': 'garbage' }), sig);
    const tampered = Buffer.from(Buffer.from(good.raw).toString('utf8').replace('"amount":50000', '"amount":1'));
    await assert.rejects(engine.handleProviderWebhook('sandbox', tampered, good.headers), sig);
    // a correctly signed delivery captured earlier and replayed outside the tolerance window
    const old = await processor.signedDelivery(succeeded.id, Math.floor(Date.now() / 1000) - 301);
    await assert.rejects(engine.handleProviderWebhook('sandbox', old.raw, old.headers), sig);
    await assert.rejects(engine.handleProviderWebhook('sandbox', good.raw, good.headers, new Date(Date.now() + 10 * 60_000)), sig);
    assert.equal((await engine.getPayment(alice, pay.id)).state, 'processing', 'nothing was applied by any rejected delivery');
    assert.equal((await sql.query(`select 1 from e13_resources.provider_events`)).length, 0);
    assert.equal((await engine.handleProviderWebhook('sandbox', good.raw, good.headers)).handling, 'applied');
    assert.equal((await engine.getPayment(alice, pay.id)).state, 'succeeded');
    // an event for a payment this engine never created is recorded and ignored
    const stray = await processor.create({ paymentId: 'not-ours', amountMinor: 5, currency: 'EUR', description: 'stray', idempotencyKey: 'stray-1', metadata: {} });
    const strayEvt = (await processor.events(stray.id))[0]!; const sd = await processor.signedDelivery(strayEvt.id);
    assert.equal((await engine.handleProviderWebhook('sandbox', sd.raw, sd.headers)).handling, 'ignored_unknown_payment');
    assert.equal((await counts(sql)).payments, 1);
  });
});

test('sandbox: decline, out-of-order webhooks never regress a payment', needsPg, async () => {
  await withEngine(async (_e, sql) => {
    const { engine, processor } = sandbox(sql);
    const inv = await invoice(engine, 'i1');
    const declined = await engine.createPayment(alice, { invoiceId: inv, provider: 'sandbox', method: 'sandbox_decline:insufficient_funds', idempotencyKey: 'p1' });
    assert.equal(declined.state, 'failed'); assert.equal(declined.failureCode, 'insufficient_funds');
    assert.equal((await engine.getInvoice(alice, inv)).state, 'issued'); assert.equal((await counts(sql)).paymentEntries, 0);
    assert.ok((await settled(engine, alice)).some((e) => e.type === 'resources.payment_failed'));
    // a new attempt: processing → succeeded at the provider, but the webhooks arrive succeeded first, processing second
    const pay = await engine.createPayment(alice, { invoiceId: inv, provider: 'sandbox', method: 'sandbox_delay', idempotencyKey: 'p2' });
    await sleep(1100); // provider timestamps have one-second resolution
    await processor.advance(pay.providerRef!, 'succeeded');
    const evts = await processor.events(pay.providerRef!);
    const processing = evts.find((e) => e.type === 'payment.processing')!, succeeded = evts.find((e) => e.type === 'payment.succeeded')!;
    assert.equal(await processor.deliver(succeeded.id), 200);
    assert.equal((await engine.getPayment(alice, pay.id)).state, 'succeeded');
    const late = await processor.signedDelivery(processing.id);
    assert.equal((await engine.handleProviderWebhook('sandbox', late.raw, late.headers)).handling, 'no_change');
    assert.equal((await engine.getPayment(alice, pay.id)).state, 'succeeded'); assert.equal((await engine.getInvoice(alice, inv)).state, 'paid');
    assert.equal((await counts(sql)).paymentEntries, 1);
    // failed (newer) then processing (older) on another invoice: the older event is stale
    const inv2 = await invoice(engine, 'i2');
    const p3 = await engine.createPayment(alice, { invoiceId: inv2, provider: 'sandbox', method: 'sandbox_delay', idempotencyKey: 'p3' });
    await sleep(1100);
    await processor.advance(p3.providerRef!, 'failed', 'bank_declined');
    const e3 = await processor.events(p3.providerRef!);
    await processor.deliver(e3.find((e) => e.type === 'payment.failed')!.id);
    const stale = await processor.signedDelivery(e3.find((e) => e.type === 'payment.processing')!.id);
    assert.equal((await engine.handleProviderWebhook('sandbox', stale.raw, stale.headers)).handling, 'ignored_stale');
    const after = await engine.getPayment(alice, p3.id);
    assert.equal(after.state, 'failed'); assert.equal(after.failureCode, 'bank_declined');
  });
});

test('sandbox: uncertain outcomes are reconciled with the provider and never charged twice', needsPg, async () => {
  await withEngine(async (_e, sql) => {
    const { engine, processor } = sandbox(sql);
    const inv = await invoice(engine, 'i1');
    // the processor took the payment but the response was lost
    const lost = await engine.createPayment(alice, { invoiceId: inv, provider: 'sandbox', method: 'sandbox_lost_response', idempotencyKey: 'p1' });
    assert.equal(lost.state, 'uncertain'); assert.equal(lost.providerRef, null);
    assert.equal((await engine.listIncidents(alice, { kind: 'payment_uncertain', open: true })).length, 1);
    assert.equal((await engine.createPayment(alice, { invoiceId: inv, provider: 'sandbox', method: 'sandbox_lost_response', idempotencyKey: 'p1' })).state, 'uncertain', 'a client retry does not call the provider again');
    await assert.rejects(engine.createPayment(alice, { invoiceId: inv, provider: 'sandbox', idempotencyKey: 'p1b' }), code('invalid_state'));
    assert.equal((await counts(sql)).sandboxPayments, 1);
    assert.equal(await engine.runJobs(), 1, 'the reconciliation job runs');
    const fixed = await engine.getPayment(alice, lost.id);
    assert.equal(fixed.state, 'succeeded'); assert.match(fixed.providerRef!, /^sbx_pay_/);
    assert.deepEqual(await counts(sql), { payments: 1, paymentEntries: 1, revenue: 1, sandboxPayments: 1 });
    assert.equal((await engine.listIncidents(alice, { kind: 'payment_uncertain', open: true })).length, 0);
    await processor.deliverPending(); // the webhook for the same success arrives afterwards
    assert.equal((await counts(sql)).paymentEntries, 1); assert.equal((await engine.getInvoice(alice, inv)).paidMinor, 50_000);
    // the request never reached the processor: reconciliation proves there is no charge and closes the attempt
    const inv2 = await invoice(engine, 'i2');
    const never = await engine.createPayment(alice, { invoiceId: inv2, provider: 'sandbox', method: 'sandbox_never_arrives', idempotencyKey: 'p2' });
    assert.equal(never.state, 'uncertain');
    const summary = await engine.reconcilePayments(alice);
    assert.deepEqual([summary.checked, summary.resolved], [1, 1]);
    const closed = await engine.getPayment(alice, never.id);
    assert.equal(closed.state, 'failed'); assert.equal(closed.failureCode, 'provider_has_no_record');
    assert.equal((await engine.createPayment(alice, { invoiceId: inv2, provider: 'sandbox', idempotencyKey: 'p3' })).state, 'succeeded', 'a deliberate new attempt is possible once the old one is closed');
    // a processing payment stays open until the provider settles it; the job keeps retrying
    const inv3 = await invoice(engine, 'i3');
    const slow = await engine.createPayment(alice, { invoiceId: inv3, provider: 'sandbox', method: 'sandbox_delay', idempotencyKey: 'p4' });
    assert.deepEqual((await engine.reconcilePayments(alice)).stillOpen, [slow.id]);
    await processor.advance(slow.providerRef!, 'succeeded');
    assert.equal((await engine.reconcilePayment(alice, slow.id)).state, 'succeeded');
  });
});

test('sandbox processor over HTTP: idempotency key, API key, lost response', needsPg, async () => {
  await withEngine(async (_e, sql) => {
    const processor = new SandboxProcessor({ sql, schema: 'e13_resources', webhookSecret: SECRET });
    const server = await serve(createHttpHandler({ name: 'sandbox-processor', version: '1', routes: sandboxProcessorRoutes(processor), verify: async () => { throw new Error('no bearer routes'); } }), 0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const engine = createEngine({ sql, ports: { payments: { sandbox: new SandboxProvider(sandboxHttpApi(base, processor.apiKey), SECRET) } }, config: { reconcileAfterSeconds: 0 } });
      const inv = await invoice(engine, 'i1');
      assert.equal((await engine.createPayment(alice, { invoiceId: inv, provider: 'sandbox', amountMinor: 20_000, idempotencyKey: 'h1' })).state, 'succeeded');
      assert.equal((await engine.getInvoice(alice, inv)).state, 'issued', 'partially paid');
      const lost = await engine.createPayment(alice, { invoiceId: inv, provider: 'sandbox', method: 'sandbox_lost_response', idempotencyKey: 'h2' });
      assert.equal(lost.state, 'uncertain');
      assert.equal((await engine.reconcilePayment(alice, lost.id)).state, 'succeeded');
      assert.equal((await engine.getInvoice(alice, inv)).state, 'paid');
      const api = sandboxHttpApi(base, processor.apiKey);
      const q = { paymentId: 'x', amountMinor: 700, currency: 'EUR', description: 'd', idempotencyKey: 'same-key', metadata: {} };
      const a = await api.create(q), b = await api.create(q);
      assert.equal(a.id, b.id, 'same Idempotency-Key, same sandbox payment'); assert.equal(a.sandbox, true);
      await assert.rejects(api.create({ ...q, amountMinor: 701 }), code('idempotency_conflict'));
      await assert.rejects(sandboxHttpApi(base, 'wrong-key').create({ ...q, idempotencyKey: 'k2' }), code('unauthenticated'));
      assert.equal(await api.get('sbx_pay_missing'), null);
      await assert.rejects(sandboxHttpApi('http://127.0.0.1:1', 'k').create(q), (e: unknown) => e instanceof PaymentOutcomeUnknown);
    } finally { server.close(); }
  });
});

// ───────────── Stripe adapter against a local fake HTTP server (a TEST DOUBLE, not Stripe) ─────────────
type Seen = { method: string; url: string; headers: IncomingMessage['headers']; form: URLSearchParams };
async function fakeStripe(respond: (seen: Seen, n: number) => { status: number; body: unknown } | 'hang') {
  const seen: Seen[] = [];
  const server = createServer((req, res) => { const chunks: Buffer[] = []; req.on('data', (c: Buffer) => chunks.push(c)); req.on('end', () => {
    const s = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, form: new URLSearchParams(Buffer.concat(chunks).toString()) }; seen.push(s);
    const r = respond(s, seen.length); if (r === 'hang') return;
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body));
  }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { seen, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => { server.closeAllConnections(); server.close(); } };
}
const KEY = 'sk_test_FAKEFAKEFAKEFAKE1234';
const req = { paymentId: '7b0c9a5e-1111-4222-8333-444455556666', amountMinor: 12_345, currency: 'EUR', description: 'Invoice payment', idempotencyKey: 'e13-7b0c9a5e', metadata: { tenant_id: 'org-a', invoice_id: 'inv-1' } };

test('Stripe adapter (local test double): request shaping, Idempotency-Key, error mapping', async () => {
  const fake = await fakeStripe((s, n) => {
    if (s.url === '/v1/payment_intents' && s.form.get('amount') === '402') return { status: 402, body: { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', payment_intent: { id: 'pi_declined1' } } } };
    if (s.url === '/v1/payment_intents' && s.form.get('amount') === '500') return { status: 500, body: { error: { type: 'api_error' } } };
    if (s.url === '/v1/payment_intents' && s.form.get('amount') === '400') return { status: 400, body: { error: { type: 'invalid_request_error', code: 'parameter_invalid', message: `echo ${String(s.headers.authorization)}` } } };
    if (s.url === '/v1/payment_intents' && s.form.get('amount') === '401') return { status: 401, body: { error: { type: 'invalid_request_error' } } };
    if (s.url === '/v1/payment_intents' && s.form.get('amount') === '999') return 'hang';
    if (s.url === '/v1/payment_intents') return { status: 200, body: { id: 'pi_fake123', object: 'payment_intent', status: s.form.get('confirm') === 'true' ? 'succeeded' : 'requires_payment_method', client_secret: 'pi_fake123_secret_x' } };
    if (s.url === '/v1/payment_intents/pi_fake123') return { status: 200, body: { id: 'pi_fake123', status: 'processing' } };
    if (s.url === '/v1/payment_intents/pi_gone') return { status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing' } } };
    if (s.url === '/v1/checkout/sessions') return { status: 200, body: { id: 'cs_test_fake1', object: 'checkout.session', status: 'open', payment_status: 'unpaid', url: 'https://checkout.example.org/c/pay/cs_test_fake1' } };
    if (s.url === '/v1/checkout/sessions/cs_test_fake1') return { status: 200, body: { id: 'cs_test_fake1', status: 'complete', payment_status: 'paid' } };
    return { status: 404, body: { n } };
  });
  try {
    const stripe = new StripeProvider({ secretKey: KEY, apiBase: fake.base, timeoutMs: 400, apiVersion: '2024-06-20' });
    assert.equal(stripe.mode, 'test');
    const created = await stripe.createPayment(req);
    assert.deepEqual(created, { providerRef: 'pi_fake123', status: 'requires_action', clientSecret: 'pi_fake123_secret_x' });
    const s = fake.seen[0]!;
    assert.equal(s.method, 'POST'); assert.equal(s.headers.authorization, `Bearer ${KEY}`); assert.equal(s.headers['idempotency-key'], 'e13-7b0c9a5e');
    assert.equal(s.headers['content-type'], 'application/x-www-form-urlencoded'); assert.equal(s.headers['stripe-version'], '2024-06-20');
    assert.deepEqual(Object.fromEntries(s.form), { amount: '12345', currency: 'eur', description: 'Invoice payment', 'automatic_payment_methods[enabled]': 'true', 'metadata[tenant_id]': 'org-a', 'metadata[invoice_id]': 'inv-1', 'metadata[payment_id]': req.paymentId });
    assert.equal((await stripe.createPayment({ ...req, method: 'pm_card_visa' })).status, 'succeeded');
    assert.equal(fake.seen[1]!.form.get('payment_method'), 'pm_card_visa'); assert.equal(fake.seen[1]!.form.get('confirm'), 'true');
    // recover = the same call with the same key (the provider de-duplicates); never a fresh key
    await stripe.recover(req);
    assert.equal(fake.seen[2]!.headers['idempotency-key'], 'e13-7b0c9a5e');
    assert.deepEqual(await stripe.createPayment({ ...req, amountMinor: 402 }), { providerRef: 'pi_declined1', status: 'failed', failureCode: 'insufficient_funds' });
    const unknown = (e: unknown) => e instanceof PaymentOutcomeUnknown;
    await assert.rejects(stripe.createPayment({ ...req, amountMinor: 500 }), unknown);
    await assert.rejects(stripe.createPayment({ ...req, amountMinor: 999 }), unknown, 'timeout → outcome unknown');
    await assert.rejects(stripe.createPayment({ ...req, amountMinor: 400 }), (e: unknown) => { code('invalid_provider_request')(e); assert.doesNotMatch((e as Error).message, /sk_test|Bearer/, 'secrets never reach error text'); return true; });
    await assert.rejects(stripe.createPayment({ ...req, amountMinor: 401 }), code('provider_unavailable'));
    await assert.rejects(stripe.createPayment({ ...req, idempotencyKey: '' }), code('invalid_input'));
    assert.deepEqual(await stripe.fetchPayment('pi_fake123'), { providerRef: 'pi_fake123', status: 'processing' });
    assert.equal(fake.seen.at(-1)!.method, 'GET'); assert.equal(fake.seen.at(-1)!.headers['idempotency-key'], undefined);
    assert.equal(await stripe.fetchPayment('pi_gone'), null);
    await assert.rejects(stripe.fetchPayment('../v1/customers'), code('invalid_input'));
    const checkout = new StripeProvider({ secretKey: KEY, apiBase: fake.base, flow: 'checkout', successUrl: 'https://pay.example.org/done' });
    const session = await checkout.createPayment(req);
    assert.deepEqual(session, { providerRef: 'cs_test_fake1', status: 'requires_action', checkoutUrl: 'https://checkout.example.org/c/pay/cs_test_fake1' });
    const f = fake.seen.at(-1)!.form;
    assert.deepEqual([f.get('mode'), f.get('client_reference_id'), f.get('line_items[0][price_data][unit_amount]'), f.get('line_items[0][price_data][currency]'), f.get('payment_intent_data[metadata][payment_id]'), f.get('success_url')], ['payment', req.paymentId, '12345', 'eur', req.paymentId, 'https://pay.example.org/done']);
    assert.equal(fake.seen.at(-1)!.headers['idempotency-key'], 'e13-7b0c9a5e');
    assert.equal((await checkout.fetchPayment('cs_test_fake1'))!.status, 'succeeded');
  } finally { fake.close(); }
});

test('Stripe adapter: webhook signature scheme, timestamp tolerance, event mapping; live keys refused', () => {
  const whsec = 'whsec_test_double_secret_000000';
  const stripe = new StripeProvider({ secretKey: KEY, webhookSecret: whsec });
  const now = new Date('2030-05-05T12:00:00Z'), t = Math.floor(now.getTime() / 1000);
  const body = (type: string, object: object, extra: object = {}) => Buffer.from(JSON.stringify({ id: 'evt_1', object: 'event', type, created: t - 5, livemode: false, data: { object }, ...extra }));
  const ok = body('payment_intent.succeeded', { id: 'pi_1', status: 'succeeded', metadata: { payment_id: 'pay-1' } });
  const sign = (raw: Uint8Array, at = t, secret = whsec) => ({ 'stripe-signature': signPayload(secret, raw, at) });
  assert.deepEqual(stripe.verifyWebhook(ok, sign(ok), now, 300), { id: 'evt_1', type: 'payment_intent.succeeded', createdAt: new Date((t - 5) * 1000).toISOString(), providerRef: 'pi_1', paymentId: 'pay-1', status: 'succeeded' });
  // Stripe's documented scheme: v1 = HMAC-SHA256(secret, "<t>.<payload>"), several v1 values and a v0 may be present
  assert.match(sign(ok)['stripe-signature'], /^t=\d+,v1=[0-9a-f]{64}$/);
  const rotated = `t=${t},v1=${'0'.repeat(64)},${sign(ok)['stripe-signature'].split(',')[1]},v0=ignored`;
  assert.equal(stripe.verifyWebhook(ok, { 'Stripe-Signature': rotated }, now, 300).id, 'evt_1');
  const sig = code('invalid_signature');
  assert.throws(() => stripe.verifyWebhook(ok, sign(ok, t, 'whsec_wrong_secret_0000000000'), now, 300), sig);
  assert.throws(() => stripe.verifyWebhook(ok, sign(ok, t - 301), now, 300), sig, 'replayed old timestamp');
  assert.throws(() => stripe.verifyWebhook(ok, sign(ok, t + 301), now, 300), sig);
  assert.throws(() => stripe.verifyWebhook(Buffer.from(ok.toString().replace('pi_1', 'pi_2')), sign(ok), now, 300), sig);
  assert.throws(() => stripe.verifyWebhook(ok, {}, now, 300), sig);
  assert.throws(() => verifySignature(`t=${t}`, ok, whsec, now, 300), sig);
  const failed = body('payment_intent.payment_failed', { id: 'pi_1', last_payment_error: { code: 'card_declined', decline_code: 'lost_card' }, metadata: { payment_id: 'pay-1' } });
  assert.deepEqual([stripe.verifyWebhook(failed, sign(failed), now, 300).status, stripe.verifyWebhook(failed, sign(failed), now, 300).failureCode], ['failed', 'lost_card']);
  const session = body('checkout.session.completed', { id: 'cs_1', payment_status: 'paid', client_reference_id: 'pay-2' });
  assert.deepEqual([stripe.verifyWebhook(session, sign(session), now, 300).status, stripe.verifyWebhook(session, sign(session), now, 300).paymentId], ['succeeded', 'pay-2']);
  const other = body('customer.created', { id: 'cus_1' });
  assert.equal(stripe.verifyWebhook(other, sign(other), now, 300).status, null);
  const live = body('payment_intent.succeeded', { id: 'pi_1' }, { livemode: true });
  assert.throws(() => stripe.verifyWebhook(live, sign(live), now, 300), code('invalid_input'), 'a live event is not accepted by a test-mode adapter');
  assert.throws(() => new StripeProvider({ secretKey: KEY }).verifyWebhook(ok, sign(ok), now, 300), code('provider_unavailable'));
  // live keys
  const LIVE = 'sk_live_FAKEFAKEFAKEFAKE1234';
  assert.throws(() => new StripeProvider({ secretKey: LIVE }), code('forbidden'));
  assert.throws(() => new StripeProvider({ secretKey: 'rk_live_FAKEFAKEFAKEFAKE1234', allowLivePayments: false }), code('forbidden'));
  assert.throws(() => new StripeProvider({ secretKey: LIVE, allowLivePayments: true, apiBase: 'http://127.0.0.1:9' }), code('invalid_config'));
  assert.throws(() => new StripeProvider({ secretKey: KEY, apiBase: 'http://example.org' }), code('invalid_config'));
  assert.throws(() => new StripeProvider({ secretKey: 'not-a-key' }), code('invalid_config'));
  assert.throws(() => stripeFromEnv({ STRIPE_SECRET_KEY: LIVE }), code('forbidden'));
  assert.equal(new StripeProvider({ secretKey: LIVE, allowLivePayments: true }).mode, 'live');
});

test('engine: missing Stripe credentials are an explicit unavailable state; live mode needs config AND a human grant', needsPg, async () => {
  await withEngine(async (_e, sql) => {
    const { engine } = sandbox(sql, { stripe: stripeFromEnv({}) });
    const inv = await invoice(engine, 'i1');
    const p = await engine.createPayment(alice, { invoiceId: inv, provider: 'stripe', idempotencyKey: 's1' });
    assert.equal(p.state, 'failed'); assert.equal(p.failureCode, 'provider_unavailable');
    await assert.rejects(engine.handleProviderWebhook('stripe', new Uint8Array(), {}), code('provider_unavailable'));
    // a live-mode provider that would throw if it were ever called
    let called = 0;
    const liveDouble: PaymentProvider = { name: 'stripe', mode: 'live', createPayment: async () => { called++; throw new Error('must never be called'); }, fetchPayment: async () => null, recover: async () => null, verifyWebhook: () => { throw new Error('unused'); } };
    const noConfig = sandbox(sql, { stripe: liveDouble }).engine;
    await assert.rejects(noConfig.createPayment(alice, { invoiceId: inv, provider: 'stripe', idempotencyKey: 's2' }), code('grant_invalid'));
    const withConfig = sandbox(sql, { stripe: liveDouble }, { allowLivePayments: true }).engine;
    await assert.rejects(withConfig.createPayment(alice, { invoiceId: inv, provider: 'stripe', idempotencyKey: 's3' }), code('grant_invalid'), 'configuration alone is not enough');
    await assert.rejects(withConfig.grantLivePayments(ctx({ actorId: 'agent-1', kind: 'agent' }), { provider: 'stripe', currency: 'EUR', maxAmountMinor: 100_000, expiresAt: new Date(Date.now() + 3600_000).toISOString(), reason: 'x' }), code('forbidden'));
    await assert.rejects(withConfig.grantLivePayments(ctx({ capabilities: ['resources:*'] }), { provider: 'stripe', currency: 'EUR', maxAmountMinor: 100_000, expiresAt: new Date(Date.now() + 3600_000).toISOString(), reason: 'x' }), code('forbidden'));
    const small = await withConfig.grantLivePayments(bob, { provider: 'stripe', currency: 'EUR', maxAmountMinor: 10, expiresAt: new Date(Date.now() + 3600_000).toISOString(), reason: 'too small for this invoice' });
    await assert.rejects(withConfig.createPayment(alice, { invoiceId: inv, provider: 'stripe', idempotencyKey: 's4' }), code('grant_invalid'));
    await withConfig.revokeLivePayments(bob, small.id);
    await assert.rejects(noConfig.createPayment(alice, { invoiceId: inv, provider: 'stripe', idempotencyKey: 's5' }), code('grant_invalid'));
    assert.equal(called, 0, 'the live provider was never contacted');
    assert.equal((await engine.listPayments(alice)).filter((x) => x.mode === 'live').length, 0);
  });
});
