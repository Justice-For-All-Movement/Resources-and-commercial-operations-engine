// Shared internals of the E13 service layer: configuration, command runner, row normalisation, validation guards.
import { createHash } from 'node:crypto';
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { appendAudit, emitEvent, idempotent, requireCapability, uref } from '../service-kit.ts';
import type { AuthorizationPort, ObjectStore, ServiceContext, Sql } from '../service-kit.ts';
import type { PaymentProvider } from './payments.ts';

export const SCHEMA = 'e13_resources';
export const S = SCHEMA;
export const ORG = '_org';

export type EngineConfig = Readonly<{
  /** Seconds a held reservation keeps capacity before the expiry job returns it. Default 900. */
  reservationTtlSeconds?: number;
  /** Default overage tolerance for new budgets, in basis points of the reserved amount. Default 1000 (10%). */
  defaultOverageToleranceBps?: number;
  /** Default lane drift tolerance in basis points. Default 500. */
  laneDriftToleranceBps?: number;
  invoicePrefix?: string;
  /** Issuer block printed on invoices (data, not code). */
  issuer?: Readonly<{ name: string; address?: string; taxId?: string; email?: string }>;
  /** Webhook timestamp tolerance in seconds. Default 300. */
  webhookToleranceSeconds?: number;
  /** Live payments stay refused unless this is true AND an unexpired human grant exists. Default false. */
  allowLivePayments?: boolean;
  /** Seconds before a payment left in created/processing/uncertain is first reconciled. Default 30. */
  reconcileAfterSeconds?: number;
  /** PDF converter binary; default `soffice`. */
  pdfConverter?: string;
}>;
export type EnginePorts = Readonly<{ authorization?: AuthorizationPort; payments?: Readonly<Record<string, PaymentProvider>> }>;
export type EngineDeps = Readonly<{ sql: Sql; objects?: ObjectStore; ports?: EnginePorts; config?: EngineConfig }>;

export type Cfg = Required<Omit<EngineConfig, 'issuer'>> & { issuer: NonNullable<EngineConfig['issuer']> };
export function resolveConfig(c: EngineConfig = {}): Cfg {
  return {
    reservationTtlSeconds: c.reservationTtlSeconds ?? 900, defaultOverageToleranceBps: c.defaultOverageToleranceBps ?? 1000,
    laneDriftToleranceBps: c.laneDriftToleranceBps ?? 500, invoicePrefix: c.invoicePrefix ?? 'INV-',
    issuer: c.issuer ?? { name: 'Issuer not configured' }, webhookToleranceSeconds: c.webhookToleranceSeconds ?? 300,
    allowLivePayments: c.allowLivePayments === true, reconcileAfterSeconds: c.reconcileAfterSeconds ?? 30, pdfConverter: c.pdfConverter ?? 'soffice',
  };
}

/** A unit of work inside one transaction. Events and audit rows are flushed last so the audit lock is always taken last. */
export type Tx = { sql: Sql; ctx: ServiceContext; event(type: string, subject: string, payload: Json): void; audit(action: string, subject: string, detail?: Json): void };
export type Internals = { sql: Sql; objects: ObjectStore | undefined; ports: EnginePorts; cfg: Cfg; run<T>(ctx: ServiceContext, op: string, key: string | undefined, input: unknown, fn: (t: Tx) => Promise<T>): Promise<T> };

export function internals(deps: EngineDeps): Internals {
  const d: Internals = {
    sql: deps.sql, objects: deps.objects, ports: deps.ports ?? {}, cfg: resolveConfig(deps.config),
    run<T>(ctx: ServiceContext, op: string, key: string | undefined, input: unknown, fn: (t: Tx) => Promise<T>): Promise<T> {
      if (key !== undefined) invariant(typeof key === 'string' && key.length > 0 && key.length <= 150, 'invalid_input', 'Invalid idempotency key');
      return deps.sql.tx((sql) => idempotent(sql, S, ctx, key === undefined ? undefined : `${op}:${key}`, input, async () => {
        const events: [string, string, Json][] = []; const audits: [string, string, Json][] = [];
        const out = await fn({ sql, ctx, event: (type, subject, payload) => { events.push([type, subject, payload]); }, audit: (action, subject, detail = {}) => { audits.push([action, subject, detail]); } });
        for (const [type, subject, payload] of events) await emitEvent(sql, S, ctx, type, subject, payload);
        for (const [action, subject, detail] of audits) await appendAudit(sql, S, ctx, action, subject, detail);
        return JSON.parse(JSON.stringify(out ?? null)) as Json;
      })) as Promise<T>;
    },
  };
  return d;
}

export const ref = (kind: string, id: string): string => uref('E13', kind, id);
export const cap = (ctx: ServiceContext, action: string): void => requireCapability(ctx, `resources:${action}`);
/** Approvals and other human-only decisions: the capability alone is not enough for an agent or service. */
export function humanWith(ctx: ServiceContext, action: string): void {
  cap(ctx, action);
  if (ctx.actor.kind !== 'human') throw new DomainError('forbidden', `resources:${action} decisions require a human actor`);
}

// ───────────── Row normalisation ─────────────
const NUMERIC = new Set(['ceiling', 'reserved', 'committed', 'amount', 'actual', 'price_per_million', 'cost_micro', 'debit', 'credit', 'seq', 'quantity',
  'last_number', 'total', 'count', 'active_seconds', 'attempts', 'tokens_in', 'tokens_out', 'compute_seconds', 'render_seconds', 'storage_bytes', 'messages', 'work_records', 'records', 'balance']);
const camel = (k: string): string => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  invariant(Number.isSafeInteger(n), 'invalid_state', 'Stored quantity exceeds the safe integer range');
  return n;
}
/** snake_case row → camelCase object; timestamps → ISO strings; bigint text → safe integers for known numeric columns. */
export function norm<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[camel(k)] = v instanceof Date ? v.toISOString() : typeof v === 'string' && (NUMERIC.has(k) || k.endsWith('_minor')) ? num(v) : v;
  }
  return out as T;
}
export const norms = <T = Record<string, unknown>>(rows: readonly Record<string, unknown>[]): T[] => rows.map((r) => norm<T>(r));

// ───────────── Validation ─────────────
export function str(v: unknown, label: string, max = 2000): string {
  invariant(typeof v === 'string' && v.trim().length > 0 && v.length <= max, 'invalid_input', `${label} must be a non-empty string of at most ${max} characters`);
  return v;
}
export const optStr = (v: unknown, label: string, max = 2000): string | null => (v === undefined || v === null ? null : str(v, label, max));
export function int(v: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  invariant(typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max, 'invalid_input', `${label} must be an integer between ${min} and ${max}`);
  return v;
}
export function currency(v: unknown): string {
  invariant(typeof v === 'string' && /^[A-Z]{3}$/.test(v), 'invalid_input', 'Currency must be a three-letter ISO 4217 code');
  return v;
}
export function day(v: unknown, label: string): string {
  invariant(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v, 'invalid_input', `${label} must be a calendar date (YYYY-MM-DD)`);
  return v;
}
export const optDay = (v: unknown, label: string): string | null => (v === undefined || v === null ? null : day(v, label));
export function time(v: unknown, label: string): string {
  invariant(typeof v === 'string' && Number.isFinite(Date.parse(v)), 'invalid_input', `${label} must be a timestamp`);
  return new Date(v).toISOString();
}
export function strings(v: unknown, label: string, max = 200): string[] {
  if (v === undefined || v === null) return [];
  invariant(Array.isArray(v) && v.length <= max, 'invalid_input', `${label} must be a list`);
  return v.map((x) => str(x, label, 500));
}
export const uuidLike = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function id(v: unknown): string {
  if (!uuidLike(v)) throw new DomainError('not_found', 'Not found');
  return v.toLowerCase();
}
export const sha = (v: string | Uint8Array): string => createHash('sha256').update(v).digest('hex');
export const limitOf = (v: unknown, dflt = 200, max = 1000): number => Math.min(Math.max(typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : dflt, 1), max);

// ───────────── Units ─────────────
export const METERS = ['tokens_in', 'tokens_out', 'compute_seconds', 'render_seconds', 'messages', 'storage_bytes'] as const;
export type Meter = typeof METERS[number];
/** Canonical units: `money:<ISO 4217>` (integer minor units) or one of METERS. A bare ISO code is accepted as money. */
export function unitOf(v: unknown): string {
  invariant(typeof v === 'string', 'invalid_input', 'Unit is required');
  if (/^[A-Z]{3}$/.test(v)) return `money:${v}`;
  invariant(/^money:[A-Z]{3}$/.test(v) || (METERS as readonly string[]).includes(v), 'invalid_input', `Unknown unit; use money:<ISO code> or one of ${METERS.join(', ')}`);
  return v;
}

// ───────────── Separation of incentives from facts ─────────────
const CONCLUSION = /(claim|finding|assessment|conclusion|verdict|allegation|accusation|hypothes)/i;
const UREF = /^E\d\d:[a-z][a-z0-9_]*:/;
/**
 * Rejects any linkage between money/effort steering and factual conclusions.
 * `commercial`: no field may name an E07/E08 object or any conclusion-type object, and no key may be conclusion-shaped.
 * `budget`: selectors and lane configuration may name objectives/runs but never conclusion-type objects or conclusion-shaped keys.
 */
export function assertNoFactualLinkage(value: unknown, mode: 'commercial' | 'budget', path = 'input'): void {
  const deny = (why: string): never => { throw new DomainError('invalid_incentive_linkage', `${path}: ${why}. Pay, budgets and effort targets cannot depend on claims, findings or assessments.`); };
  if (typeof value === 'string') {
    if (UREF.test(value)) {
      const [engine, kind] = value.split(':') as [string, string];
      if (CONCLUSION.test(kind)) deny(`reference to a ${kind} object is not accepted`);
      if (mode === 'commercial' && (engine === 'E07' || engine === 'E08')) deny('reference to a knowledge or investigation object is not accepted');
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoFactualLinkage(v, mode, `${path}[${i}]`)); return; }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (CONCLUSION.test(k) || /^(outcome|quota|success)/i.test(k)) deny(`field "${k}" is not accepted`);
      assertNoFactualLinkage(v, mode, `${path}.${k}`);
    }
  }
}
export const COMPENSATION_BASES = ['fixed_fee', 'hourly', 'daily', 'per_deliverable', 'retainer', 'salary', 'royalty_share', 'revenue_share', 'expense_reimbursement', 'pro_bono'] as const;

/** Rounds micro-minor units (minor × 1e6) half-up to minor units. */
export const microToMinor = (micro: number): number => Math.floor((micro + 500_000) / 1_000_000);
export const bps = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part * 10000) / whole));

export function csv(rows: readonly Record<string, unknown>[]): string {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const cell = (v: unknown): string => {
    let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`; // neutralise spreadsheet formulas
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}
