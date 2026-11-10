// Payment handling: creation through a provider adapter, replay-resistant webhooks, reconciliation of unknown outcomes.
// Invariants: one provider idempotency key per payment (a retry can never charge twice); a provider event id is applied at
// most once; `succeeded` is never regressed; unknown outcomes become `uncertain` and are resolved by asking the provider.
import { randomUUID } from 'node:crypto';
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { enqueueJob } from '../service-kit.ts';
import type { ServiceContext, Sql } from '../service-kit.ts';
import { postEntry } from './commercial.ts';
import { S, cap, currency, humanWith, id, int, limitOf, norm, norms, num, optStr, ref, sha, str, time, uuidLike } from './core.ts';
import type { Internals, Tx } from './core.ts';
import { PaymentOutcomeUnknown } from './payments.ts';
import type { CreatePaymentRequest, PaymentProvider, ProviderPayment, ProviderStatus, WebhookHeaders } from './payments.ts';

export type Payment = Readonly<{
  id: string; tenantId: string; projectId: string; invoiceId: string; provider: string; mode: 'sandbox' | 'test' | 'live'; amountMinor: number; currency: string;
  state: 'created' | 'processing' | 'requires_action' | 'succeeded' | 'failed' | 'canceled' | 'uncertain'; providerRef: string | null; idempotencyKey: string; method: string | null;
  checkoutUrl: string | null; failureCode: string | null; lastEventAt: string | null; lastCheckedAt: string | null; checks: number; entryId: string | null; createdBy: string; createdAt: string; updatedAt: string;
}>;
type PRow = Record<string, unknown> & { id: string; state: string; invoice_id: string; amount_minor: string; currency: string; provider: string; provider_ref: string | null; last_event_at: Date | null; method: string | null; tenant_id: string; project_id: string };
const RANK: Readonly<Record<string, number>> = { created: 0, uncertain: 0, processing: 1, requires_action: 1, failed: 2, canceled: 2, succeeded: 3 };
const OPEN = ['created', 'processing', 'requires_action', 'uncertain'];

export function paymentService(d: Internals) {
  const sc = (ctx: ServiceContext): [string, string] => [ctx.tenantId, ctx.projectId];
  function provider(name: string): PaymentProvider {
    const p = Object.hasOwn(d.ports.payments ?? {}, name) ? (d.ports.payments as Record<string, PaymentProvider>)[name] : undefined;
    if (p === undefined) throw new DomainError('provider_unavailable', `Payment provider "${name}" is not configured`);
    return p;
  }
  const requestOf = (p: PRow, description: string): CreatePaymentRequest => ({ paymentId: p.id, amountMinor: num(p.amount_minor), currency: p.currency, description, idempotencyKey: `e13-${p.id}`, ...(p.method === null ? {} : { method: p.method }), metadata: { payment_id: p.id, tenant_id: p.tenant_id, project_id: p.project_id, invoice_id: p.invoice_id } });

  /** The single place a payment changes state. Returns whether anything changed. */
  async function transition(t: Tx, p: PRow, next: { status: ProviderStatus | 'uncertain'; providerRef?: string | null; failureCode?: string | null; eventAt?: string | null; checkoutUrl?: string | null }): Promise<boolean> {
    if (p.state === 'succeeded') return false; // terminal: nothing may regress or repeat a successful payment
    const refChanged = next.providerRef !== undefined && next.providerRef !== null && p.provider_ref === null;
    if (p.state === next.status && !refChanged) {
      if (next.eventAt !== undefined && next.eventAt !== null) await t.sql.query(`update ${S}.payments set last_event_at = greatest(coalesce(last_event_at, $2::timestamptz), $2::timestamptz) where id=$1`, [p.id, next.eventAt]);
      return false;
    }
    await t.sql.query(`update ${S}.payments set state=$2, provider_ref=coalesce(provider_ref, $3), failure_code=$4, checkout_url=coalesce($5, checkout_url), last_event_at=greatest(coalesce(last_event_at, $6::timestamptz), coalesce($6::timestamptz, last_event_at)), updated_at=$7 where id=$1`,
      [p.id, next.status, next.providerRef ?? null, next.status === 'failed' ? (next.failureCode ?? 'payment_failed') : null, next.checkoutUrl ?? null, next.eventAt ?? null, t.ctx.now]);
    const subject = ref('payment', p.id); const amount = num(p.amount_minor);
    if (next.status === 'succeeded') {
      const inv = (await t.sql.query<Record<string, unknown>>(`select * from ${S}.invoices where id=$1 for update`, [p.invoice_id]))[0]!;
      const entry = await postEntry(t, { date: t.ctx.now.slice(0, 10), currency: p.currency, memo: `Payment received for invoice ${String(inv.number)} via ${p.provider}`, sourceKind: 'payment', sourceId: p.id, lines: [{ account: '1200', debit: amount }, { account: '1100', credit: amount }] });
      await t.sql.query(`update ${S}.payments set entry_id=$2 where id=$1`, [p.id, entry]);
      const paid = num(inv.paid_minor) + amount; const full = paid >= num(inv.total_minor);
      await t.sql.query(`update ${S}.invoices set paid_minor=$2, state=case when $3 and state in ('issued','sent') then 'paid' else state end, updated_at=$4 where id=$1`, [inv.id, paid, full, t.ctx.now]);
      t.event('resources.payment_succeeded', subject, { paymentId: p.id, invoiceId: p.invoice_id, amountMinor: amount, currency: p.currency, provider: p.provider });
      if (full) {
        const recs = await t.sql.query<{ id: string }>(`update ${S}.revenue_records set state='reconciled', reconciliation=$2::jsonb where invoice_id=$1 and state='recorded' returning id`, [inv.id, JSON.stringify({ paymentId: p.id, at: t.ctx.now })]);
        t.event('resources.invoice_paid', ref('invoice', inv.id as string), { invoiceId: inv.id as string, number: inv.number as string });
        for (const r of recs) t.event('resources.revenue_reconciled', ref('revenue', r.id), { revenueId: r.id, source: 'invoice', paymentId: p.id });
      }
    } else if (next.status === 'failed' || next.status === 'canceled') t.event(`resources.payment_${next.status}`, subject, { paymentId: p.id, invoiceId: p.invoice_id, failureCode: next.failureCode ?? null });
    else if (next.status === 'uncertain') {
      await t.sql.query(`insert into ${S}.incidents (id, tenant_id, project_id, kind, dedupe, subject, detail, first_at, last_at) values ($1,$2,$3,'payment_uncertain',$4,$5,$6::jsonb,$7,$7) on conflict (tenant_id, project_id, kind, dedupe) do update set count=${S}.incidents.count+1, last_at=excluded.last_at`,
        [randomUUID(), p.tenant_id, p.project_id, p.id, subject, JSON.stringify({ provider: p.provider, amountMinor: amount }), t.ctx.now]);
      t.event('resources.payment_uncertain', subject, { paymentId: p.id, invoiceId: p.invoice_id });
    }
    if (next.status !== 'uncertain') await t.sql.query(`update ${S}.incidents set resolved_at=$2, resolved_by=$3 where kind='payment_uncertain' and dedupe=$1 and resolved_at is null`, [p.id, t.ctx.now, t.ctx.actor.id]);
    t.audit(`payment.${next.status}`, subject, { from: p.state, providerRef: next.providerRef ?? p.provider_ref, failureCode: next.failureCode ?? null });
    return true;
  }
  const lock = async (sql: Sql, paymentId: string): Promise<PRow | undefined> => (await sql.query<PRow>(`select * from ${S}.payments where id=$1 for update`, [paymentId]))[0];
  const systemCtx = (p: { tenant_id: string; project_id: string }, actor: string, purpose: string): ServiceContext => ({ tenantId: p.tenant_id, projectId: p.project_id, purpose, requestId: randomUUID(), now: new Date().toISOString(), actor: { id: actor, kind: 'service', roles: [] }, capabilities: [], compartments: [] });

  /** Asks the provider what happened and applies it. Never issues a new charge: uses the provider reference or the original idempotency key. */
  async function reconcileOne(ctx: ServiceContext, paymentId: string): Promise<Payment> {
    const p = (await d.sql.query<PRow>(`select * from ${S}.payments where id=$1 and tenant_id=$2 and project_id=$3`, [id(paymentId), ...sc(ctx)]))[0];
    invariant(p !== undefined, 'not_found', 'Not found');
    if (!OPEN.includes(p.state)) return norm<Payment>(p);
    const prov = provider(p.provider);
    let found: ProviderPayment | null;
    try { found = p.provider_ref !== null ? await prov.fetchPayment(p.provider_ref) : await prov.recover(requestOf(p, `Invoice payment ${p.id}`)); }
    catch (error) {
      await d.sql.query(`update ${S}.payments set checks=checks+1, last_checked_at=$2 where id=$1`, [p.id, ctx.now]);
      if (error instanceof PaymentOutcomeUnknown) throw new DomainError('provider_unavailable', 'The provider could not be reached; the payment stays uncertain and will be checked again');
      throw error;
    }
    return d.run(ctx, 'payment.reconcile', undefined, null, async (t) => {
      const cur = (await lock(t.sql, p.id))!;
      await t.sql.query(`update ${S}.payments set checks=checks+1, last_checked_at=$2 where id=$1`, [p.id, ctx.now]);
      // No provider record for this idempotency key: the charge was never created, so the attempt is closed as failed.
      if (found === null) await transition(t, cur, { status: 'failed', failureCode: 'provider_has_no_record' });
      else await transition(t, cur, { status: found.status, providerRef: found.providerRef, failureCode: found.failureCode ?? null, checkoutUrl: found.checkoutUrl ?? null });
      return norm<Payment>((await t.sql.query(`select * from ${S}.payments where id=$1`, [p.id]))[0]!);
    });
  }

  const svc = {
    /**
     * Requests payment of an issued invoice through a provider. The payment row is committed BEFORE the provider is called;
     * a lost response leaves it `uncertain` (never retried blindly). Live-mode providers need config AND an unexpired human grant.
     */
    async createPayment(ctx: ServiceContext, input: { invoiceId: string; provider: string; amountMinor?: number; method?: string; returnUrl?: string; idempotencyKey: string }): Promise<Payment & { clientSecret?: string }> {
      cap(ctx, 'send'); str(input?.idempotencyKey, 'idempotencyKey', 150);
      const prov = provider(str(input.provider, 'provider', 50));
      if (d.ports.authorization !== undefined) {
        const verdict = await d.ports.authorization.authorize(ctx, { capability: 'resources:send', resource: ref('invoice', id(input.invoiceId)) });
        if (!verdict.allowed) throw new DomainError('forbidden', 'Payment request denied by policy');
      }
      const row = await d.run(ctx, 'payment.create', undefined, null, async (t) => {
        const prior = (await t.sql.query<PRow>(`select * from ${S}.payments where tenant_id=$1 and project_id=$2 and idempotency_key=$3`, [...sc(ctx), input.idempotencyKey]))[0];
        if (prior !== undefined) { invariant(prior.invoice_id === input.invoiceId && prior.provider === prov.name, 'idempotency_conflict', 'Idempotency key was used for a different payment'); return prior; }
        const inv = (await t.sql.query<Record<string, unknown>>(`select * from ${S}.invoices where id=$1 and tenant_id=$2 and project_id=$3 for update`, [id(input.invoiceId), ...sc(ctx)]))[0];
        invariant(inv !== undefined, 'not_found', 'Not found');
        invariant(inv.state === 'issued' || inv.state === 'sent', 'invalid_state', `Invoice is ${inv.state as string}`);
        const inFlight = num((await t.sql.query<{ s: string }>(`select coalesce(sum(amount_minor),0) as s from ${S}.payments where invoice_id=$1 and state = any($2::text[])`, [inv.id, OPEN]))[0]!.s);
        const outstanding = num(inv.total_minor) - num(inv.paid_minor) - inFlight;
        const amount = input.amountMinor === undefined ? outstanding : int(input.amountMinor, 'amountMinor', 1);
        invariant(amount > 0 && amount <= outstanding, 'invalid_state', 'Nothing is outstanding on this invoice beyond payments already in flight');
        if (prov.mode === 'live') {
          // Real money: configuration alone is not enough; a human must have granted it for this scope, amount and time.
          const grant = d.cfg.allowLivePayments ? (await t.sql.query(`select id from ${S}.live_payment_grants where tenant_id=$1 and project_id=$2 and provider=$3 and currency=$4 and max_amount_minor >= $5 and revoked_at is null and expires_at > $6 limit 1`, [...sc(ctx), prov.name, inv.currency, amount, ctx.now]))[0] : undefined;
          if (grant === undefined) throw new DomainError('grant_invalid', 'Live payments are refused: allowLivePayments and an unexpired human grant covering this amount are both required');
        }
        const pid = randomUUID();
        const ins = (await t.sql.query<PRow>(`insert into ${S}.payments (id, tenant_id, project_id, invoice_id, provider, mode, amount_minor, currency, state, idempotency_key, method, created_by, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,'created',$9,$10,$11,$12,$12) returning *`,
          [pid, ...sc(ctx), inv.id, prov.name, prov.mode, amount, inv.currency, input.idempotencyKey, optStr(input.method, 'method', 100), ctx.actor.id, ctx.now]))[0]!;
        await enqueueJob(t.sql, S, ctx, { kind: 'resources.reconcile_payment', payload: { paymentId: pid }, dedupeKey: pid, runAt: new Date(Date.parse(ctx.now) + d.cfg.reconcileAfterSeconds * 1000), maxAttempts: 8 });
        t.event('resources.payment_created', ref('payment', pid), { paymentId: pid, invoiceId: inv.id as string, amountMinor: amount, currency: inv.currency as string, provider: prov.name, mode: prov.mode });
        t.audit('payment.created', ref('payment', pid), { invoiceId: inv.id as string, amountMinor: amount, provider: prov.name, mode: prov.mode });
        return ins;
      });
      if (row.state !== 'created') return norm<Payment>(row);
      let result: ProviderPayment | undefined, failure: string | undefined;
      try { result = await prov.createPayment({ ...requestOf(row, `Invoice payment ${row.id}`), ...(input.returnUrl === undefined ? {} : { returnUrl: input.returnUrl }) }); }
      catch (error) {
        // A definitive provider answer (DomainError) fails the attempt; anything else means we do not know what happened.
        if (error instanceof DomainError) failure = error.code;
      }
      const out = await d.run(ctx, 'payment.result', undefined, null, async (t) => {
        const cur = (await lock(t.sql, row.id))!;
        if (cur.state === 'created') {
          if (result !== undefined) await transition(t, cur, { status: result.status, providerRef: result.providerRef, failureCode: result.failureCode ?? null, checkoutUrl: result.checkoutUrl ?? null });
          else if (failure !== undefined) await transition(t, cur, { status: 'failed', failureCode: failure });
          else await transition(t, cur, { status: 'uncertain' });
        }
        return norm<Payment>((await t.sql.query(`select * from ${S}.payments where id=$1`, [row.id]))[0]!);
      });
      return result?.clientSecret === undefined ? out : { ...out, clientSecret: result.clientSecret };
    },
    async getPayment(ctx: ServiceContext, paymentId: string): Promise<Payment> {
      cap(ctx, 'read');
      const r = await d.sql.query(`select * from ${S}.payments where id=$1 and tenant_id=$2 and project_id=$3`, [id(paymentId), ...sc(ctx)]);
      invariant(r[0] !== undefined, 'not_found', 'Not found');
      return norm<Payment>(r[0]);
    },
    async listPayments(ctx: ServiceContext, o: { invoiceId?: string; state?: string; limit?: number } = {}): Promise<Payment[]> {
      cap(ctx, 'read');
      return norms<Payment>(await d.sql.query(`select * from ${S}.payments where tenant_id=$1 and project_id=$2 and ($3::uuid is null or invoice_id=$3) and ($4::text is null or state=$4) order by created_at desc limit ${limitOf(o.limit)}`, [...sc(ctx), o.invoiceId === undefined ? null : id(o.invoiceId), o.state ?? null]));
    },
    /**
     * Provider webhook entry point (public HTTP route; authenticated by the provider's signature, not by a bearer token).
     * Replay resistance: signature + timestamp tolerance, provider event id stored unique, stale and duplicate events ignored.
     */
    async handleProviderWebhook(providerName: string, raw: Uint8Array, headers: WebhookHeaders, now: Date = new Date()): Promise<{ received: true; handling: 'applied' | 'no_change' | 'duplicate' | 'ignored_stale' | 'ignored_type' | 'ignored_unknown_payment' }> {
      const prov = provider(providerName);
      const event = prov.verifyWebhook(raw, headers, now, d.cfg.webhookToleranceSeconds);
      const found = (await d.sql.query<PRow>(`select * from ${S}.payments where provider=$1 and (($2::uuid is not null and id=$2) or provider_ref=$3) limit 1`, [prov.name, uuidLike(event.paymentId) ? event.paymentId : null, event.providerRef]))[0];
      const ctx = systemCtx(found ?? { tenant_id: '_unmatched', project_id: '_unmatched' }, `provider:${prov.name}`, 'payment_webhook');
      return d.run(ctx, 'webhook', undefined, null, async (t) => {
        const fresh = await t.sql.query(`insert into ${S}.provider_events (provider, event_id, tenant_id, project_id, payment_id, type, event_created_at, received_at, payload_sha256, handling) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') on conflict (provider, event_id) do nothing returning event_id`,
          [prov.name, event.id.slice(0, 255), ctx.tenantId, ctx.projectId, found?.id ?? null, event.type.slice(0, 100), event.createdAt, ctx.now, sha(raw)]);
        if (fresh.length === 0) return { received: true as const, handling: 'duplicate' as const };
        let handling: 'applied' | 'no_change' | 'ignored_stale' | 'ignored_type' | 'ignored_unknown_payment';
        const p = found === undefined ? undefined : await lock(t.sql, found.id);
        if (p === undefined) handling = 'ignored_unknown_payment';
        else if (event.status === null) handling = 'ignored_type';
        else {
          const last = p.last_event_at === null ? null : new Date(p.last_event_at).getTime(); const at = Date.parse(event.createdAt);
          // Out-of-order delivery: an older event, or an equally old one that would move the payment backwards, is not applied.
          if (p.state !== 'succeeded' && last !== null && (at < last || (at === last && (RANK[event.status] ?? 0) <= (RANK[p.state] ?? 0)))) handling = 'ignored_stale';
          else handling = (await transition(t, p, { status: event.status, providerRef: event.providerRef.startsWith('declined_') ? null : (p.provider_ref ?? event.providerRef), failureCode: event.failureCode ?? null, eventAt: event.createdAt })) ? 'applied' : 'no_change';
        }
        await t.sql.query(`update ${S}.provider_events set handling=$3 where provider=$1 and event_id=$2`, [prov.name, event.id.slice(0, 255), handling]);
        return { received: true as const, handling };
      });
    },
    /** Reconciles one payment now. */
    async reconcilePayment(ctx: ServiceContext, paymentId: string): Promise<Payment> { cap(ctx, 'write'); return reconcileOne(ctx, paymentId); },
    /** Reconciles every payment of the project left in created/processing/requires_action/uncertain. */
    async reconcilePayments(ctx: ServiceContext, o: { olderThanSeconds?: number } = {}): Promise<{ checked: number; resolved: number; stillOpen: string[]; unreachable: string[] }> {
      cap(ctx, 'write');
      const before = new Date(Date.parse(ctx.now) - (o.olderThanSeconds ?? 0) * 1000).toISOString();
      const open = await d.sql.query<{ id: string }>(`select id from ${S}.payments where tenant_id=$1 and project_id=$2 and state = any($3::text[]) and updated_at <= $4 order by created_at limit 500`, [...sc(ctx), OPEN, before]);
      const out = { checked: open.length, resolved: 0, stillOpen: [] as string[], unreachable: [] as string[] };
      for (const p of open) {
        try { const r = await reconcileOne(ctx, p.id); if (OPEN.includes(r.state)) out.stillOpen.push(p.id); else out.resolved++; }
        catch (error) { if (error instanceof DomainError && error.code === 'provider_unavailable') out.unreachable.push(p.id); else throw error; }
      }
      return out;
    },
    /** Job handler body: throws while the payment is still open so the kit retries with backoff; dead-letters into an incident view via listJobs. */
    async reconcilePaymentJob(ctx: ServiceContext, paymentId: string): Promise<Json> {
      const r = await reconcileOne(ctx, paymentId);
      if (OPEN.includes(r.state)) throw new Error(`payment ${paymentId} is still ${r.state}`);
      return { paymentId, state: r.state };
    },
    /** A human with resources:grant permits live payments for a provider, currency, amount ceiling and time window. */
    async grantLivePayments(ctx: ServiceContext, input: { provider: string; currency: string; maxAmountMinor: number; expiresAt: string; reason: string }): Promise<{ id: string }> {
      humanWith(ctx, 'grant');
      const expires = time(input.expiresAt, 'expiresAt'); invariant(Date.parse(expires) > Date.parse(ctx.now) && Date.parse(expires) - Date.parse(ctx.now) <= 366 * 86_400_000, 'invalid_input', 'Grant must expire within a year');
      return d.run(ctx, 'grant', undefined, null, async (t) => {
        const gid = randomUUID();
        await t.sql.query(`insert into ${S}.live_payment_grants (id, tenant_id, project_id, provider, max_amount_minor, currency, granted_by, granted_at, expires_at, reason) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [gid, ...sc(ctx), str(input.provider, 'provider', 50), int(input.maxAmountMinor, 'maxAmountMinor', 1), currency(input.currency), ctx.actor.id, ctx.now, expires, str(input.reason, 'reason', 500)]);
        t.event('resources.live_payments_granted', ref('live_payment_grant', gid), { provider: input.provider, currency: input.currency, maxAmountMinor: input.maxAmountMinor, expiresAt: expires });
        t.audit('payments.live_granted', ref('live_payment_grant', gid), { provider: input.provider, maxAmountMinor: input.maxAmountMinor, expiresAt: expires, reason: input.reason });
        return { id: gid };
      });
    },
    async revokeLivePayments(ctx: ServiceContext, grantId: string): Promise<void> {
      humanWith(ctx, 'grant');
      await d.run(ctx, 'grant.revoke', undefined, null, async (t) => {
        const r = await t.sql.query(`update ${S}.live_payment_grants set revoked_at=$4 where id=$1 and tenant_id=$2 and project_id=$3 and revoked_at is null returning id`, [id(grantId), ...sc(ctx), ctx.now]);
        invariant(r.length === 1, 'not_found', 'Not found');
        t.audit('payments.live_revoked', ref('live_payment_grant', grantId), {});
      });
    },
  };
  return svc;
}
