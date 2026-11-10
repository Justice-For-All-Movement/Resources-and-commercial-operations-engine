// E13 Resources and Commercial Operations — service layer entry point.
import { DomainError } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { SERVICE_KIT_VERSION, listAudit, parseUref, readEvents, requireCapability, runJobsOnce, runMigrations, standardRoutes, urefMatches } from '../service-kit.ts';
import type { AuditRecord, BudgetPort, EngineEvent, EngineManifestV1, Inspection, Route, SearchHit, ServiceContext, Sql, StandardEngine, UpstreamChange } from '../service-kit.ts';
import { budgetService } from './budgets.ts';
import { S, SCHEMA, cap, internals, norm, ref } from './core.ts';
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
export function migrate(sql: Sql): Promise<string[]> { return runMigrations(sql, SCHEMA, migrations); }

export function createEngine(deps: EngineDeps) {
  const d = internals(deps);
  const budgets = budgetService(d);
  const budgetPort: BudgetPort = { reserve: (ctx, request) => budgets.reserve(ctx, request), commit: budgets.commit, release: budgets.release };
  const standard: StandardEngine = {
    manifest,
    async inspect(): Promise<Inspection | null> { return null; },
    async search(): Promise<SearchHit[]> { return []; },
    async audit(ctx: ServiceContext, options = {}): Promise<AuditRecord[]> { cap(ctx, 'read'); return listAudit(d.sql, S, ctx, options); },
    async events(ctx: ServiceContext, options = {}): Promise<EngineEvent[]> { requireCapability(ctx, 'resources:events'); return readEvents(d.sql, S, { ...options, tenantId: ctx.tenantId }); },
    async applyUpstreamChange(): Promise<{ affected: string[] }> { return { affected: [] }; },
    async health(): Promise<{ ok: boolean; detail: Json }> { try { await d.sql.query('select 1'); return { ok: true, detail: { schema: S } }; } catch { return { ok: false, detail: { database: 'unavailable' } }; } },
  };
  const handlers = { 'resources.expire_reservation': (job: { ctx: ServiceContext; payload: Json }) => budgets.expireReservationJob(job.ctx, (job.payload as { reservationId: string }).reservationId) };
  return { ...standard, ...budgets, budgetPort, runJobs: (worker = 'e13-worker', limit = 20): Promise<number> => runJobsOnce(d.sql, S, handlers, { worker, limit }) };
}
export type ResourcesEngine = ReturnType<typeof createEngine>;
export function routes(engine: ResourcesEngine): Route[] { return [...standardRoutes(engine)]; }
void DomainError; void parseUref; void urefMatches; void norm; void ref;
