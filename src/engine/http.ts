// HTTP API of E13. Every route except the provider webhook requires a bearer token; capabilities are checked in the service.
import { DomainError } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { standardRoutes } from '../service-kit.ts';
import type { HttpRequest, HttpResponse, Route } from '../service-kit.ts';
import type { ResourcesEngine } from './index.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const body = (r: HttpRequest): Any => (r.body !== null && typeof r.body === 'object' ? r.body : {});
const qs = (r: HttpRequest, ...keys: string[]): Any => Object.fromEntries(keys.flatMap((k) => { const v = r.query.get(k); return v === null ? [] : [[k, k === 'limit' || k === 'withinDays' || k === 'olderThanSeconds' ? Number(v) : k === 'open' ? v === 'true' : v]]; }));
const p = (r: HttpRequest, k = 'id'): string => r.params[k] ?? '';
const created = (json: unknown): HttpResponse => ({ status: 201, json });
const done: HttpResponse = { status: 204, json: null };

export function routes(e: ResourcesEngine): Route[] {
  const R = (method: Route['method'], path: string, handler: (r: HttpRequest) => Promise<unknown>, isPublic = false): Route => ({ method, path, ...(isPublic ? { public: true } : {}), handler: async (r) => {
    try { const out = await handler(r); return (out === undefined ? done : out) as HttpResponse | Json; }
    catch (error) {
      // The kit answers every 5xx as an opaque 500; a missing tool or credential is reported explicitly instead.
      if (error instanceof DomainError && (error.code === 'unavailable' || error.code === 'provider_unavailable')) return { status: 503, json: { error: { code: error.code, message: error.message } } };
      throw error;
    }
  } });
  const FILTERS = ['limit', 'state', 'status', 'direction', 'kind', 'contributorId', 'invoiceId', 'lane', 'source', 'channel'];
  return [
    ...standardRoutes(e),
    // budgets and reservations
    R('POST', '/v1/budgets', async (r) => created(await e.createBudget(r.ctx, body(r)))),
    R('GET', '/v1/budgets', (r) => e.budgetTree(r.ctx)),
    R('GET', '/v1/budgets/:id', (r) => e.getBudget(r.ctx, p(r))),
    R('PATCH', '/v1/budgets/:id', (r) => e.updateBudget(r.ctx, p(r), body(r))),
    R('POST', '/v1/budgets/:id/state', (r) => e.setBudgetState(r.ctx, p(r), body(r).action, body(r).reason)),
    R('POST', '/v1/budgets/:id/assignments', (r) => e.assignBudget(r.ctx, p(r), body(r).actorId, body(r).assigned !== false)),
    R('POST', '/v1/reservations', async (r) => { const { withPlans, ...q } = body(r); return created(withPlans === true ? await e.reserveWithPlans(r.ctx, q) : await e.reserve(r.ctx, q)); }),
    R('GET', '/v1/reservations', (r) => e.listReservations(r.ctx, qs(r, 'state', 'limit'))),
    R('POST', '/v1/reservations/expire', (r) => e.expireReservations(r.ctx)),
    R('GET', '/v1/reservations/:id', (r) => e.getReservation(r.ctx, p(r))),
    R('POST', '/v1/reservations/:id/commit', (r) => e.commit(r.ctx, p(r), body(r))),
    R('POST', '/v1/reservations/:id/release', (r) => e.release(r.ctx, p(r), body(r).reason)),
    R('POST', '/v1/fallback-plans', async (r) => created(await e.authorizeFallbackPlan(r.ctx, body(r)))),
    R('GET', '/v1/burn', (r) => e.burn(r.ctx, qs(r, 'budgetId', 'unit', 'bucket', 'from', 'to'))),
    R('GET', '/v1/incidents', (r) => e.listIncidents(r.ctx, qs(r, 'kind', 'open', 'limit'))),
    // usage, work and lanes
    R('POST', '/v1/rates', async (r) => created(await e.setRate(r.ctx, body(r)))),
    R('GET', '/v1/rates', (r) => e.listRates(r.ctx)),
    R('POST', '/v1/usage', async (r) => created(await e.recordUsage(r.ctx, body(r)))),
    R('GET', '/v1/usage/report', (r) => e.usageReport(r.ctx, qs(r, 'groupBy', 'from', 'to', 'limit'))),
    R('GET', '/v1/usage/top', (r) => e.topCosts(r.ctx, qs(r, 'from', 'to', 'limit'))),
    R('POST', '/v1/lanes/policy', async (r) => created(await e.setLanePolicy(r.ctx, body(r)))),
    R('GET', '/v1/lanes/policy', (r) => e.getLanePolicy(r.ctx)),
    R('GET', '/v1/lanes/report', (r) => e.laneAllocationReport(r.ctx, qs(r, 'from', 'to'))),
    R('POST', '/v1/work', async (r) => created(await e.recordWork(r.ctx, body(r)))),
    R('GET', '/v1/work', (r) => e.listWork(r.ctx, qs(r, 'lane', 'limit'))),
    R('GET', '/v1/projects/:id/costs', async (r) => {
      if (p(r) !== r.ctx.projectId) throw new DomainError('not_found', 'Not found');
      const [budgets, usageByProvider, usageByLane, topCosts, pnl, incidents, lanes] = await Promise.all([e.budgetTree(r.ctx), e.usageReport(r.ctx, { groupBy: 'provider' }), e.usageReport(r.ctx, { groupBy: 'lane' }), e.topCosts(r.ctx, { limit: 10 }), e.projectPnl(r.ctx), e.listIncidents(r.ctx, { open: true }), e.laneAllocationReport(r.ctx)]);
      return { projectId: r.ctx.projectId, budgets, usageByProvider, usageByLane, topCosts, pnl, incidents, lanes };
    }),
    // ledger
    R('POST', '/v1/ledger/entries', async (r) => created(await e.postJournalEntry(r.ctx, body(r)))),
    R('POST', '/v1/ledger/entries/:id/reverse', async (r) => created(await e.reverseJournalEntry(r.ctx, p(r), body(r).reason))),
    R('GET', '/v1/ledger/entries', (r) => e.listJournal(r.ctx, qs(r, 'sourceKind', 'sourceId', 'limit'))),
    R('GET', '/v1/ledger/trial-balance', (r) => e.trialBalance(r.ctx)),
    R('POST', '/v1/ledger/accounts', async (r) => { await e.createAccount(r.ctx, body(r)); return created({ code: body(r).code }); }),
    // contributors, agreements, licenses
    R('POST', '/v1/contributors', async (r) => created(await e.createContributor(r.ctx, body(r)))),
    R('GET', '/v1/contributors', (r) => e.listContributors(r.ctx, qs(r, ...FILTERS))),
    R('PATCH', '/v1/contributors/:id', (r) => e.updateContributor(r.ctx, p(r), body(r))),
    R('POST', '/v1/agreements', async (r) => created(await e.createAgreement(r.ctx, body(r)))),
    R('GET', '/v1/agreements', (r) => e.listAgreements(r.ctx, qs(r, ...FILTERS))),
    R('POST', '/v1/agreements/:id/status', (r) => e.setAgreementStatus(r.ctx, p(r), body(r).action, body(r).reason)),
    R('POST', '/v1/licenses', async (r) => created(await e.createLicense(r.ctx, body(r)))),
    R('GET', '/v1/licenses', (r) => e.listLicenses(r.ctx, qs(r, ...FILTERS))),
    R('POST', '/v1/licenses/expiry-check', (r) => e.checkLicenseExpiry(r.ctx, body(r))),
    R('POST', '/v1/licenses/:id/status', (r) => e.setLicenseStatus(r.ctx, p(r), body(r).action, body(r).reason)),
    // expenses
    R('POST', '/v1/expenses', async (r) => created(await e.submitExpense(r.ctx, body(r)))),
    R('GET', '/v1/expenses', (r) => e.listExpenses(r.ctx, qs(r, ...FILTERS))),
    R('POST', '/v1/expenses/:id/decision', (r) => e.decideExpense(r.ctx, p(r), body(r).decision, body(r).note)),
    R('POST', '/v1/expenses/:id/paid', (r) => e.markExpensePaid(r.ctx, p(r), body(r))),
    // invoices
    R('POST', '/v1/invoices', async (r) => created(await e.createInvoice(r.ctx, body(r)))),
    R('GET', '/v1/invoices', (r) => e.listInvoices(r.ctx, qs(r, ...FILTERS))),
    R('GET', '/v1/invoices/:id', (r) => e.getInvoice(r.ctx, p(r))),
    R('POST', '/v1/invoices/:id/issue', (r) => e.issueInvoice(r.ctx, p(r))),
    R('POST', '/v1/invoices/:id/sent', (r) => e.markInvoiceSent(r.ctx, p(r), body(r))),
    R('POST', '/v1/invoices/:id/void', (r) => e.voidInvoice(r.ctx, p(r), body(r).reason)),
    R('GET', '/v1/invoices/:id/document', async (r) => { const d = await e.renderInvoice(r.ctx, p(r), (r.query.get('format') ?? 'pdf') as 'pdf' | 'html'); return { bytes: d.bytes, headers: { 'content-type': d.contentType, 'content-disposition': `attachment; filename="invoice.${d.format}"`, 'x-content-sha256': d.sha256 } }; }),
    // revenue, statements, margins, exports
    R('POST', '/v1/revenue/imports', async (r) => created(await e.importRevenue(r.ctx, body(r)))),
    R('GET', '/v1/revenue', (r) => e.listRevenue(r.ctx, qs(r, ...FILTERS))),
    R('GET', '/v1/revenue/by-work', (r) => e.revenueByWork(r.ctx, qs(r, 'from', 'to'))),
    R('POST', '/v1/revenue/:id/reconcile', (r) => e.reconcileRevenue(r.ctx, p(r), body(r))),
    R('POST', '/v1/revenue/:id/clear-review', (r) => e.clearRevenueReview(r.ctx, p(r), body(r).reason)),
    R('POST', '/v1/statements', async (r) => created(await e.issueStatement(r.ctx, body(r)))),
    R('GET', '/v1/statements', (r) => e.listStatements(r.ctx, qs(r, ...FILTERS))),
    R('GET', '/v1/statements/:id', (r) => e.getStatement(r.ctx, p(r))),
    R('POST', '/v1/statements/:id/void', (r) => e.voidStatement(r.ctx, p(r), body(r).reason)),
    R('GET', '/v1/pnl', (r) => e.projectPnl(r.ctx, qs(r, 'from', 'to'))),
    R('GET', '/v1/exports/:dataset', async (r) => { const x = await e.exportData(r.ctx, { dataset: p(r, 'dataset'), format: (r.query.get('format') ?? 'json') as 'csv' | 'json' }); return { bytes: new Uint8Array(Buffer.from(x.body, 'utf8')), headers: { 'content-type': x.contentType, 'x-row-count': String(x.rows) } }; }),
    // payments
    R('POST', '/v1/payments', async (r) => created(await e.createPayment(r.ctx, body(r)))),
    R('GET', '/v1/payments', (r) => e.listPayments(r.ctx, qs(r, 'invoiceId', 'state', 'limit'))),
    R('POST', '/v1/payments/reconcile', (r) => e.reconcilePayments(r.ctx, body(r))),
    R('POST', '/v1/payments/live-grants', async (r) => created(await e.grantLivePayments(r.ctx, body(r)))),
    R('DELETE', '/v1/payments/live-grants/:id', (r) => e.revokeLivePayments(r.ctx, p(r))),
    R('GET', '/v1/payments/:id', (r) => e.getPayment(r.ctx, p(r))),
    R('POST', '/v1/payments/:id/reconcile', (r) => e.reconcilePayment(r.ctx, p(r))),
    // Provider webhook: no bearer token; authenticated by the provider's signature over the raw body.
    R('POST', '/v1/payments/webhooks/:provider', (r) => e.handleProviderWebhook(p(r, 'provider'), r.raw, r.headers), true),
  ];
}
