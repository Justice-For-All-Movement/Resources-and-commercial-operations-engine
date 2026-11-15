// Payment provider adapters: the adapter interface, webhook signatures, the built-in SANDBOX processor and the Stripe adapter.
// This module moves no money by itself. The sandbox is a simulator; Stripe is refused for live keys unless explicitly allowed.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError, invariant } from '../contracts.ts';
import type { Route, Sql } from '../service-kit.ts';

export type ProviderStatus = 'processing' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
export type ProviderPayment = Readonly<{ providerRef: string; status: ProviderStatus; failureCode?: string; checkoutUrl?: string; clientSecret?: string }>;
export type ProviderEvent = Readonly<{ id: string; type: string; createdAt: string; providerRef: string; paymentId: string | null; status: ProviderStatus | null; failureCode?: string }>;
export type CreatePaymentRequest = Readonly<{ paymentId: string; amountMinor: number; currency: string; description: string; idempotencyKey: string; method?: string; metadata: Readonly<Record<string, string>>; returnUrl?: string }>;
export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;
/**
 * A payment processor. Implementations send `idempotencyKey` to the provider on every mutating call so a retry can never
 * create a second charge, and throw `PaymentOutcomeUnknown` when a request may or may not have been processed.
 */
export interface PaymentProvider {
  readonly name: string;
  /** `sandbox` = built-in simulator, `test` = a real provider's test mode, `live` = real money. */
  readonly mode: 'sandbox' | 'test' | 'live';
  createPayment(request: CreatePaymentRequest): Promise<ProviderPayment>;
  /** Current provider state by provider reference; null when the provider has no such payment. */
  fetchPayment(providerRef: string): Promise<ProviderPayment | null>;
  /** Recovers the provider's record for an attempt whose outcome is unknown without ever creating a second charge. Null = the provider has no record. */
  recover(request: CreatePaymentRequest): Promise<ProviderPayment | null>;
  /** Verifies signature and timestamp tolerance, then parses. Throws DomainError('invalid_signature'). */
  verifyWebhook(raw: Uint8Array, headers: WebhookHeaders, now: Date, toleranceSeconds: number): ProviderEvent;
}
export class PaymentOutcomeUnknown extends Error {
  constructor(message: string) { super(message); this.name = 'PaymentOutcomeUnknown'; }
}
/** A provider that is configured but cannot be used; every call reports exactly what is missing. */
export function unavailableProvider(name: string, reason: string): PaymentProvider {
  const fail = (): never => { throw new DomainError('provider_unavailable', `Payment provider ${name} is unavailable: ${reason}`); };
  return { name, mode: 'test', createPayment: async () => fail(), fetchPayment: async () => fail(), recover: async () => fail(), verifyWebhook: () => fail() };
}

// ───────────── Webhook signatures (`t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<payload>">`) ─────────────
export function signPayload(secret: string, payload: Uint8Array | string, timestamp: number): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}
/** Constant-time verification with a timestamp tolerance: an old signed delivery replayed later is rejected. */
export function verifySignature(header: string | string[] | undefined, raw: Uint8Array, secret: string, now: Date, toleranceSeconds: number): number {
  const deny = (why: string): never => { throw new DomainError('invalid_signature', `Webhook rejected: ${why}`); };
  if (typeof header !== 'string' || header.length > 2000) return deny('signature header missing');
  let t = NaN; const candidates: string[] = [];
  for (const part of header.split(',')) { const i = part.indexOf('='); if (i < 0) continue; const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim(); if (k === 't') t = Number(v); else if (k === 'v1') candidates.push(v); }
  if (!Number.isSafeInteger(t) || candidates.length === 0) return deny('malformed signature header');
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex'));
  if (!candidates.some((c) => { const b = Buffer.from(c); return b.length === expected.length && timingSafeEqual(b, expected); })) return deny('signature mismatch');
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > toleranceSeconds) return deny('timestamp outside tolerance');
  return t;
}
const header = (h: WebhookHeaders, name: string): string | undefined => { const k = Object.keys(h).find((x) => x.toLowerCase() === name); const v = k === undefined ? undefined : h[k]; return Array.isArray(v) ? v[0] : v; };

// ───────────── Sandbox processor (simulator with its own persisted state) ─────────────
export type SandboxPayment = Readonly<{ id: string; status: ProviderStatus; amountMinor: number; currency: string; method: string; failureCode: string | null; metadata: Record<string, string>; sandbox: true }>;
export interface SandboxApi {
  create(request: CreatePaymentRequest): Promise<SandboxPayment>;
  get(id: string): Promise<SandboxPayment | null>;
  findByKey(idempotencyKey: string): Promise<SandboxPayment | null>;
}
export type WebhookSink = (raw: Uint8Array, headers: Record<string, string>) => Promise<number>;
/**
 * SANDBOX ONLY. A simulated payment processor: persisted payments and events, idempotency keys, declines, delayed
 * settlement, dropped responses and signed webhooks that tests can deliver late, twice or out of order. No money exists here.
 * Methods: `sandbox_ok` (default), `sandbox_decline:<code>`, `sandbox_delay`, `sandbox_lost_response`, `sandbox_never_arrives`.
 */
export class SandboxProcessor implements SandboxApi {
  readonly #sql: Sql; readonly #s: string; readonly #account: string; readonly #secret: string; #sink: WebhookSink | undefined;
  readonly apiKey: string;
  constructor(o: { sql: Sql; schema: string; webhookSecret: string; apiKey?: string; account?: string; sink?: WebhookSink }) {
    invariant(/^[a-z][a-z0-9_]{0,48}$/.test(o.schema), 'invalid_config', 'Invalid schema'); invariant(o.webhookSecret.length >= 16, 'invalid_config', 'Sandbox webhook secret must be at least 16 characters');
    this.#sql = o.sql; this.#s = o.schema; this.#account = o.account ?? 'sandbox'; this.#secret = o.webhookSecret; this.#sink = o.sink; this.apiKey = o.apiKey ?? `sbx_key_${randomUUID()}`;
  }
  setSink(sink: WebhookSink): void { this.#sink = sink; }
  #row(r: Record<string, unknown>): SandboxPayment { return { id: r.id as string, status: r.status as ProviderStatus, amountMinor: Number(r.amount_minor), currency: r.currency as string, method: r.method as string, failureCode: (r.failure_code as string | null) ?? null, metadata: r.metadata as Record<string, string>, sandbox: true }; }
  async #event(tx: Sql, p: Record<string, unknown>, type: string): Promise<void> {
    const id = `sbx_evt_${randomUUID().replaceAll('-', '')}`; const created = new Date();
    const body = { id, type, created: Math.floor(created.getTime() / 1000), sandbox: true, data: { payment: { id: p.id, status: p.status, amount: Number(p.amount_minor), currency: p.currency, failure_code: p.failure_code ?? null, metadata: p.metadata } } };
    await tx.query(`insert into ${this.#s}.sandbox_events (id, account, tenant_id, project_id, payment_id, type, body, created_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [id, this.#account, p.tenant_id, p.project_id, p.id, type, JSON.stringify(body), created.toISOString()]);
  }
  async create(q: CreatePaymentRequest): Promise<SandboxPayment> {
    invariant(Number.isSafeInteger(q.amountMinor) && q.amountMinor > 0 && /^[A-Z]{3}$/.test(q.currency) && typeof q.idempotencyKey === 'string' && q.idempotencyKey.length > 0, 'invalid_input', 'Invalid sandbox payment request');
    const method = q.method ?? 'sandbox_ok';
    if (method === 'sandbox_never_arrives') throw new PaymentOutcomeUnknown('sandbox: request lost before reaching the processor');
    const out = await this.#sql.tx(async (tx) => {
      const id = `sbx_pay_${randomUUID().replaceAll('-', '')}`; const now = new Date().toISOString();
      const decline = /^sandbox_decline(?::([a-z_]{1,40}))?$/.exec(method);
      invariant(decline !== null || ['sandbox_ok', 'sandbox_delay', 'sandbox_lost_response'].includes(method), 'invalid_input', 'Unknown sandbox payment method');
      const status = decline !== null ? 'failed' : method === 'sandbox_delay' ? 'processing' : 'succeeded';
      const ins = await tx.query(`insert into ${this.#s}.sandbox_payments (id, account, tenant_id, project_id, idempotency_key, amount_minor, currency, method, status, failure_code, metadata, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$12)
        on conflict (account, idempotency_key) do nothing returning *`, [id, this.#account, q.metadata.tenant_id ?? '_none', q.metadata.project_id ?? '_none', q.idempotencyKey, q.amountMinor, q.currency, method, status, decline === null ? null : (decline[1] ?? 'card_declined'), JSON.stringify(q.metadata), now]);
      if (ins[0] === undefined) {
        // Same idempotency key: return the original payment, never a second one.
        const prior = (await tx.query(`select * from ${this.#s}.sandbox_payments where account=$1 and idempotency_key=$2`, [this.#account, q.idempotencyKey]))[0]!;
        invariant(Number(prior.amount_minor) === q.amountMinor && prior.currency === q.currency, 'idempotency_conflict', 'Idempotency key reused with different parameters');
        return { row: prior, fresh: false };
      }
      await this.#event(tx, ins[0], `payment.${status}`);
      return { row: ins[0], fresh: true };
    });
    if (method === 'sandbox_lost_response' && out.fresh) throw new PaymentOutcomeUnknown('sandbox: the processor accepted the payment but the response was lost');
    return this.#row(out.row);
  }
  async get(id: string): Promise<SandboxPayment | null> {
    const r = await this.#sql.query(`select * from ${this.#s}.sandbox_payments where account=$1 and id=$2`, [this.#account, id]);
    return r[0] === undefined ? null : this.#row(r[0]);
  }
  async findByKey(key: string): Promise<SandboxPayment | null> {
    const r = await this.#sql.query(`select * from ${this.#s}.sandbox_payments where account=$1 and idempotency_key=$2`, [this.#account, key]);
    return r[0] === undefined ? null : this.#row(r[0]);
  }
  /** Settles a delayed payment (simulating the bank answering later). */
  async advance(id: string, status: 'succeeded' | 'failed', failureCode = 'bank_declined'): Promise<void> {
    await this.#sql.tx(async (tx) => {
      const r = await tx.query(`update ${this.#s}.sandbox_payments set status=$3, failure_code=$4, updated_at=now() where account=$1 and id=$2 and status='processing' returning *`, [this.#account, id, status, status === 'failed' ? failureCode : null]);
      invariant(r[0] !== undefined, 'invalid_state', 'Sandbox payment is not processing');
      await this.#event(tx, r[0], `payment.${status}`);
    });
  }
  async events(paymentId?: string): Promise<{ id: string; type: string; deliveries: number; lastStatus: number | null }[]> {
    return (await this.#sql.query(`select id, type, deliveries, last_status from ${this.#s}.sandbox_events where account=$1 and ($2::text is null or payment_id=$2) order by seq`, [this.#account, paymentId ?? null]))
      .map((r) => ({ id: r.id as string, type: r.type as string, deliveries: r.deliveries as number, lastStatus: (r.last_status as number | null) ?? null }));
  }
  /** Builds the signed delivery for an event. `timestamp` lets a test replay an old signed delivery. */
  async signedDelivery(eventId: string, timestamp = Math.floor(Date.now() / 1000)): Promise<{ raw: Uint8Array; headers: Record<string, string> }> {
    const r = await this.#sql.query<{ body: unknown }>(`select body from ${this.#s}.sandbox_events where account=$1 and id=$2`, [this.#account, eventId]);
    invariant(r[0] !== undefined, 'not_found', 'Not found');
    const raw = new Uint8Array(Buffer.from(JSON.stringify(r[0].body)));
    return { raw, headers: { 'content-type': 'application/json', 'sandbox-signature': signPayload(this.#secret, raw, timestamp) } };
  }
  /** Delivers one event to the webhook sink (may be called repeatedly: duplicates are a normal provider behaviour). */
  async deliver(eventId: string): Promise<number> {
    invariant(this.#sink !== undefined, 'unavailable', 'Sandbox webhook sink is not configured');
    const { raw, headers } = await this.signedDelivery(eventId);
    let status = 0;
    try { status = await this.#sink(raw, headers); } finally { await this.#sql.query(`update ${this.#s}.sandbox_events set deliveries=deliveries+1, last_status=$3 where account=$1 and id=$2`, [this.#account, eventId, status]); }
    return status;
  }
  /** Delivers events not yet acknowledged with 2xx. Returns the number attempted. */
  async deliverPending(limit = 50): Promise<number> {
    const rows = await this.#sql.query<{ id: string }>(`select id from ${this.#s}.sandbox_events where account=$1 and (last_status is null or last_status not between 200 and 299) and deliveries < 20 order by seq limit ${Math.min(Math.max(limit, 1), 500)}`, [this.#account]);
    for (const r of rows) { try { await this.deliver(r.id); } catch { /* recorded as a failed delivery; retried on the next pass */ } }
    return rows.length;
  }
  verify(raw: Uint8Array, headers: WebhookHeaders, now: Date, tolerance: number): void { verifySignature(header(headers, 'sandbox-signature'), raw, this.#secret, now, tolerance); }
  get webhookSecret(): string { return this.#secret; }
}
/** HTTP surface of the sandbox processor (public kit routes authenticated by the sandbox API key). */
export function sandboxProcessorRoutes(p: SandboxProcessor): Route[] {
  const auth = (h: WebhookHeaders): void => {
    const a = Buffer.from(String(header(h, 'authorization') ?? '')), b = Buffer.from(`Bearer ${p.apiKey}`);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new DomainError('unauthenticated', 'Invalid sandbox API key');
  };
  const out = (x: SandboxPayment | null) => { if (x === null) throw new DomainError('not_found', 'Not found'); return { json: x }; };
  return [
    { method: 'POST', path: '/sandbox/v1/payments', public: true, handler: async (r) => { auth(r.headers); const b = (r.body ?? {}) as Record<string, unknown>; const key = header(r.headers, 'idempotency-key'); invariant(typeof key === 'string' && key.length > 0, 'invalid_input', 'Idempotency-Key header is required');
      return out(await p.create({ paymentId: String(b.paymentId ?? ''), amountMinor: b.amountMinor as number, currency: b.currency as string, description: String(b.description ?? ''), idempotencyKey: key, ...(typeof b.method === 'string' ? { method: b.method } : {}), metadata: (b.metadata ?? {}) as Record<string, string> })); } },
    { method: 'GET', path: '/sandbox/v1/payments/:id', public: true, handler: async (r) => { auth(r.headers); return out(await p.get(r.params.id ?? '')); } },
    { method: 'GET', path: '/sandbox/v1/payments', public: true, handler: async (r) => { auth(r.headers); return out(await p.findByKey(r.query.get('idempotency_key') ?? '')); } },
  ];
}
/** SandboxApi over HTTP, for running the simulator as a separate process. */
export function sandboxHttpApi(baseUrl: string, apiKey: string, timeoutMs = 10_000): SandboxApi {
  const call = async (method: string, path: string, body?: unknown, key?: string): Promise<SandboxPayment | null> => {
    let res: Response;
    try { res = await fetch(new URL(path, baseUrl), { method, signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key === undefined ? {} : { 'idempotency-key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw new PaymentOutcomeUnknown('sandbox: no response from the processor'); }
    if (res.status === 404) return null;
    if (res.status >= 500) throw new PaymentOutcomeUnknown(`sandbox: processor answered ${res.status}`);
    const parsed = await res.json() as SandboxPayment & { error?: { code?: string; message?: string } };
    if (!res.ok) throw new DomainError(parsed.error?.code ?? 'invalid_input', parsed.error?.message ?? `sandbox: HTTP ${res.status}`);
    return parsed;
  };
  return {
    create: async (q) => (await call('POST', '/sandbox/v1/payments', { paymentId: q.paymentId, amountMinor: q.amountMinor, currency: q.currency, description: q.description, method: q.method, metadata: q.metadata }, q.idempotencyKey)) as SandboxPayment,
    get: (id) => call('GET', `/sandbox/v1/payments/${encodeURIComponent(id)}`), findByKey: (key) => call('GET', `/sandbox/v1/payments?idempotency_key=${encodeURIComponent(key)}`),
  };
}
/** The built-in provider. `api` is the processor itself (in-process) or `sandboxHttpApi(...)`. */
export class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox'; readonly mode = 'sandbox' as const;
  readonly #api: SandboxApi; readonly #secret: string;
  constructor(api: SandboxApi, webhookSecret: string) { this.#api = api; this.#secret = webhookSecret; }
  #map(p: SandboxPayment): ProviderPayment { return { providerRef: p.id, status: p.status, ...(p.failureCode === null ? {} : { failureCode: p.failureCode }) }; }
  async createPayment(q: CreatePaymentRequest): Promise<ProviderPayment> { return this.#map(await this.#api.create(q)); }
  async fetchPayment(providerRef: string): Promise<ProviderPayment | null> { const p = await this.#api.get(providerRef); return p === null ? null : this.#map(p); }
  async recover(q: CreatePaymentRequest): Promise<ProviderPayment | null> { const p = await this.#api.findByKey(q.idempotencyKey); return p === null ? null : this.#map(p); }
  verifyWebhook(raw: Uint8Array, headers: WebhookHeaders, now: Date, tolerance: number): ProviderEvent {
    verifySignature(header(headers, 'sandbox-signature'), raw, this.#secret, now, tolerance);
    let e: { id?: unknown; type?: unknown; created?: unknown; data?: { payment?: { id?: unknown; status?: unknown; failure_code?: unknown; metadata?: Record<string, unknown> } } };
    try { e = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { throw new DomainError('invalid_input', 'Malformed webhook body'); }
    const p = e.data?.payment;
    invariant(typeof e.id === 'string' && typeof e.type === 'string' && typeof e.created === 'number' && p !== undefined && typeof p.id === 'string', 'invalid_input', 'Malformed sandbox event');
    const status = ['processing', 'succeeded', 'failed', 'canceled', 'requires_action'].includes(p.status as string) ? (p.status as ProviderStatus) : null;
    return { id: e.id, type: e.type, createdAt: new Date(e.created * 1000).toISOString(), providerRef: p.id, paymentId: typeof p.metadata?.payment_id === 'string' ? p.metadata.payment_id : null, status, ...(typeof p.failure_code === 'string' ? { failureCode: p.failure_code } : {}) };
  }
}

// ───────────── Stripe ─────────────
export type StripeOptions = Readonly<{
  /** From env STRIPE_SECRET_KEY. Never logged, never returned, never placed in errors. */
  secretKey: string;
  /** Endpoint signing secret (`whsec_…`) from env STRIPE_WEBHOOK_SECRET; required to accept webhooks. */
  webhookSecret?: string;
  /** Live keys (`sk_live_`/`rk_live_`) are refused unless this is true. The engine additionally requires a human grant per payment. */
  allowLivePayments?: boolean;
  flow?: 'payment_intent' | 'checkout';
  /** Only for a local test double; live keys are accepted solely for https://api.stripe.com. */
  apiBase?: string;
  apiVersion?: string; successUrl?: string; cancelUrl?: string; timeoutMs?: number;
}>;
const STRIPE = 'https://api.stripe.com';
const PI_STATUS: Readonly<Record<string, ProviderStatus>> = { succeeded: 'succeeded', processing: 'processing', canceled: 'canceled', requires_payment_method: 'requires_action', requires_confirmation: 'requires_action', requires_action: 'requires_action', requires_capture: 'requires_action' };
/**
 * Stripe adapter over HTTPS (PaymentIntents or Checkout Sessions). Every mutating call carries `Idempotency-Key`.
 * Implemented from Stripe's public API contract; NOT verified against Stripe here (no credentials in this environment).
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe'; readonly mode: 'test' | 'live';
  readonly #o: StripeOptions; readonly #base: string;
  constructor(o: StripeOptions) {
    const key = o.secretKey;
    invariant(typeof key === 'string' && /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(key), 'invalid_config', 'STRIPE_SECRET_KEY is not a Stripe secret or restricted key');
    this.mode = /^(sk|rk)_live_/.test(key) ? 'live' : 'test';
    const base = new URL(o.apiBase ?? STRIPE);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
    invariant(base.protocol === 'https:' || (base.protocol === 'http:' && loopback), 'invalid_config', 'Stripe API base must be HTTPS');
    if (this.mode === 'live') {
      if (o.allowLivePayments !== true) throw new DomainError('forbidden', 'Live Stripe keys are refused: set allowLivePayments explicitly and record a human grant before real money can move');
      invariant(base.origin === STRIPE, 'invalid_config', 'A live Stripe key may only be used with https://api.stripe.com');
    }
    this.#o = o; this.#base = base.origin;
  }
  async #request(method: 'GET' | 'POST', path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    if (method === 'POST') invariant(typeof idempotencyKey === 'string' && idempotencyKey.length > 0 && idempotencyKey.length <= 255, 'invalid_input', 'Idempotency-Key is required on every mutating Stripe call');
    let res: Response; let body: Record<string, unknown>;
    try {
      res = await fetch(`${this.#base}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(this.#o.timeoutMs ?? 20_000),
        headers: { authorization: `Bearer ${this.#o.secretKey}`, ...(this.#o.apiVersion === undefined ? {} : { 'stripe-version': this.#o.apiVersion }), ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idempotencyKey as string } : {}) },
        ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }) });
      body = await res.json() as Record<string, unknown>;
    } catch { throw new PaymentOutcomeUnknown('stripe: no usable response (network error, timeout or malformed body)'); }
    if (res.status >= 500 || res.status === 409 || res.status === 429) throw new PaymentOutcomeUnknown(`stripe: HTTP ${res.status}; the request may or may not have been processed`);
    return { status: res.status, body };
  }
  #fail(status: number, body: Record<string, unknown>): never {
    const e = (body.error ?? {}) as { type?: string; code?: string; message?: string };
    if (status === 401 || status === 403) throw new DomainError('provider_unavailable', 'Stripe rejected the configured credentials');
    throw new DomainError('invalid_provider_request', `Stripe rejected the request (${String(e.type ?? status)}${e.code === undefined ? '' : `/${e.code}`})`);
  }
  #intent(b: Record<string, unknown>): ProviderPayment {
    const status = PI_STATUS[String(b.status)]; invariant(typeof b.id === 'string' && status !== undefined, 'invalid_provider_response', 'Unrecognised Stripe PaymentIntent');
    const failed = status === 'requires_action' && b.status === 'requires_payment_method' && b.last_payment_error !== null && b.last_payment_error !== undefined;
    const code = (b.last_payment_error as { code?: string; decline_code?: string } | null | undefined);
    return { providerRef: b.id, status: failed ? 'failed' : status, ...(failed ? { failureCode: code?.decline_code ?? code?.code ?? 'payment_failed' } : {}), ...(typeof b.client_secret === 'string' ? { clientSecret: b.client_secret } : {}) };
  }
  #session(b: Record<string, unknown>): ProviderPayment {
    invariant(typeof b.id === 'string', 'invalid_provider_response', 'Unrecognised Stripe Checkout Session');
    const status: ProviderStatus = b.payment_status === 'paid' ? 'succeeded' : b.status === 'expired' ? 'canceled' : b.status === 'complete' ? 'processing' : 'requires_action';
    return { providerRef: b.id, status, ...(typeof b.url === 'string' ? { checkoutUrl: b.url } : {}) };
  }
  async createPayment(q: CreatePaymentRequest): Promise<ProviderPayment> {
    const meta = Object.fromEntries(Object.entries({ ...q.metadata, payment_id: q.paymentId }).map(([k, v]) => [k, String(v).slice(0, 500)]));
    if ((this.#o.flow ?? 'payment_intent') === 'checkout') {
      const success = q.returnUrl ?? this.#o.successUrl; invariant(typeof success === 'string', 'invalid_config', 'Checkout needs a success URL');
      const form: Record<string, string> = { mode: 'payment', success_url: success, cancel_url: this.#o.cancelUrl ?? success, client_reference_id: q.paymentId, 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': q.currency.toLowerCase(),
        'line_items[0][price_data][unit_amount]': String(q.amountMinor), 'line_items[0][price_data][product_data][name]': q.description.slice(0, 250) };
      for (const [k, v] of Object.entries(meta)) { form[`metadata[${k}]`] = v; form[`payment_intent_data[metadata][${k}]`] = v; }
      const r = await this.#request('POST', '/v1/checkout/sessions', form, q.idempotencyKey);
      return r.status === 200 ? this.#session(r.body) : this.#fail(r.status, r.body);
    }
    const form: Record<string, string> = { amount: String(q.amountMinor), currency: q.currency.toLowerCase(), description: q.description.slice(0, 1000), 'automatic_payment_methods[enabled]': 'true' };
    if (q.method !== undefined) { form.payment_method = q.method; form.confirm = 'true'; form['automatic_payment_methods[allow_redirects]'] = 'never'; }
    for (const [k, v] of Object.entries(meta)) form[`metadata[${k}]`] = v;
    const r = await this.#request('POST', '/v1/payment_intents', form, q.idempotencyKey);
    if (r.status === 200) return this.#intent(r.body);
    if (r.status === 402) {
      // Card error: a definitive decline. Stripe attaches the PaymentIntent it created.
      const e = (r.body.error ?? {}) as { code?: string; decline_code?: string; payment_intent?: { id?: string } };
      return { providerRef: e.payment_intent?.id ?? `declined_${q.paymentId}`, status: 'failed', failureCode: e.decline_code ?? e.code ?? 'card_declined' };
    }
    return this.#fail(r.status, r.body);
  }
  async fetchPayment(providerRef: string): Promise<ProviderPayment | null> {
    invariant(/^(pi|cs)_[A-Za-z0-9_]+$/.test(providerRef), 'invalid_input', 'Not a Stripe reference');
    const session = providerRef.startsWith('cs_');
    const r = await this.#request('GET', `/v1/${session ? 'checkout/sessions' : 'payment_intents'}/${providerRef}`);
    if (r.status === 404) return null;
    if (r.status !== 200) return this.#fail(r.status, r.body);
    return session ? this.#session(r.body) : this.#intent(r.body);
  }
  /** Replays the create call with the SAME Idempotency-Key: Stripe returns the original result instead of charging again. */
  recover(q: CreatePaymentRequest): Promise<ProviderPayment | null> { return this.createPayment(q); }
  verifyWebhook(raw: Uint8Array, headers: WebhookHeaders, now: Date, tolerance: number): ProviderEvent {
    if (this.#o.webhookSecret === undefined || this.#o.webhookSecret === '') throw new DomainError('provider_unavailable', 'Stripe webhooks are unavailable: STRIPE_WEBHOOK_SECRET is not configured');
    verifySignature(header(headers, 'stripe-signature'), raw, this.#o.webhookSecret, now, tolerance);
    let e: { id?: unknown; type?: unknown; created?: unknown; livemode?: unknown; data?: { object?: Record<string, unknown> } };
    try { e = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { throw new DomainError('invalid_input', 'Malformed webhook body'); }
    const o = e.data?.object;
    invariant(typeof e.id === 'string' && typeof e.type === 'string' && typeof e.created === 'number' && o !== undefined && typeof o.id === 'string', 'invalid_input', 'Malformed Stripe event');
    invariant((e.livemode === true) === (this.mode === 'live'), 'invalid_input', 'Event mode does not match the configured key');
    const err = o.last_payment_error as { code?: string; decline_code?: string } | null | undefined;
    const map: Record<string, ProviderStatus | undefined> = { 'payment_intent.succeeded': 'succeeded', 'payment_intent.processing': 'processing', 'payment_intent.payment_failed': 'failed', 'payment_intent.canceled': 'canceled', 'payment_intent.requires_action': 'requires_action',
      'checkout.session.completed': o.payment_status === 'paid' ? 'succeeded' : 'processing', 'checkout.session.async_payment_succeeded': 'succeeded', 'checkout.session.async_payment_failed': 'failed', 'checkout.session.expired': 'canceled' };
    const status = map[e.type] ?? null; const meta = o.metadata as Record<string, unknown> | undefined;
    const paymentId = typeof meta?.payment_id === 'string' ? meta.payment_id : typeof o.client_reference_id === 'string' ? o.client_reference_id : null;
    return { id: e.id, type: e.type, createdAt: new Date(e.created * 1000).toISOString(), providerRef: o.id, paymentId, status, ...(status === 'failed' ? { failureCode: err?.decline_code ?? err?.code ?? 'payment_failed' } : {}) };
  }
}
/** Builds the Stripe provider from environment-style configuration; absent credentials yield an explicit unavailable provider. */
export function stripeFromEnv(env: Readonly<Record<string, string | undefined>>, o: Omit<StripeOptions, 'secretKey' | 'webhookSecret'> = {}): PaymentProvider {
  if (env.STRIPE_SECRET_KEY === undefined || env.STRIPE_SECRET_KEY === '') return unavailableProvider('stripe', 'STRIPE_SECRET_KEY is not configured');
  return new StripeProvider({ ...o, secretKey: env.STRIPE_SECRET_KEY, ...(env.STRIPE_WEBHOOK_SECRET === undefined ? {} : { webhookSecret: env.STRIPE_WEBHOOK_SECRET }) });
}
