// Shared fixtures for service-layer tests. All data is fictional; nothing here contacts a third party.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DomainError } from '../src/contracts.ts';
import { withDisposableDatabase } from '../src/service-kit.ts';
import type { ObjectStore, ServiceContext, Sql } from '../src/service-kit.ts';
import { createEngine, migrate } from '../src/engine/index.ts';
import type { EngineDeps, ResourcesEngine } from '../src/engine/index.ts';

export const ADMIN = process.env.TEST_DATABASE_URL ?? '';
export const needsPg = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};
export const ALL = ['resources:read', 'resources:write', 'resources:spend', 'resources:approve', 'resources:admin', 'resources:send', 'resources:grant', 'resources:export', 'resources:events'];
export function ctx(over: Partial<ServiceContext> & { actorId?: string; kind?: 'human' | 'agent' | 'service' } = {}): ServiceContext {
  const { actorId, kind, ...rest } = over;
  return { tenantId: 'org-a', projectId: 'proj-1', purpose: 'test', requestId: randomUUID(), now: new Date().toISOString(), actor: { id: actorId ?? 'human-1', kind: kind ?? 'human', roles: [] }, capabilities: ALL, compartments: [], ...rest };
}
export const code = (c: string) => (e: unknown): boolean => { assert.ok(e instanceof DomainError, `expected DomainError ${c}, got ${String(e)}`); assert.equal(e.code, c); return true; };
export function withEngine(fn: (engine: ResourcesEngine, sql: Sql, url: string) => Promise<void>, deps: (sql: Sql) => Omit<EngineDeps, 'sql'> = () => ({})): Promise<void> {
  return withDisposableDatabase(pg, ADMIN, async (url, sql) => { await migrate(sql); await fn(track(createEngine({ sql, ...deps(sql) }), sql), sql, url); });
}
const sqlOf = new WeakMap<object, Sql>();
export function track<T extends object>(engine: T, sql: Sql): T { sqlOf.set(engine, sql); return engine; }
/**
 * The kit's event feed withholds rows while ANY older transaction is open on the PostgreSQL cluster (gap safety), and this
 * cluster is shared with other test suites. Wait until the feed has caught up with what this tenant has committed.
 */
export async function settled(engine: ResourcesEngine, c: ServiceContext): Promise<Awaited<ReturnType<ResourcesEngine['events']>>> {
  const sql = sqlOf.get(engine); assert.ok(sql !== undefined, 'engine was not registered with track()');
  for (let i = 0; ; i++) {
    const want = Number((await sql.query<{ n: string }>(`select count(*) n from e13_resources._events where tenant_id=$1`, [c.tenantId]))[0]!.n);
    const got = await engine.events(c, { limit: 1000 });
    if (got.length >= want || i > 600) return got;
    await sleep(50);
  }
}
export function memoryObjects(): ObjectStore & { keys(): string[] } {
  const m = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) { m.set(key, Uint8Array.from(bytes)); return { key, size: bytes.byteLength, sha256: '' }; },
    async get(key) { const v = m.get(key); if (v === undefined) throw new DomainError('not_found', 'Object not found'); return v; },
    async head(key) { const v = m.get(key); return v === undefined ? null : { size: v.byteLength }; },
    async delete(key) { m.delete(key); }, async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)).sort(); },
    keys: () => [...m.keys()],
  };
}
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
