// E13 Resources and Commercial Operations — service layer entry point.
import { DomainError } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { SERVICE_KIT_VERSION, listAudit, parseUref, readEvents, requireCapability, runJobsOnce, runMigrations, standardRoutes, urefMatches } from '../service-kit.ts';
import type { AuditRecord, BudgetPort, EngineEvent, EngineManifestV1, Inspection, Route, SearchHit, ServiceContext, Sql, StandardEngine, UpstreamChange } from '../service-kit.ts';
import { budgetService } from './budgets.ts';
import { commercialService } from './commercial.ts';
import { S, SCHEMA, cap, internals, norm, ref, uuidLike } from './core.ts';
import type { EngineDeps } from './core.ts';
import { migrations } from './schema.ts';

export { SCHEMA, migrations };
export type { EngineConfig, EngineDeps, EnginePorts } from './core.ts';
export const manifest: EngineManifestV1 = {
  id: 'E13', name: 'Resources and Commercial Operations', version: '1.0.0', kit: SERVICE_KIT_VERSION,
  capabilities: ['resources:read', 'resources:write', 'resources:spend', 'resources:approve', 'resources:admin', 'resources:send', 'resources:grant', 'resources:export', 'resources:events'],
  emits: ['resources.budget_created', 'resources.budget_updated', 'resources.budget_reserved', 'resources.budget_committed', 'resources.budget_released', 'resources.budget_reservation_expired',
    'resources.budget_warning', 'resources.budget_exhausted', 'resources.budget_exceeded', 'resources.budget_frozen', 'resources.budget_unfrozen', 'resources.budget_closed', 'resources.budget_plan_downgraded',
    'resources.usage_recorded', 'resources.work_recorded', 'resources.lane_policy_set'],
  consumes: ['rights_changed', 'permission_withdrawn', 'permission_changed'],
};
const t = (c: string) => (r: Record<string, unknown>): string => String(r[c] ?? '');
const KINDS: Readonly<Record<string, { table: string; title: (r: Record<string, unknown>) => string }>> = {
  budget: { table: 'budgets', title: t('name') }, reservation: { table: 'reservations', title: (r) => `${String(r.category)} ${String(r.amount)} ${String(r.unit)}` },
  invoice: { table: 'invoices', title: (r) => `Invoice ${String(r.number ?? 'draft')}` }, license: { table: 'licenses', title: t('title') }, agreement: { table: 'agreements', title: t('title') },
  expense: { table: 'expenses', title: t('description') }, contributor: { table: 'contributors', title: t('display_name') }, revenue: { table: 'revenue_records', title: (r) => `${String(r.source)} ${String(r.external_id)}` },
  statement: { table: 'statements', title: (r) => `Statement ${String(r.period_start)}..${String(r.period_end)}` }, payment: { table: 'payments', title: (r) => `Payment ${String(r.amount_minor)} ${String(r.currency)}` },
  journal_entry: { table: 'journal_entries', title: t('memo') }, usage: { table: 'usage', title: (r) => `${String(r.kind)} ${String(r.provider)}/${String(r.model)}` }, work_record: { table: 'work_records', title: (r) => `${String(r.lane)} ${String(r.task)}` },
};
export function migrate(sql: Sql): Promise<string[]> { return runMigrations(sql, SCHEMA, migrations); }

export function createEngine(deps: EngineDeps) {
  const d = internals(deps);
  const budgets = budgetService(d);
  const commercial = commercialService(d);
  const budgetPort: BudgetPort = { reserve: (ctx, request) => budgets.reserve(ctx, request), commit: budgets.commit, release: budgets.release };
  const standard: StandardEngine = {
    manifest,
    async inspect(ctx: ServiceContext, value: string): Promise<Inspection | null> {
      cap(ctx, 'read');
      let parsed: ReturnType<typeof parseUref>;
      try { parsed = parseUref(value); } catch { return null; }
      const k = KINDS[parsed.kind];
      if (parsed.engine !== 'E13' || k === undefined || !uuidLike(parsed.id)) return null;
      const row = (await d.sql.query<Record<string, unknown>>(`select * from ${S}.${k.table} where id=$1 and tenant_id=$2 and project_id ${parsed.kind === 'budget' ? "in ($3,'_org')" : '= $3'}`, [parsed.id, ctx.tenantId, ctx.projectId]))[0];
      if (row === undefined) return null;
      const self = ref(parsed.kind, parsed.id); const n = norm<Record<string, unknown>>(row);
      const history = await listAudit(d.sql, S, ctx, { subject: self, limit: 200, allProjects: parsed.kind === 'budget' });
      const review = row.review_required === true; const reasons = ((row.review_reasons ?? []) as { reason?: string; kind?: string; cause?: string }[]).filter((r) => r.cause !== undefined).map((r) => `${r.kind}: ${r.reason} (${r.cause})`);
      const frozen = parsed.kind === 'budget' && row.state === 'frozen';
      return {
        ref: self, kind: parsed.kind, title: k.title(row), state: String(row.state ?? row.status ?? 'recorded'),
        stale: review && parsed.kind === 'revenue', blocked: (review && parsed.kind === 'license') || frozen,
        staleReasons: review ? reasons : frozen ? [String(row.state_reason ?? 'frozen')] : [],
        versions: typeof row.revision === 'number' ? [{ revision: row.revision, at: n.updatedAt as string, actorId: n.createdBy as string }] : [],
        sources: ((row.sources as string[] | undefined) ?? [row.work_ref, row.release_ref, row.subject_ref].filter((x): x is string => typeof x === 'string')),
        dependents: [], permissions: ((row.permission_refs as string[] | undefined) ?? []), decisions: (row.review_reasons as Json[] | undefined) ?? [],
        history: history.map((h) => ({ at: h.at, actorId: h.actorId, action: h.action, detail: h.detail })), data: JSON.parse(JSON.stringify(n)) as Json,
      };
    },
    async search(ctx: ServiceContext, query: { q: string; limit?: number }): Promise<SearchHit[]> {
      cap(ctx, 'read');
      const q = String(query?.q ?? '').trim(); if (q === '') return [];
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const parts = [['budget', 'budgets', 'name', 'unit', 'state', "in ($2,'_org')"], ['invoice', 'invoices', "coalesce(number,'draft')", "customer->>'name'", 'state', '= $2'], ['license', 'licenses', 'title', 'counterparty', 'status', '= $2'],
        ['agreement', 'agreements', 'title', 'scope', 'status', '= $2'], ['contributor', 'contributors', 'display_name', "array_to_string(roles, ', ')", 'status', '= $2'], ['expense', 'expenses', 'description', 'payee', 'state', '= $2']] as const;
      const sqlText = parts.map(([kind, table, title, snippet, state, proj]) => `select '${kind}' as kind, id::text as id, ${title} as title, ${snippet} as snippet, ${state} as state from ${S}.${table} where tenant_id=$1 and project_id ${proj} and (${title} ilike $3 or ${snippet} ilike $3)`).join(' union all ');
      const rows = await d.sql.query<{ kind: string; id: string; title: string; snippet: string | null; state: string }>(`${sqlText} order by kind, title limit ${Math.min(Math.max(query.limit ?? 50, 1), 200)}`, [ctx.tenantId, ctx.projectId, like]);
      return rows.map((r) => ({ ref: ref(r.kind, r.id), kind: r.kind, title: r.title, snippet: (r.snippet ?? '').slice(0, 200), state: r.state }));
    },
    async audit(ctx: ServiceContext, options = {}): Promise<AuditRecord[]> { cap(ctx, 'read'); return listAudit(d.sql, S, ctx, options); },
    async events(ctx: ServiceContext, options = {}): Promise<EngineEvent[]> { requireCapability(ctx, 'resources:events'); return readEvents(d.sql, S, { ...options, tenantId: ctx.tenantId }); },
    applyUpstreamChange: (ctx: ServiceContext, change: UpstreamChange): Promise<{ affected: string[] }> => commercial.applyUpstreamChange(ctx, change),
    async health(): Promise<{ ok: boolean; detail: Json }> { try { await d.sql.query('select 1'); return { ok: true, detail: { schema: S } }; } catch { return { ok: false, detail: { database: 'unavailable' } }; } },
  };
  const handlers = { 'resources.expire_reservation': (job: { ctx: ServiceContext; payload: Json }) => budgets.expireReservationJob(job.ctx, (job.payload as { reservationId: string }).reservationId) };
  return { ...standard, ...budgets, ...commercial, budgetPort, runJobs: (worker = 'e13-worker', limit = 20): Promise<number> => runJobsOnce(d.sql, S, handlers, { worker, limit }) };
}
export type ResourcesEngine = ReturnType<typeof createEngine>;
export function routes(engine: ResourcesEngine): Route[] { return [...standardRoutes(engine)]; }
void DomainError; void urefMatches;
