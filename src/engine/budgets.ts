// Budgets, reservations (the BudgetPort), usage metering, work allocation, research lanes and operator views.
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { enqueueJob } from '../service-kit.ts';
import type { ServiceContext, Sql } from '../service-kit.ts';
import { allocateCost } from '../index.ts';
import { METERS, ORG, S, assertNoFactualLinkage, bps, cap, humanWith, id, int, limitOf, microToMinor, norm, norms, num, optStr, ref, str, strings, time, unitOf } from './core.ts';
import type { Internals, Meter, Tx } from './core.ts';

export type Budget = Readonly<{
  id: string; tenantId: string; projectId: string; parentId: string | null; level: 'organization' | 'project' | 'objective' | 'run' | 'agent' | 'lane';
  depth: number; name: string; unit: string; categories: string[] | null; actorId: string | null; lane: string | null; objective: string | null; run: string | null;
  period: 'one_off' | 'monthly'; ceiling: number; warnBps: number[]; overageToleranceBps: number; state: 'active' | 'frozen' | 'closed'; stateReason: string | null;
  revision: number; createdBy: string; createdAt: string; updatedAt: string;
}>;
export type BudgetNode = Budget & Readonly<{ periodKey: string; reserved: number; committed: number; available: number; usedBps: number; forecast: { method: 'linear_projection'; projected: number; exceedsCeiling: boolean } | null; assignedActors: string[]; children: BudgetNode[] }>;
export type Reservation = Readonly<{
  id: string; tenantId: string; projectId: string; idempotencyKey: string; actorId: string; actorKind: string; category: string; unit: string; amount: number;
  subject: string; lane: string | null; objective: string | null; run: string | null; state: 'held' | 'committed' | 'released' | 'expired';
  actual: number | null; detail: Json; reason: string | null; plan: string | null; tradeoffs: string | null; budgetIds: string[]; periodKeys: string[];
  expiresAt: string; createdAt: string; settledAt: string | null;
}>;
export type ReserveRequest = { category: string; amount: number; unit: string; subject: string; idempotencyKey: string; lane?: string; objective?: string; run?: string };
export type LaneReport = Readonly<{
  policyVersion: number | null; measure: string; driftToleranceBps: number; from: string | null; to: string | null;
  lanes: Readonly<{ key: string; name: string; configured: boolean; targetShareBps: number; activeSeconds: number; attempts: number; workRecords: number; tokensIn: number; tokensOut: number; computeSeconds: number; renderSeconds: number; cost: Record<string, number>; actualShareBps: Record<string, number>; driftBps: number; withinTolerance: boolean }>[];
  totals: Record<string, number>; maxAbsDriftBps: number; withinTolerance: boolean; underAllocated: string[]; overAllocated: string[];
}>;

class Denied extends DomainError {
  readonly info: { reason: string; budgetId: string | null; periodKey: string; detail: Json };
  constructor(message: string, info: Denied['info']) { super('budget_exhausted', message); this.info = info; }
}
const periodKey = (period: string, now: string): string => (period === 'monthly' ? new Date(now).toISOString().slice(0, 7) : 'once');
type BRow = Record<string, unknown> & { id: string; ceiling: string; period: string; state: string; warn_bps: number[]; overage_tolerance_bps: number; depth: number; actor_id: string | null };

export function budgetService(d: Internals) {
  const scope = (ctx: ServiceContext): [string, string] => [ctx.tenantId, ctx.projectId];

  async function getBudgetRow(sql: Sql, ctx: ServiceContext, budgetId: string, lock = false): Promise<BRow> {
    const rows = await sql.query<BRow>(`select * from ${S}.budgets where id=$1 and tenant_id=$2 and project_id in ($3,'${ORG}')${lock ? ' for update' : ''}`, [id(budgetId), ...scope(ctx)]);
    invariant(rows[0] !== undefined, 'not_found', 'Not found');
    return rows[0];
  }
  async function periodRow(sql: Sql, b: BRow, key: string): Promise<{ reserved: number; committed: number; warned: number[] }> {
    await sql.query(`insert into ${S}.budget_periods (budget_id, period_key, tenant_id, project_id) values ($1,$2,$3,$4) on conflict do nothing`, [b.id, key, b.tenant_id, b.project_id]);
    const r = (await sql.query<{ reserved: string; committed: string; warned_bps: number[] }>(`select reserved, committed, warned_bps from ${S}.budget_periods where budget_id=$1 and period_key=$2`, [b.id, key]))[0]!;
    return { reserved: num(r.reserved), committed: num(r.committed), warned: r.warned_bps };
  }
  /** Emits each configured soft-warning threshold once per budget period. */
  async function warn(t: Tx, b: BRow, key: string): Promise<void> {
    const p = await periodRow(t.sql, b, key);
    const used = p.reserved + p.committed; const ceiling = num(b.ceiling);
    const crossed = b.warn_bps.filter((w) => !p.warned.includes(w) && used * 10000 >= ceiling * w);
    if (crossed.length === 0) return;
    await t.sql.query(`update ${S}.budget_periods set warned_bps = warned_bps || $3::int[] where budget_id=$1 and period_key=$2`, [b.id, key, crossed]);
    for (const w of crossed) t.event('resources.budget_warning', ref('budget', b.id), { budgetId: b.id, periodKey: key, thresholdBps: w, used, ceiling, unit: b.unit as string });
  }
  async function incident(t: Tx, kind: string, dedupe: string, budgetId: string | null, subject: string, detail: Json): Promise<boolean> {
    const r = await t.sql.query<{ inserted: boolean }>(`insert into ${S}.incidents (id, tenant_id, project_id, kind, dedupe, budget_id, subject, detail, first_at, last_at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9)
      on conflict (tenant_id, project_id, kind, dedupe) do update set count = ${S}.incidents.count + 1, last_at = excluded.last_at, detail = excluded.detail, resolved_at = null, resolved_by = null returning (xmax = 0) as inserted`,
      [randomUUID(), t.ctx.tenantId, t.ctx.projectId, kind, dedupe, budgetId, subject, JSON.stringify(detail), t.ctx.now]);
    return r[0]!.inserted;
  }
  async function freeze(t: Tx, b: BRow, reason: string): Promise<void> {
    const r = await t.sql.query(`update ${S}.budgets set state='frozen', state_reason=$2, revision=revision+1, updated_at=$3 where id=$1 and state='active' returning id`, [b.id, reason, t.ctx.now]);
    if (r.length === 0) return;
    await incident(t, 'frozen', `${b.id}:${t.ctx.now}`, b.id, ref('budget', b.id), { reason });
    t.event('resources.budget_frozen', ref('budget', b.id), { budgetId: b.id, reason });
    t.audit('budget.frozen', ref('budget', b.id), { reason });
  }
  /** Returns capacity held by reservations whose expiry has passed. Used by the expiry job, the sweep and lazily by reserve. */
  async function expireRows(sql: Sql, where: string, params: unknown[], emit: (r: Record<string, unknown>) => void): Promise<number> {
    const rows = await sql.query<Record<string, unknown> & { id: string; amount: string; budget_ids: string[]; period_keys: string[] }>(
      `update ${S}.reservations set state='expired', settled_at=expires_at, reason='expired without commit or release' where id in (select id from ${S}.reservations where state='held' and ${where} order by id for update skip locked) returning *`, params);
    for (const r of rows) {
      for (const [i, b] of r.budget_ids.entries()) await sql.query(`update ${S}.budget_periods set reserved = greatest(reserved - $3, 0) where budget_id=$1 and period_key=$2`, [b, r.period_keys[i], r.amount]);
      emit(r);
    }
    return rows.length;
  }
  const expiredEvent = (t: Tx) => (r: Record<string, unknown>): void => { t.event('resources.budget_reservation_expired', ref('reservation', r.id as string), { reservationId: r.id as string, amount: num(r.amount), unit: r.unit as string }); };

  async function reserveIn(t: Tx, q: ReserveRequest, plan: { name: string; tradeoffs: string } | null): Promise<Reservation> {
    const { ctx, sql } = t;
    const unit = unitOf(q.unit); const amount = int(q.amount, 'amount', 1);
    const category = str(q.category, 'category', 100); const subject = str(q.subject, 'subject', 500);
    const lane = optStr(q.lane, 'lane', 100), objective = optStr(q.objective, 'objective', 500), run = optStr(q.run, 'run', 500);
    // Row locks on every applicable budget, always in id order: concurrent reservations queue here and can never oversubscribe.
    const budgets = await sql.query<BRow>(`select * from ${S}.budgets where tenant_id=$1 and project_id in ($2,'${ORG}') and unit=$3 and state <> 'closed'
      and (categories is null or $4 = any(categories)) and (actor_id is null or actor_id=$5) and (lane is null or lane=$6)
      and (objective is null or objective=$7 or objective=$9) and (run is null or run=$8 or run=$9) order by id for update`,
      [ctx.tenantId, ctx.projectId, unit, category, ctx.actor.id, lane, objective, run, subject]);
    const deny = (message: string, reason: string, b: BRow | null, detail: Json = {}): never => {
      throw new Denied(message, { reason, budgetId: b?.id ?? null, periodKey: b === null ? 'none' : periodKey(b.period, ctx.now), detail: { category, unit, amount, subject, actorId: ctx.actor.id, actorKind: ctx.actor.kind, ...(detail as object) } });
    };
    if (budgets.length === 0) deny(`No ${unit} budget applies to this request`, 'no_budget', null);
    if (ctx.actor.kind !== 'human') {
      // Mandatory default: unattended actors spend only from a budget explicitly assigned to them.
      const assigned = budgets.some((b) => b.actor_id === ctx.actor.id) || (await sql.query(`select 1 from ${S}.budget_assignments where budget_id = any($1::uuid[]) and actor_id=$2 and revoked_at is null limit 1`, [budgets.map((b) => b.id), ctx.actor.id])).length > 0;
      if (!assigned) deny('This agent or service has no explicit budget assignment', 'unassigned_actor', null);
    }
    const frozen = budgets.find((b) => b.state === 'frozen');
    if (frozen !== undefined) deny('A budget covering this request is frozen', 'frozen', frozen);
    const keys = budgets.map((b) => periodKey(b.period, ctx.now));
    for (const [i, b] of budgets.entries()) {
      const key = keys[i]!; const ceiling = num(b.ceiling);
      let p = await periodRow(sql, b, key);
      if (p.reserved + p.committed + amount > ceiling) {
        if (await expireRows(sql, `expires_at <= $1 and $2 = any(budget_ids)`, [ctx.now, b.id], expiredEvent(t)) > 0) p = await periodRow(sql, b, key);
        if (p.reserved + p.committed + amount > ceiling) deny(`Budget "${b.name as string}" would be exceeded`, 'ceiling', b, { ceiling, reserved: p.reserved, committed: p.committed, available: Math.max(ceiling - p.reserved - p.committed, 0) });
      }
    }
    for (const [i, b] of budgets.entries()) {
      await sql.query(`update ${S}.budget_periods set reserved = reserved + $3 where budget_id=$1 and period_key=$2`, [b.id, keys[i], amount]);
      await warn(t, b, keys[i]!);
    }
    const rid = randomUUID();
    const expiresAt = new Date(Date.parse(ctx.now) + d.cfg.reservationTtlSeconds * 1000);
    const row = (await sql.query(`insert into ${S}.reservations (id, tenant_id, project_id, idempotency_key, actor_id, actor_kind, category, unit, amount, subject, lane, objective, run, state, plan, tradeoffs, budget_ids, period_keys, expires_at, created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'held',$14,$15,$16::uuid[],$17::text[],$18,$19) returning *`,
      [rid, ctx.tenantId, ctx.projectId, q.idempotencyKey, ctx.actor.id, ctx.actor.kind, category, unit, amount, subject, lane, objective, run, plan?.name ?? null, plan?.tradeoffs ?? null, budgets.map((b) => b.id), keys, expiresAt.toISOString(), ctx.now]))[0]!;
    await enqueueJob(sql, S, ctx, { kind: 'resources.expire_reservation', payload: { reservationId: rid }, dedupeKey: rid, runAt: expiresAt });
    t.event('resources.budget_reserved', ref('reservation', rid), { reservationId: rid, category, unit, amount, subject, budgetIds: budgets.map((b) => b.id), ...(plan === null ? {} : { plan: plan.name }) });
    t.audit('budget.reserved', ref('reservation', rid), { category, unit, amount, subject });
    return norm<Reservation>(row);
  }
  /** Runs a reservation attempt; a denial is recorded (incident + one event per budget period) after the failed transaction rolled back. */
  async function guarded<T>(ctx: ServiceContext, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (error) {
      if (!(error instanceof Denied)) throw error;
      const { reason, budgetId, periodKey: key, detail } = error.info;
      const subject = budgetId === null ? ref('unbudgeted_actor', createHash('sha256').update(ctx.actor.id).digest('hex').slice(0, 24)) : ref('budget', budgetId);
      await d.run(ctx, 'deny', undefined, null, async (t) => {
        const first = await incident(t, reason === 'ceiling' ? 'exhausted' : reason, `${budgetId ?? ctx.actor.id}:${key}:${(detail as { unit: string }).unit}`, budgetId, subject, { reason, ...(detail as object) });
        if (first) t.event('resources.budget_exhausted', subject, { reason, budgetId, periodKey: key, ...(detail as object) });
      });
      throw new DomainError('budget_exhausted', error.message);
    }
  }

  async function commitIn(t: Tx, reservationId: string, amount: number, detail: Json): Promise<void> {
    const { ctx, sql } = t;
    const r = (await sql.query<Record<string, unknown> & { state: string; amount: string; actual: string | null; budget_ids: string[]; period_keys: string[] }>(
      `select * from ${S}.reservations where id=$1 and tenant_id=$2 and project_id=$3 for update`, [id(reservationId), ...scope(ctx)]))[0];
    invariant(r !== undefined, 'not_found', 'Not found');
    if (r.state === 'committed') { invariant(num(r.actual) === amount, 'invalid_state', 'Reservation was already committed with a different amount'); return; }
    invariant(r.state !== 'released', 'invalid_state', 'Reservation was released');
    const reservedAmount = num(r.amount); const over = amount - reservedAmount; const late = r.state === 'expired';
    const budgets = await sql.query<BRow>(`select * from ${S}.budgets where id = any($1::uuid[]) order by id for update`, [r.budget_ids]);
    const flagged: BRow[] = [];
    for (const b of budgets) {
      const key = r.period_keys[r.budget_ids.indexOf(b.id)]!;
      await sql.query(`update ${S}.budget_periods set reserved = greatest(reserved - $3, 0), committed = committed + $4 where budget_id=$1 and period_key=$2`, [b.id, key, late ? 0 : reservedAmount, amount]);
      await warn(t, b, key);
      if (over > Math.floor((reservedAmount * b.overage_tolerance_bps) / 10000)) flagged.push(b);
    }
    await sql.query(`update ${S}.reservations set state='committed', actual=$2, detail=$3::jsonb, settled_at=$4 where id=$1`, [r.id, amount, JSON.stringify(detail), ctx.now]);
    t.event('resources.budget_committed', ref('reservation', r.id as string), { reservationId: r.id as string, reserved: reservedAmount, actual: amount, unit: r.unit as string, late });
    t.audit('budget.committed', ref('reservation', r.id as string), { reserved: reservedAmount, actual: amount, late });
    if (flagged.length > 0) {
      // Beyond tolerance: the work happened, so it is accounted; the overage is an incident and the most specific budget is frozen.
      const deepest = Math.max(...flagged.map((b) => b.depth));
      for (const b of flagged) {
        const key = r.period_keys[r.budget_ids.indexOf(b.id)]!; const p = await periodRow(sql, b, key);
        const exceeded = p.reserved + p.committed > num(b.ceiling);
        if (b.depth !== deepest && !exceeded) continue;
        const info = { reservationId: r.id as string, reserved: reservedAmount, actual: amount, overage: over, toleranceBps: b.overage_tolerance_bps, ceilingExceeded: exceeded };
        await incident(t, 'overage', `${b.id}:${r.id as string}`, b.id, ref('budget', b.id), info);
        t.event('resources.budget_exceeded', ref('budget', b.id), { budgetId: b.id, ...info });
        await freeze(t, b, `overage beyond tolerance on reservation ${r.id as string}`);
      }
    }
  }

  const svc = {
    // ───────────── BudgetPort ─────────────
    /** Throws DomainError('budget_exhausted') BEFORE the caller's side effect when any applicable ceiling would be exceeded. */
    async reserve(ctx: ServiceContext, request: ReserveRequest): Promise<{ reservationId: string }> {
      cap(ctx, 'spend');
      str(request?.idempotencyKey, 'idempotencyKey', 150);
      return guarded(ctx, () => d.run(ctx, 'reserve', request.idempotencyKey, request, async (t) => ({ reservationId: (await reserveIn(t, request, null)).id })));
    },
    async commit(ctx: ServiceContext, reservationId: string, actual: { amount: number; detail?: Json }): Promise<void> {
      cap(ctx, 'spend');
      const amount = int(actual?.amount, 'actual.amount', 0);
      await d.run(ctx, 'commit', undefined, null, (t) => commitIn(t, reservationId, amount, actual.detail ?? null));
    },
    async release(ctx: ServiceContext, reservationId: string, reason: string): Promise<void> {
      cap(ctx, 'spend');
      str(reason, 'reason', 500);
      await d.run(ctx, 'release', undefined, null, async (t) => {
        const r = (await t.sql.query<Record<string, unknown> & { state: string; amount: string; budget_ids: string[]; period_keys: string[] }>(`select * from ${S}.reservations where id=$1 and tenant_id=$2 and project_id=$3 for update`, [id(reservationId), ...scope(ctx)]))[0];
        invariant(r !== undefined, 'not_found', 'Not found');
        if (r.state === 'released' || r.state === 'expired') return;
        invariant(r.state === 'held', 'invalid_state', 'A committed reservation cannot be released');
        await t.sql.query(`select id from ${S}.budgets where id = any($1::uuid[]) order by id for update`, [r.budget_ids]);
        for (const [i, b] of r.budget_ids.entries()) await t.sql.query(`update ${S}.budget_periods set reserved = greatest(reserved - $3, 0) where budget_id=$1 and period_key=$2`, [b, r.period_keys[i], r.amount]);
        await t.sql.query(`update ${S}.reservations set state='released', reason=$2, settled_at=$3 where id=$1`, [r.id, reason, ctx.now]);
        t.event('resources.budget_released', ref('reservation', r.id as string), { reservationId: r.id as string, amount: num(r.amount), unit: r.unit as string });
        t.audit('budget.released', ref('reservation', r.id as string), { reason });
      });
    },
    /**
     * Graceful degradation: tries the preferred amount, then previously human-authorized smaller plans (largest first).
     * The chosen plan and its tradeoffs are returned and recorded; if nothing fits the caller receives budget_exhausted and pauses.
     */
    async reserveWithPlans(ctx: ServiceContext, request: ReserveRequest): Promise<{ reservationId: string; plan: string; amount: number; tradeoffs: string | null; skipped: { plan: string; amount: number }[] }> {
      cap(ctx, 'spend');
      str(request?.idempotencyKey, 'idempotencyKey', 150);
      const unit = unitOf(request.unit);
      const plans = await d.sql.query<{ name: string; amount: string; tradeoffs: string }>(`select name, amount, tradeoffs from ${S}.fallback_plans where tenant_id=$1 and project_id=$2 and category=$3 and unit=$4 and (subject is null or subject=$5) and revoked_at is null and amount < $6 order by amount desc`,
        [...scope(ctx), request.category, unit, request.subject, request.amount]);
      return guarded(ctx, () => d.run(ctx, 'reserve', request.idempotencyKey, request, async (t) => {
        const skipped: { plan: string; amount: number }[] = [];
        const options: { name: string; amount: number; tradeoffs: string | null }[] = [{ name: 'preferred', amount: request.amount, tradeoffs: null }, ...plans.map((p) => ({ name: p.name, amount: num(p.amount), tradeoffs: p.tradeoffs }))];
        let last: Denied | undefined;
        for (const o of options) {
          try {
            const r = await t.sql.tx((sp) => reserveIn({ ...t, sql: sp }, { ...request, amount: o.amount }, o.tradeoffs === null ? null : { name: o.name, tradeoffs: o.tradeoffs }));
            if (o.tradeoffs !== null) t.event('resources.budget_plan_downgraded', ref('reservation', r.id), { reservationId: r.id, plan: o.name, amount: o.amount, tradeoffs: o.tradeoffs, skipped });
            return { reservationId: r.id, plan: o.name, amount: o.amount, tradeoffs: o.tradeoffs, skipped };
          } catch (error) {
            if (!(error instanceof Denied) || error.info.reason !== 'ceiling') throw error;
            last = error; skipped.push({ plan: o.name, amount: o.amount });
          }
        }
        throw last as Denied;
      }));
    },
    async authorizeFallbackPlan(ctx: ServiceContext, input: { category: string; unit: string; name: string; amount: number; tradeoffs: string; subject?: string }): Promise<{ id: string }> {
      humanWith(ctx, 'approve'); assertNoFactualLinkage(input, 'budget');
      return d.run(ctx, 'plan', undefined, null, async (t) => {
        const pid = randomUUID();
        const r = await t.sql.query<{ id: string }>(`insert into ${S}.fallback_plans (id, tenant_id, project_id, category, subject, unit, name, amount, tradeoffs, authorized_by, authorized_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          on conflict (tenant_id, project_id, category, unit, name) do update set amount=excluded.amount, tradeoffs=excluded.tradeoffs, subject=excluded.subject, authorized_by=excluded.authorized_by, authorized_at=excluded.authorized_at, revoked_at=null returning id`,
          [pid, ...scope(ctx), str(input.category, 'category', 100), optStr(input.subject, 'subject', 500), unitOf(input.unit), str(input.name, 'name', 100), int(input.amount, 'amount', 1), str(input.tradeoffs, 'tradeoffs'), ctx.actor.id, ctx.now]);
        t.audit('budget.fallback_plan_authorized', ref('fallback_plan', r[0]!.id), { category: input.category, name: input.name, amount: input.amount });
        return { id: r[0]!.id };
      });
    },
    async getReservation(ctx: ServiceContext, reservationId: string): Promise<Reservation> {
      cap(ctx, 'read');
      const r = await d.sql.query(`select * from ${S}.reservations where id=$1 and tenant_id=$2 and project_id=$3`, [id(reservationId), ...scope(ctx)]);
      invariant(r[0] !== undefined, 'not_found', 'Not found');
      return norm<Reservation>(r[0]);
    },
    async listReservations(ctx: ServiceContext, o: { state?: string; limit?: number } = {}): Promise<Reservation[]> {
      cap(ctx, 'read');
      return norms<Reservation>(await d.sql.query(`select * from ${S}.reservations where tenant_id=$1 and project_id=$2 and ($3::text is null or state=$3) order by created_at desc limit ${limitOf(o.limit)}`, [...scope(ctx), o.state ?? null]));
    },
    /** Operator sweep; the per-reservation kit job does the same automatically. */
    async expireReservations(ctx: ServiceContext): Promise<{ expired: number }> {
      cap(ctx, 'spend');
      return d.run(ctx, 'expire', undefined, null, async (t) => ({ expired: await expireRows(t.sql, `expires_at <= $1 and tenant_id=$2 and project_id=$3`, [ctx.now, ...scope(ctx)], expiredEvent(t)) }));
    },
    /** Job handler body: uses the database clock, so a reservation is never expired early. */
    async expireReservationJob(ctx: ServiceContext, reservationId: string): Promise<Json> {
      return d.run(ctx, 'expire', undefined, null, async (t) => ({ expired: await expireRows(t.sql, `expires_at <= now() and id=$1 and tenant_id=$2 and project_id=$3`, [reservationId, ...scope(ctx)], expiredEvent(t)) }));
    },

    // ───────────── Budget definitions ─────────────
    async createBudget(ctx: ServiceContext, input: { name: string; level: Budget['level']; unit: string; ceiling: number; period?: Budget['period']; parentId?: string; categories?: string[]; actorId?: string; lane?: string; objective?: string; run?: string; warnBps?: number[]; overageToleranceBps?: number; idempotencyKey?: string }): Promise<Budget> {
      cap(ctx, 'admin'); assertNoFactualLinkage(input, 'budget');
      const level = input.level; invariant(['organization', 'project', 'objective', 'run', 'agent', 'lane'].includes(level), 'invalid_input', 'Unknown budget level');
      const unit = unitOf(input.unit); const period = input.period ?? 'one_off'; invariant(period === 'one_off' || period === 'monthly', 'invalid_input', 'Unknown period');
      const warn_ = (input.warnBps ?? [8000]).map((w) => int(w, 'warnBps', 1, 10000)).sort((a, b) => a - b);
      return d.run(ctx, 'budget.create', input.idempotencyKey, input, async (t) => {
        const parent = input.parentId === undefined ? null : await getBudgetRow(t.sql, ctx, input.parentId);
        if (parent !== null) invariant(parent.unit === unit && parent.state !== 'closed', 'invalid_input', 'Parent budget must be open and use the same unit');
        invariant((level === 'organization') === (parent === null && level === 'organization') && (level !== 'organization' || parent === null), 'invalid_input', 'Organization budgets have no parent');
        // A child narrows its parent: it inherits every selector the parent fixes and may not contradict it.
        const pick = (own: string | null, k: string): string | null => {
          const inherited = (parent?.[k] ?? null) as string | null;
          invariant(inherited === null || own === null || own === inherited, 'invalid_input', `Child budget cannot change the parent's ${k}`);
          return own ?? inherited;
        };
        const actorId = pick(optStr(input.actorId, 'actorId', 200), 'actor_id'), lane = pick(optStr(input.lane, 'lane', 100), 'lane');
        const objective = pick(optStr(input.objective, 'objective', 500), 'objective'), run = pick(optStr(input.run, 'run', 500), 'run');
        const categories = input.categories === undefined ? ((parent?.categories ?? null) as string[] | null) : strings(input.categories, 'categories');
        if (level === 'agent') invariant(actorId !== null, 'invalid_input', 'Agent budgets require actorId');
        if (level === 'lane') invariant(lane !== null, 'invalid_input', 'Lane budgets require lane');
        if (level === 'objective') invariant(objective !== null, 'invalid_input', 'Objective budgets require objective');
        if (level === 'run') invariant(run !== null, 'invalid_input', 'Run budgets require run');
        const row = (await t.sql.query(`insert into ${S}.budgets (id, tenant_id, project_id, parent_id, level, depth, name, unit, categories, actor_id, lane, objective, run, period, ceiling, warn_bps, overage_tolerance_bps, created_by, created_at, updated_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::int[],$17,$18,$19,$19) returning *`,
          [randomUUID(), ctx.tenantId, level === 'organization' ? ORG : ctx.projectId, parent?.id ?? null, level, parent === null ? 0 : parent.depth + 1, str(input.name, 'name', 200), unit, categories, actorId, lane, objective, run, period,
            int(input.ceiling, 'ceiling', 0), warn_, int(input.overageToleranceBps ?? d.cfg.defaultOverageToleranceBps, 'overageToleranceBps', 0, 10000), ctx.actor.id, ctx.now]))[0]!;
        const b = norm<Budget>(row);
        t.event('resources.budget_created', ref('budget', b.id), { budgetId: b.id, level, unit, ceiling: b.ceiling });
        t.audit('budget.created', ref('budget', b.id), { name: b.name, level, unit, ceiling: b.ceiling, period, actorId, lane });
        return b;
      });
    },
    async updateBudget(ctx: ServiceContext, budgetId: string, patch: { name?: string; ceiling?: number; warnBps?: number[]; overageToleranceBps?: number; expectedRevision?: number }): Promise<Budget> {
      cap(ctx, 'admin');
      return d.run(ctx, 'budget.update', undefined, null, async (t) => {
        const b = await getBudgetRow(t.sql, ctx, budgetId, true);
        if (patch.expectedRevision !== undefined) invariant(patch.expectedRevision === b.revision, 'revision_conflict', 'Budget was changed by someone else');
        invariant(b.state !== 'closed', 'invalid_state', 'Budget is closed');
        const row = (await t.sql.query(`update ${S}.budgets set name=$2, ceiling=$3, warn_bps=$4::int[], overage_tolerance_bps=$5, revision=revision+1, updated_at=$6 where id=$1 returning *`,
          [b.id, patch.name === undefined ? b.name : str(patch.name, 'name', 200), patch.ceiling === undefined ? b.ceiling : int(patch.ceiling, 'ceiling', 0),
            patch.warnBps === undefined ? b.warn_bps : patch.warnBps.map((w) => int(w, 'warnBps', 1, 10000)), patch.overageToleranceBps === undefined ? b.overage_tolerance_bps : int(patch.overageToleranceBps, 'overageToleranceBps', 0, 10000), ctx.now]))[0]!;
        t.audit('budget.updated', ref('budget', b.id), { before: { ceiling: num(b.ceiling), warnBps: b.warn_bps }, after: { ceiling: num(row.ceiling), warnBps: row.warn_bps as number[] } });
        t.event('resources.budget_updated', ref('budget', b.id), { budgetId: b.id, ceiling: num(row.ceiling) });
        return norm<Budget>(row);
      });
    },
    /** freeze | unfreeze | close. Human with resources:approve only: an agent can never lift its own freeze. */
    async setBudgetState(ctx: ServiceContext, budgetId: string, action: 'freeze' | 'unfreeze' | 'close', reason: string): Promise<Budget> {
      humanWith(ctx, 'approve'); str(reason, 'reason', 500);
      return d.run(ctx, 'budget.state', undefined, null, async (t) => {
        const b = await getBudgetRow(t.sql, ctx, budgetId, true);
        if (action === 'freeze') { invariant(b.state === 'active', 'invalid_state', `Budget is ${b.state}`); await freeze(t, b, reason); }
        else {
          invariant(action === 'close' ? b.state !== 'closed' : b.state === 'frozen', 'invalid_state', `Budget is ${b.state}`);
          await t.sql.query(`update ${S}.budgets set state=$2, state_reason=$3, revision=revision+1, updated_at=$4 where id=$1`, [b.id, action === 'close' ? 'closed' : 'active', reason, ctx.now]);
          if (action === 'unfreeze') await t.sql.query(`update ${S}.incidents set resolved_at=$2, resolved_by=$3 where budget_id=$1 and resolved_at is null`, [b.id, ctx.now, ctx.actor.id]);
          t.event(action === 'close' ? 'resources.budget_closed' : 'resources.budget_unfrozen', ref('budget', b.id), { budgetId: b.id, reason });
          t.audit(`budget.${action === 'close' ? 'closed' : 'unfrozen'}`, ref('budget', b.id), { reason });
        }
        return norm<Budget>((await t.sql.query(`select * from ${S}.budgets where id=$1`, [b.id]))[0]!);
      });
    },
    /** Explicitly lets an actor draw from a budget (required for agents and services), or revokes that. */
    async assignBudget(ctx: ServiceContext, budgetId: string, actorId: string, assigned = true): Promise<void> {
      cap(ctx, 'admin'); str(actorId, 'actorId', 200);
      await d.run(ctx, 'budget.assign', undefined, null, async (t) => {
        const b = await getBudgetRow(t.sql, ctx, budgetId, true);
        if (assigned) await t.sql.query(`insert into ${S}.budget_assignments (budget_id, actor_id, tenant_id, project_id, assigned_by, assigned_at) values ($1,$2,$3,$4,$5,$6) on conflict (budget_id, actor_id) do update set revoked_at=null, assigned_by=excluded.assigned_by, assigned_at=excluded.assigned_at`, [b.id, actorId, b.tenant_id, b.project_id, ctx.actor.id, ctx.now]);
        else await t.sql.query(`update ${S}.budget_assignments set revoked_at=$3 where budget_id=$1 and actor_id=$2 and revoked_at is null`, [b.id, actorId, ctx.now]);
        t.audit(assigned ? 'budget.assigned' : 'budget.unassigned', ref('budget', b.id), { actorId });
      });
    },
    async getBudget(ctx: ServiceContext, budgetId: string): Promise<Budget> { cap(ctx, 'read'); return norm<Budget>(await getBudgetRow(d.sql, ctx, budgetId)); },
    /** Operator view: every budget visible to the project (including organization budgets) with the current period's position. */
    async budgetTree(ctx: ServiceContext): Promise<BudgetNode[]> {
      cap(ctx, 'read');
      const rows = await d.sql.query(`select * from ${S}.budgets where tenant_id=$1 and project_id in ($2,'${ORG}') order by depth, created_at, id`, scope(ctx));
      const periods = await d.sql.query<{ budget_id: string; period_key: string; reserved: string; committed: string }>(`select budget_id, period_key, reserved, committed from ${S}.budget_periods where tenant_id=$1 and project_id in ($2,'${ORG}')`, scope(ctx));
      const assigned = await d.sql.query<{ budget_id: string; actor_id: string }>(`select budget_id, actor_id from ${S}.budget_assignments where tenant_id=$1 and project_id in ($2,'${ORG}') and revoked_at is null`, scope(ctx));
      const nodes = new Map<string, BudgetNode & { children: BudgetNode[] }>();
      const now = new Date(ctx.now);
      for (const row of rows) {
        const b = norm<Budget>(row); const key = periodKey(b.period, ctx.now);
        const p = periods.find((x) => x.budget_id === b.id && x.period_key === key);
        const reserved = p === undefined ? 0 : num(p.reserved), committed = p === undefined ? 0 : num(p.committed);
        let forecast: BudgetNode['forecast'] = null;
        if (b.period === 'monthly') {
          const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
          const projected = Math.round((committed * (end - start)) / Math.max(now.getTime() - start, 3_600_000));
          forecast = { method: 'linear_projection', projected, exceedsCeiling: projected > b.ceiling };
        }
        nodes.set(b.id, { ...b, periodKey: key, reserved, committed, available: Math.max(b.ceiling - reserved - committed, 0), usedBps: bps(reserved + committed, b.ceiling), forecast, assignedActors: assigned.filter((a) => a.budget_id === b.id).map((a) => a.actor_id), children: [] });
      }
      const roots: BudgetNode[] = [];
      for (const n of nodes.values()) { const parent = n.parentId === null ? undefined : nodes.get(n.parentId); if (parent === undefined) roots.push(n); else parent.children.push(n); }
      return roots;
    },
    /** Committed amounts over time (burn), per unit, optionally for one budget. */
    async burn(ctx: ServiceContext, o: { budgetId?: string; unit?: string; bucket?: 'hour' | 'day' | 'month'; from?: string; to?: string } = {}): Promise<{ bucket: string; unit: string; committed: number; reservations: number }[]> {
      cap(ctx, 'read');
      const bucket = o.bucket ?? 'day'; invariant(['hour', 'day', 'month'].includes(bucket), 'invalid_input', 'Unknown bucket');
      const rows = await d.sql.query<{ bucket: Date; unit: string; committed: string; n: string }>(`select date_trunc('${bucket}', settled_at at time zone 'UTC') at time zone 'UTC' as bucket, unit, sum(actual) as committed, count(*) as n from ${S}.reservations
        where tenant_id=$1 and project_id=$2 and state='committed' and ($3::uuid is null or $3 = any(budget_ids)) and ($4::text is null or unit=$4) and ($5::timestamptz is null or settled_at >= $5) and ($6::timestamptz is null or settled_at < $6) group by 1,2 order by 1,2`,
        [...scope(ctx), o.budgetId === undefined ? null : id(o.budgetId), o.unit === undefined ? null : unitOf(o.unit), o.from ?? null, o.to ?? null]);
      return rows.map((r) => ({ bucket: new Date(r.bucket).toISOString(), unit: r.unit, committed: num(r.committed), reservations: num(r.n) }));
    },
    async listIncidents(ctx: ServiceContext, o: { kind?: string; open?: boolean; limit?: number } = {}): Promise<Record<string, unknown>[]> {
      cap(ctx, 'read');
      return norms(await d.sql.query(`select * from ${S}.incidents where tenant_id=$1 and project_id=$2 and ($3::text is null or kind=$3) and ($4::boolean is null or (resolved_at is null) = $4) order by last_at desc limit ${limitOf(o.limit)}`, [...scope(ctx), o.kind ?? null, o.open ?? null]));
    },

    // ───────────── Rate card and usage metering ─────────────
    /** Deployment-maintained unit prices with effective dates. `pricePerMillion` is minor currency units per 1,000,000 meter units. */
    async setRate(ctx: ServiceContext, input: { provider: string; model?: string; meter: Meter; currency: string; pricePerMillion: number; effectiveFrom: string; note?: string; organizationWide?: boolean }): Promise<Record<string, unknown>> {
      cap(ctx, 'admin');
      invariant((METERS as readonly string[]).includes(input.meter), 'invalid_input', 'Unknown meter');
      invariant(/^[A-Z]{3}$/.test(input.currency), 'invalid_input', 'Currency must be an ISO 4217 code');
      return d.run(ctx, 'rate', undefined, null, async (t) => {
        const row = (await t.sql.query(`insert into ${S}.rates (id, tenant_id, project_id, provider, model, meter, currency, price_per_million, effective_from, note, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
          [randomUUID(), ctx.tenantId, input.organizationWide === true ? ORG : ctx.projectId, str(input.provider, 'provider', 100), input.model === undefined ? '*' : str(input.model, 'model', 200), input.meter, input.currency, int(input.pricePerMillion, 'pricePerMillion', 0), time(input.effectiveFrom, 'effectiveFrom'), optStr(input.note, 'note'), ctx.actor.id, ctx.now]).catch((e: unknown) => { if ((e as { code?: string }).code === '23505') throw new DomainError('conflict', 'A rate with this effective date already exists; rates are never rewritten'); throw e; }))[0]!;
        t.audit('rate.set', ref('rate', row.id as string), { provider: input.provider, model: input.model ?? '*', meter: input.meter, pricePerMillion: input.pricePerMillion, effectiveFrom: input.effectiveFrom });
        return norm(row);
      });
    },
    async listRates(ctx: ServiceContext): Promise<Record<string, unknown>[]> {
      cap(ctx, 'read');
      return norms(await d.sql.query(`select * from ${S}.rates where tenant_id=$1 and project_id in ($2,'${ORG}') order by provider, model, meter, effective_from desc`, scope(ctx)));
    },
    /**
     * Records actual usage (model/provider call, processing, rendering, storage, messaging). Cost comes from the rate card in force
     * at `occurredAt`, or from an explicitly declared provider-billed cost. Unpriced meters are reported as unpriced, never guessed.
     * With `reservationId` the reservation is committed in the same transaction with the actual quantity in the reservation's unit.
     */
    async recordUsage(ctx: ServiceContext, input: { kind: 'model_call' | 'processing' | 'rendering' | 'storage' | 'messaging' | 'other'; provider: string; model?: string; quantities: Partial<Record<Meter, number>>; cost?: { amountMinor: number; currency: string }; lane?: string; objective?: string; subject: string; workRef?: string; occurredAt?: string; reservationId?: string; idempotencyKey: string }): Promise<Record<string, unknown>> {
      cap(ctx, 'write'); if (input.reservationId !== undefined) cap(ctx, 'spend');
      if (input.workRef !== undefined) assertNoFactualLinkage(input.workRef, 'commercial', 'workRef');
      const model = input.model === undefined ? '*' : str(input.model, 'model', 200); const provider = str(input.provider, 'provider', 100);
      const at = input.occurredAt === undefined ? ctx.now : time(input.occurredAt, 'occurredAt');
      const quantities: Record<string, number> = {};
      for (const [k, v] of Object.entries(input.quantities ?? {})) { invariant((METERS as readonly string[]).includes(k), 'invalid_input', `Unknown meter ${k}`); quantities[k] = int(v, k, 0); }
      return d.run(ctx, 'usage', str(input.idempotencyKey, 'idempotencyKey', 150), input, async (t) => {
        let cur: string | null = null, micro: number | null = null, source = 'unpriced'; const unpriced: string[] = [], rateIds: string[] = [];
        if (input.cost !== undefined) {
          invariant(/^[A-Z]{3}$/.test(input.cost.currency), 'invalid_input', 'Currency must be an ISO 4217 code');
          cur = input.cost.currency; micro = int(input.cost.amountMinor, 'cost.amountMinor', 0) * 1_000_000; source = 'declared';
        } else {
          for (const [meter, qty] of Object.entries(quantities)) {
            if (qty === 0) continue;
            const rate = (await t.sql.query<{ id: string; currency: string; price_per_million: string }>(`select id, currency, price_per_million from ${S}.rates where tenant_id=$1 and project_id in ($2,'${ORG}') and provider=$3 and model in ($4,'*') and meter=$5 and effective_from <= $6
              order by (project_id = $2) desc, (model = $4) desc, effective_from desc limit 1`, [...scope(ctx), provider, model, meter, at]))[0];
            if (rate === undefined) { unpriced.push(meter); continue; }
            invariant(cur === null || cur === rate.currency, 'invalid_state', 'Rate card mixes currencies for one usage record');
            cur = rate.currency; micro = num((micro ?? 0) + qty * num(rate.price_per_million)); rateIds.push(rate.id); source = 'rate_card';
          }
        }
        const uid = randomUUID();
        const row = (await t.sql.query(`insert into ${S}.usage (id, tenant_id, project_id, idempotency_key, kind, provider, model, actor_id, actor_kind, lane, objective, subject, work_ref, quantities, currency, cost_micro, cost_source, unpriced_meters, rate_ids, reservation_id, occurred_at, recorded_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18::text[],$19::uuid[],$20,$21,$22) returning *`,
          [uid, ...scope(ctx), input.idempotencyKey, input.kind, provider, model, ctx.actor.id, ctx.actor.kind, optStr(input.lane, 'lane', 100), optStr(input.objective, 'objective', 500), str(input.subject, 'subject', 500), input.workRef ?? null,
            JSON.stringify(quantities), cur, micro, source, unpriced, rateIds, input.reservationId === undefined ? null : id(input.reservationId), at, ctx.now]).catch((e: unknown) => { if ((e as { code?: string }).code === '23514') throw new DomainError('invalid_input', 'Unknown usage kind or rejected reference'); throw e; }))[0]!;
        if (input.reservationId !== undefined) {
          const r = (await t.sql.query<{ unit: string }>(`select unit from ${S}.reservations where id=$1 and tenant_id=$2 and project_id=$3`, [id(input.reservationId), ...scope(ctx)]))[0];
          invariant(r !== undefined, 'not_found', 'Not found');
          let actual: number;
          if (r.unit.startsWith('money:')) { invariant(micro !== null && cur === r.unit.slice(6) && unpriced.length === 0, 'invalid_state', 'Usage cost is unpriced or in another currency; commit the reservation explicitly'); actual = Math.ceil(micro / 1_000_000); }
          else actual = quantities[r.unit] ?? 0;
          await commitIn(t, input.reservationId, actual, { usageId: uid });
        }
        t.event('resources.usage_recorded', ref('usage', uid), { usageId: uid, kind: input.kind, provider, model, costSource: source });
        return { ...norm(row), costMinor: micro === null ? null : microToMinor(micro) };
      });
    },
    /** Usage grouped for operators. Costs are per currency; unpriced records are counted, not hidden. */
    async usageReport(ctx: ServiceContext, o: { groupBy?: 'provider' | 'model' | 'actor' | 'lane' | 'kind' | 'work' | 'subject'; from?: string; to?: string; limit?: number } = {}): Promise<Record<string, unknown>[]> {
      cap(ctx, 'read');
      const cols: Record<string, string> = { provider: 'provider', model: `provider || '/' || model`, actor: 'actor_id', lane: `coalesce(lane, '(none)')`, kind: 'kind', work: `coalesce(work_ref, '(none)')`, subject: 'subject' };
      const col = cols[o.groupBy ?? 'provider']; invariant(col !== undefined, 'invalid_input', 'Unknown grouping');
      const rows = await d.sql.query<Record<string, string | null>>(`select ${col} as key, coalesce(currency, '') as currency, count(*) as records, count(*) filter (where cost_source = 'unpriced' or cardinality(unpriced_meters) > 0) as unpriced,
        coalesce(sum(cost_micro),0) as cost_micro, ${METERS.map((m) => `coalesce(sum((quantities->>'${m}')::bigint),0) as ${m}`).join(', ')}
        from ${S}.usage where tenant_id=$1 and project_id=$2 and ($3::timestamptz is null or occurred_at >= $3) and ($4::timestamptz is null or occurred_at < $4) group by 1,2 order by sum(cost_micro) desc nulls last, 1 limit ${limitOf(o.limit)}`, [...scope(ctx), o.from ?? null, o.to ?? null]);
      return rows.map((r) => ({ key: r.key, currency: r.currency === '' ? null : r.currency, records: num(r.records), unpricedRecords: num(r.unpriced), costMinor: microToMinor(num(r.cost_micro)), ...Object.fromEntries(METERS.map((m) => [m.replace(/_([a-z])/g, (_x, c: string) => c.toUpperCase()), num(r[m])])) }));
    },
    async topCosts(ctx: ServiceContext, o: { from?: string; to?: string; limit?: number } = {}): Promise<Record<string, unknown>[]> {
      cap(ctx, 'read');
      return (await d.sql.query(`select id, kind, provider, model, actor_id, lane, subject, work_ref, currency, cost_micro, quantities, occurred_at from ${S}.usage where tenant_id=$1 and project_id=$2 and cost_micro is not null and ($3::timestamptz is null or occurred_at >= $3) and ($4::timestamptz is null or occurred_at < $4) order by cost_micro desc limit ${limitOf(o.limit, 20, 200)}`, [...scope(ctx), o.from ?? null, o.to ?? null]))
        .map((r) => { const n = norm<Record<string, unknown>>(r); return { ...n, costMinor: microToMinor(n.costMicro as number) }; });
    },

    // ───────────── Work allocation and research lanes ─────────────
    /**
     * Lane policy is deployment configuration: lane keys, names, target effort shares and free-form reviewed configuration
     * (for example a reviewed comparison selection). Code never chooses lanes. Targets are shares of EFFORT only.
     */
    async setLanePolicy(ctx: ServiceContext, input: { allocation: 'equal' | 'explicit'; lanes: { key: string; name: string; targetShareBps?: number; configuration?: Json }[]; measure?: 'active_seconds' | 'attempts' | 'tokens' | 'compute_seconds'; driftToleranceBps?: number; note?: string; idempotencyKey?: string }): Promise<Record<string, unknown>> {
      cap(ctx, 'admin'); assertNoFactualLinkage(input, 'budget');
      invariant(Array.isArray(input.lanes) && input.lanes.length >= 1 && input.lanes.length <= 50, 'invalid_input', 'Between 1 and 50 lanes are required');
      invariant(input.allocation === 'equal' || input.allocation === 'explicit', 'invalid_input', 'Unknown allocation');
      const measure = input.measure ?? 'active_seconds'; invariant(['active_seconds', 'attempts', 'tokens', 'compute_seconds'].includes(measure), 'invalid_input', 'Unknown measure');
      const n = input.lanes.length;
      const lanes = input.lanes.map((l, i) => ({ key: str(l.key, 'lane key', 100), name: str(l.name, 'lane name', 200), configuration: l.configuration ?? null,
        targetShareBps: input.allocation === 'equal' ? Math.floor(10000 / n) + (i < 10000 % n ? 1 : 0) : int(l.targetShareBps, 'targetShareBps', 0, 10000) }));
      try { allocateCost(10000, lanes.map((l) => ({ projectId: l.key, units: l.targetShareBps }))); } // reused legacy validator: unique keys, shares sum exactly
      catch (e) { throw new DomainError('invalid_input', `Lane target shares must be unique per lane and total 10000 basis points (${(e as Error).message})`); }
      return d.run(ctx, 'lanes', input.idempotencyKey, input, async (t) => {
        await t.sql.query('select pg_advisory_xact_lock(hashtext($1))', [`e13-lanes:${ctx.tenantId}:${ctx.projectId}`]);
        const v = num((await t.sql.query<{ v: string }>(`select coalesce(max(version),0)+1 as v from ${S}.lane_policies where tenant_id=$1 and project_id=$2`, scope(ctx)))[0]!.v);
        const row = (await t.sql.query(`insert into ${S}.lane_policies (id, tenant_id, project_id, version, allocation, measure, drift_tolerance_bps, lanes, note, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) returning *`,
          [randomUUID(), ...scope(ctx), v, input.allocation, measure, int(input.driftToleranceBps ?? d.cfg.laneDriftToleranceBps, 'driftToleranceBps', 0, 10000), JSON.stringify(lanes), optStr(input.note, 'note'), ctx.actor.id, ctx.now]))[0]!;
        t.event('resources.lane_policy_set', ref('lane_policy', row.id as string), { version: v, allocation: input.allocation, lanes: lanes.map((l) => l.key) });
        t.audit('lanes.policy_set', ref('lane_policy', row.id as string), { version: v, allocation: input.allocation, lanes: lanes.map((l) => ({ key: l.key, targetShareBps: l.targetShareBps })) });
        return norm(row);
      });
    },
    async getLanePolicy(ctx: ServiceContext): Promise<Record<string, unknown> | null> {
      cap(ctx, 'read');
      const r = await d.sql.query(`select * from ${S}.lane_policies where tenant_id=$1 and project_id=$2 order by version desc limit 1`, scope(ctx));
      return r[0] === undefined ? null : norm(r[0]);
    },
    /** Records work actually performed. It carries effort only: who, which lane, which objective/task, when, active seconds, attempts. */
    async recordWork(ctx: ServiceContext, input: { lane: string; task: string; objective?: string; startedAt: string; endedAt: string; activeSeconds: number; attempts?: number; actorId?: string; actorKind?: 'human' | 'agent' | 'service'; idempotencyKey: string }): Promise<Record<string, unknown>> {
      cap(ctx, 'write');
      const allowed = ['lane', 'task', 'objective', 'startedAt', 'endedAt', 'activeSeconds', 'attempts', 'actorId', 'actorKind', 'idempotencyKey'];
      for (const k of Object.keys(input)) if (!allowed.includes(k)) throw new DomainError('invalid_incentive_linkage', `Work records carry effort only; field "${k}" is not accepted`);
      const started = time(input.startedAt, 'startedAt'), ended = time(input.endedAt, 'endedAt');
      invariant(Date.parse(ended) >= Date.parse(started), 'invalid_input', 'endedAt precedes startedAt');
      const active = int(input.activeSeconds, 'activeSeconds', 0); invariant(active <= Math.ceil((Date.parse(ended) - Date.parse(started)) / 1000), 'invalid_input', 'activeSeconds exceeds the elapsed interval');
      if (input.actorKind !== undefined) invariant(['human', 'agent', 'service'].includes(input.actorKind), 'invalid_input', 'Unknown actor kind');
      return d.run(ctx, 'work', str(input.idempotencyKey, 'idempotencyKey', 150), input, async (t) => {
        const row = (await t.sql.query(`insert into ${S}.work_records (id, tenant_id, project_id, actor_id, actor_kind, lane, objective, task, started_at, ended_at, active_seconds, attempts, recorded_by, recorded_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
          [randomUUID(), ...scope(ctx), input.actorId === undefined ? ctx.actor.id : str(input.actorId, 'actorId', 200), input.actorKind ?? ctx.actor.kind, str(input.lane, 'lane', 100), optStr(input.objective, 'objective', 500), str(input.task, 'task', 500), started, ended, active, int(input.attempts ?? 1, 'attempts', 0, 1_000_000), ctx.actor.id, ctx.now]))[0]!;
        t.event('resources.work_recorded', ref('work_record', row.id as string), { workRecordId: row.id as string, lane: input.lane, activeSeconds: active });
        return norm(row);
      });
    },
    /** Measured allocation of effort per lane against the policy's target shares, with drift. Contains no counts of conclusions. */
    async laneAllocationReport(ctx: ServiceContext, o: { from?: string; to?: string } = {}): Promise<LaneReport> {
      cap(ctx, 'read');
      const policy = (await d.sql.query<{ version: number; measure: string; drift_tolerance_bps: number; lanes: { key: string; name: string; targetShareBps: number }[] }>(`select version, measure, drift_tolerance_bps, lanes from ${S}.lane_policies where tenant_id=$1 and project_id=$2 order by version desc limit 1`, scope(ctx)))[0];
      const p = [...scope(ctx), o.from ?? null, o.to ?? null];
      const work = await d.sql.query<Record<string, string>>(`select lane, coalesce(sum(active_seconds),0) as active_seconds, coalesce(sum(attempts),0) as attempts, count(*) as work_records from ${S}.work_records where tenant_id=$1 and project_id=$2 and ($3::timestamptz is null or started_at >= $3) and ($4::timestamptz is null or started_at < $4) group by lane`, p);
      const usage = await d.sql.query<Record<string, string | null>>(`select coalesce(lane,'') as lane, coalesce(currency,'') as currency, coalesce(sum(cost_micro),0) as cost_micro, ${['tokens_in', 'tokens_out', 'compute_seconds', 'render_seconds'].map((m) => `coalesce(sum((quantities->>'${m}')::bigint),0) as ${m}`).join(', ')}
        from ${S}.usage where tenant_id=$1 and project_id=$2 and lane is not null and ($3::timestamptz is null or occurred_at >= $3) and ($4::timestamptz is null or occurred_at < $4) group by 1,2`, p);
      const configured = policy?.lanes ?? [];
      const keys = [...new Set([...configured.map((l) => l.key), ...work.map((w) => w.lane as string), ...usage.map((u) => u.lane as string)])];
      const raw = keys.map((key) => {
        const w = work.find((x) => x.lane === key); const us = usage.filter((x) => x.lane === key); const c = configured.find((l) => l.key === key);
        const sum = (m: string): number => us.reduce((a, x) => a + num(x[m]), 0);
        const cost: Record<string, number> = {}; for (const x of us) if (x.currency !== '') cost[x.currency as string] = microToMinor(num(x.cost_micro));
        return { key, name: c?.name ?? key, configured: c !== undefined, targetShareBps: c?.targetShareBps ?? 0, activeSeconds: w === undefined ? 0 : num(w.active_seconds), attempts: w === undefined ? 0 : num(w.attempts), workRecords: w === undefined ? 0 : num(w.work_records),
          tokensIn: sum('tokens_in'), tokensOut: sum('tokens_out'), computeSeconds: sum('compute_seconds'), renderSeconds: sum('render_seconds'), cost };
      });
      const measures: Record<string, (l: typeof raw[number]) => number> = { active_seconds: (l) => l.activeSeconds, attempts: (l) => l.attempts, tokens: (l) => l.tokensIn + l.tokensOut, compute_seconds: (l) => l.computeSeconds };
      const currencies = [...new Set(raw.flatMap((l) => Object.keys(l.cost)))];
      if (currencies.length === 1) measures.money = (l) => l.cost[currencies[0]!] ?? 0;
      const totals: Record<string, number> = {}; for (const [m, f] of Object.entries(measures)) totals[m] = raw.reduce((a, l) => a + f(l), 0);
      const measure = policy?.measure ?? 'active_seconds'; const tolerance = policy?.drift_tolerance_bps ?? d.cfg.laneDriftToleranceBps;
      const lanes = raw.map((l) => {
        const actualShareBps: Record<string, number> = {}; for (const [m, f] of Object.entries(measures)) actualShareBps[m] = bps(f(l), totals[m]!);
        const driftBps = (actualShareBps[measure] ?? 0) - l.targetShareBps;
        return { ...l, actualShareBps, driftBps, withinTolerance: Math.abs(driftBps) <= tolerance };
      });
      const measured = (totals[measure] ?? 0) > 0;
      return { policyVersion: policy?.version ?? null, measure, driftToleranceBps: tolerance, from: o.from ?? null, to: o.to ?? null, lanes, totals,
        maxAbsDriftBps: measured ? Math.max(0, ...lanes.map((l) => Math.abs(l.driftBps))) : 0, withinTolerance: !measured || lanes.every((l) => l.withinTolerance),
        underAllocated: measured ? lanes.filter((l) => l.driftBps < -tolerance).map((l) => l.key) : [], overAllocated: measured ? lanes.filter((l) => l.driftBps > tolerance).map((l) => l.key) : [] };
    },
    async listWork(ctx: ServiceContext, o: { lane?: string; limit?: number } = {}): Promise<Record<string, unknown>[]> {
      cap(ctx, 'read');
      return norms(await d.sql.query(`select * from ${S}.work_records where tenant_id=$1 and project_id=$2 and ($3::text is null or lane=$3) order by started_at desc limit ${limitOf(o.limit)}`, [...scope(ctx), o.lane ?? null]));
    },
  };
  return svc;
}
