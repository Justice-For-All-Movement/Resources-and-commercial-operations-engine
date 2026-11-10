// Standalone server for E13: reads env, migrates, serves HTTP and runs the job worker loop.
import { createPublicKey, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createHttpHandler, createTokenVerifier, objectStoreFromEnv, pgSql, serve } from '../service-kit.ts';
import { SCHEMA, SandboxProcessor, SandboxProvider, createEngine, manifest, migrate, routes, sandboxProcessorRoutes, stripeFromEnv } from './index.ts';
import type { EngineConfig, PaymentProvider } from './index.ts';

function publicKeys(env: NodeJS.ProcessEnv): Record<string, string> {
  const raw = env.IDENTITY_PUBLIC_KEYS ?? (env.IDENTITY_JWKS_FILE === undefined ? undefined : readFileSync(env.IDENTITY_JWKS_FILE, 'utf8'));
  if (raw === undefined) throw new Error('IDENTITY_PUBLIC_KEYS (JSON map kid→PEM) or IDENTITY_JWKS_FILE is required');
  const parsed = JSON.parse(raw) as Record<string, unknown> & { keys?: { kid?: string }[] };
  if (Array.isArray(parsed.keys)) return Object.fromEntries(parsed.keys.map((k) => [String(k.kid), createPublicKey({ key: k as never, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString()]));
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<{ close(): Promise<void>; port: number }> {
  if (env.DATABASE_URL === undefined) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.DATABASE_POOL_MAX ?? 10) });
  const sql = pgSql(pool);
  await migrate(sql);
  const payments: Record<string, PaymentProvider> = { stripe: stripeFromEnv(env, { allowLivePayments: env.ALLOW_LIVE_PAYMENTS === 'true', ...(env.STRIPE_FLOW === 'checkout' ? { flow: 'checkout' as const } : {}), ...(env.STRIPE_SUCCESS_URL === undefined ? {} : { successUrl: env.STRIPE_SUCCESS_URL }), ...(env.STRIPE_CANCEL_URL === undefined ? {} : { cancelUrl: env.STRIPE_CANCEL_URL }) }) };
  let processor: SandboxProcessor | undefined;
  if (env.PAYMENT_SANDBOX === '1') {
    const secret = env.SANDBOX_WEBHOOK_SECRET ?? randomBytes(24).toString('hex');
    processor = new SandboxProcessor({ sql, schema: SCHEMA, webhookSecret: secret, ...(env.SANDBOX_API_KEY === undefined ? {} : { apiKey: env.SANDBOX_API_KEY }) });
    payments.sandbox = new SandboxProvider(processor, secret);
  }
  const config: EngineConfig = {
    allowLivePayments: env.ALLOW_LIVE_PAYMENTS === 'true',
    ...(env.RESERVATION_TTL_SECONDS === undefined ? {} : { reservationTtlSeconds: Number(env.RESERVATION_TTL_SECONDS) }),
    ...(env.OVERAGE_TOLERANCE_BPS === undefined ? {} : { defaultOverageToleranceBps: Number(env.OVERAGE_TOLERANCE_BPS) }),
    ...(env.INVOICE_PREFIX === undefined ? {} : { invoicePrefix: env.INVOICE_PREFIX }),
    ...(env.INVOICE_ISSUER === undefined ? {} : { issuer: JSON.parse(env.INVOICE_ISSUER) as NonNullable<EngineConfig['issuer']> }),
    ...(env.WEBHOOK_TOLERANCE_SECONDS === undefined ? {} : { webhookToleranceSeconds: Number(env.WEBHOOK_TOLERANCE_SECONDS) }),
    ...(env.PDF_CONVERTER === undefined ? {} : { pdfConverter: env.PDF_CONVERTER }),
  };
  const engine = createEngine({ sql, objects: objectStoreFromEnv(env, join(tmpdir(), 'e13-objects')), ports: { payments }, config });
  if (processor !== undefined) processor.setSink(async (raw, headers) => { try { await engine.handleProviderWebhook('sandbox', raw, headers); return 200; } catch { return 400; } });
  const handler = createHttpHandler({
    name: manifest.id, version: manifest.version, health: engine.health,
    routes: [...routes(engine), ...(processor !== undefined && env.SANDBOX_HTTP === '1' ? sandboxProcessorRoutes(processor) : [])],
    verify: createTokenVerifier({ publicKeys: publicKeys(env), ...(env.IDENTITY_ISSUER === undefined ? {} : { issuer: env.IDENTITY_ISSUER }) }),
    onError: (error, info) => { console.error(JSON.stringify({ level: 'error', ...info, error: error instanceof Error ? error.message : 'unknown' })); },
  });
  const server = await serve(handler, Number(env.PORT ?? 8013), env.HOST ?? '127.0.0.1');
  let stopped = false;
  const worker = `e13-${process.pid}`;
  const loop = (async () => {
    while (!stopped) {
      try { const n = await engine.runJobs(worker); if (processor !== undefined) await processor.deliverPending(); if (n > 0) continue; }
      catch (error) { console.error(JSON.stringify({ level: 'error', worker, error: error instanceof Error ? error.message : 'unknown' })); }
      await new Promise((r) => setTimeout(r, Number(env.JOB_POLL_MS ?? 2000)));
    }
  })();
  const port = (server.address() as { port: number }).port;
  console.log(JSON.stringify({ level: 'info', engine: manifest.id, listening: port, sandboxPayments: processor !== undefined, stripe: payments.stripe?.mode ?? 'unavailable' }));
  return { port, async close() { stopped = true; await new Promise((r) => server.close(r)); await loop; await pool.end(); } };
}
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((s) => { const stop = (): void => { void s.close().then(() => process.exit(0)); }; process.on('SIGTERM', stop); process.on('SIGINT', stop); })
    .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
