# E13 Resources and Commercial Operations — service layer API

Status of this document: describes what is implemented on branch `feature/pam-completion`. Sections "Not implemented" and
"Not verified" at the end are part of the contract.

- Kit: `src/service-kit.ts`, version 1.0.1, sha256 `95475a907267ba1fdd54b557aabe5645c37add9788a5b2d0854d9accfd5d8ea5`
  (byte-identical copy of the Identity engine's file; `src/contracts.ts` is the Identity version).
- Schema: `e13_resources` (owned exclusively). Capability prefix: `resources`.
- The service layer imports no other engine's package. The legacy modules (`src/index.ts`, `src/store.ts`) and their tests
  are unchanged; `allocateCost` from `src/index.ts` is reused to validate lane target shares.

## Entry points

```ts
import { SCHEMA, manifest, migrations, migrate, createEngine, routes } from '@accountability/resource-operations/engine';
const engine = createEngine({ sql, objects?, ports?: { authorization?: AuthorizationPort; payments?: Record<string, PaymentProvider> }, config?: EngineConfig });
const budgetPort: BudgetPort = engine.budgetPort;   // the engine object itself also satisfies BudgetPort
```

`EngineConfig` (all optional): `reservationTtlSeconds` (900), `defaultOverageToleranceBps` (1000), `laneDriftToleranceBps` (500),
`invoicePrefix` (`INV-`), `issuer` `{name,address?,taxId?,email?}`, `webhookToleranceSeconds` (300), `allowLivePayments` (false),
`reconcileAfterSeconds` (30), `pdfConverter` (`soffice`).

Server: `npm run serve` (`src/engine/serve.ts`, export `./serve`, `main(env)`).

| Env | Meaning |
|---|---|
| `DATABASE_URL` (required), `DATABASE_POOL_MAX` | PostgreSQL |
| `PORT` (8013), `HOST` (127.0.0.1) | listener |
| `IDENTITY_PUBLIC_KEYS` (JSON kid→PEM) or `IDENTITY_JWKS_FILE` (JWKS or kid→PEM JSON), `IDENTITY_ISSUER` | token verification |
| `OBJECT_STORE`, `OBJECT_STORE_PATH`, `S3_*` | rendered invoices |
| `PAYMENT_SANDBOX=1`, `SANDBOX_WEBHOOK_SECRET`, `SANDBOX_API_KEY`, `SANDBOX_HTTP=1` | built-in sandbox processor (and its HTTP surface) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_FLOW=checkout`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` | Stripe adapter; absent key ⇒ provider `unavailable` |
| `ALLOW_LIVE_PAYMENTS=true` | necessary (not sufficient) for live keys; a human grant is also required per scope |
| `RESERVATION_TTL_SECONDS`, `OVERAGE_TOLERANCE_BPS`, `INVOICE_PREFIX`, `INVOICE_ISSUER` (JSON), `WEBHOOK_TOLERANCE_SECONDS`, `PDF_CONVERTER`, `JOB_POLL_MS` | engine settings |

Tool dependencies: LibreOffice (`soffice`) for invoice PDFs; without it `renderInvoice(…, 'pdf')` fails with `unavailable`
(HTTP 503) and HTML rendering still works. Tests additionally use `pdfinfo`/`pdftotext`.

## Capabilities

| Capability | Grants |
|---|---|
| `resources:read` | all read views (budgets, usage, lanes, ledger, invoices, revenue, margins, audit) |
| `resources:write` | record usage/work, drafts (contributors, agreements, licenses, invoices), submit expenses, import/reconcile revenue, reconcile payments, `applyUpstreamChange`, license expiry check |
| `resources:spend` (sensitive) | `reserve`, `commit`, `release`, `reserveWithPlans`, `expireReservations`, mark an expense paid |
| `resources:approve` (sensitive, **human only**) | freeze/unfreeze/close budgets, fallback plans, expense decisions, issue/void invoices, agreement and license status, statements, manual journal entries and reversals, clearing reviews |
| `resources:admin` (sensitive) | budget definitions and assignments, rate card, lane policy, ledger accounts |
| `resources:send` (sensitive) | mark invoice sent, request a payment through a provider |
| `resources:grant` (sensitive, **human only**) | live-payment grants |
| `resources:export` (sensitive) | `exportData` |
| `resources:events` (sensitive) | outbox feed |

Sensitive actions are never satisfied by `resources:*`. Every method takes `ctx` first and checks its capability before any
read or write. "Human only" methods also reject agent/service actors that hold the capability. `ports.authorization`, when
supplied, is re-checked before a payment request.

## Budgets and the BudgetPort

Units: `money:<ISO 4217>` (integer minor units; a bare `EUR` is accepted) or `tokens_in`, `tokens_out`, `compute_seconds`,
`render_seconds`, `messages`, `storage_bytes`. Levels: `organization → project → objective/run → agent/lane`. Organization
budgets are stored under the reserved project id `_org` and apply to every project of the tenant. A child inherits its
parent's selectors (`categories`, `actorId`, `lane`, `objective`, `run`) and may only narrow them. Period: `one_off` or
`monthly` (UTC calendar month; a new month starts with empty counters).

A reservation is checked against **every** budget of the unit whose selectors match the request (category, actor, lane,
objective/run or subject). `reserve` extra optional fields: `lane`, `objective`, `run`.

```ts
reserve(ctx, { category, amount, unit, subject, idempotencyKey, lane?, objective?, run? }): Promise<{ reservationId }>
commit(ctx, reservationId, { amount, detail? }): Promise<void>
release(ctx, reservationId, reason): Promise<void>
reserveWithPlans(ctx, sameRequest): Promise<{ reservationId, plan, amount, tradeoffs, skipped }>
authorizeFallbackPlan(ctx, { category, unit, name, amount, tradeoffs, subject? }): Promise<{ id }>
getReservation(ctx, id) · listReservations(ctx, { state?, limit? }) · expireReservations(ctx): Promise<{ expired }>
createBudget(ctx, { name, level, unit, ceiling, period?, parentId?, categories?, actorId?, lane?, objective?, run?, warnBps?, overageToleranceBps?, idempotencyKey? }): Promise<Budget>
updateBudget(ctx, id, { name?, ceiling?, warnBps?, overageToleranceBps?, expectedRevision? }): Promise<Budget>
setBudgetState(ctx, id, 'freeze' | 'unfreeze' | 'close', reason): Promise<Budget>
assignBudget(ctx, budgetId, actorId, assigned = true): Promise<void>
getBudget(ctx, id) · budgetTree(ctx): Promise<BudgetNode[]> · burn(ctx, { budgetId?, unit?, bucket?, from?, to? }) · listIncidents(ctx, { kind?, open?, limit? })
```

Semantics (graceful exhaustion):

- `reserve` throws `DomainError('budget_exhausted')` (HTTP 402) **before the caller's side effect** when: no budget of that
  unit applies; the actor is an agent or service without an explicit assignment (an agent-level budget naming it, or
  `assignBudget`); any applicable budget is frozen; or any applicable ceiling would be exceeded. There is no unbudgeted or
  unlimited mode. A denial is recorded as an incident (counted) and emits `resources.budget_exhausted` once per budget
  period. A denied idempotency key is not poisoned: retrying later re-evaluates.
- Concurrency: applicable budget rows are locked `FOR UPDATE` in id order inside one transaction, so parallel sessions queue
  and counters can never be oversubscribed (tested with 50 parallel reservations on 25 real connections).
- Idempotency: the same `idempotencyKey` and input returns the same `reservationId`; different input → `idempotency_conflict`.
- `commit` with `amount` ≤ reserved releases the difference. `amount` above reserved but within the budget's
  `overageToleranceBps` (of the reserved amount) commits quietly. Beyond tolerance it **still commits** (the work happened and
  is accounted), records an `overage` incident, emits `resources.budget_exceeded` and freezes the most specific budget (and
  any budget whose ceiling is now exceeded). Repeating a commit with the same amount is a no-op; a different amount →
  `invalid_state`. A commit that arrives after expiry is accounted as well (`late: true`).
- `release` of a held reservation returns capacity; repeating it is a no-op; a committed reservation cannot be released.
- Expiry: every reservation enqueues kit job `resources.expire_reservation` at `expiresAt`; if neither committed nor
  released it becomes `expired` and capacity returns. `reserve` also reclaims expired holds lazily when it would otherwise deny.
- Soft warnings: each `warnBps` threshold emits `resources.budget_warning` once per budget period.
- Only a human with `resources:approve` can unfreeze. Agents cannot create, raise or unfreeze budgets.
- `reserveWithPlans`: tries the requested amount, then smaller plans a human previously authorized for that category
  (largest first); returns the chosen plan and its `tradeoffs`, records them on the reservation and emits
  `resources.budget_plan_downgraded`. If nothing fits → `budget_exhausted` (the caller pauses).
- `budgetTree` nodes carry `reserved`, `committed`, `available`, `usedBps`, `assignedActors` and, for monthly budgets, a
  `linear_projection` forecast.

## Usage metering, work allocation, lanes

```ts
setRate(ctx, { provider, model?, meter, currency, pricePerMillion, effectiveFrom, note?, organizationWide? }) · listRates(ctx)
recordUsage(ctx, { kind: 'model_call'|'processing'|'rendering'|'storage'|'messaging'|'other', provider, model?, quantities: Partial<Record<Meter, number>>, cost?: { amountMinor, currency }, lane?, objective?, subject, workRef?, occurredAt?, reservationId?, idempotencyKey })
usageReport(ctx, { groupBy?: 'provider'|'model'|'actor'|'lane'|'kind'|'work'|'subject', from?, to?, limit? }) · topCosts(ctx, { from?, to?, limit? })
setLanePolicy(ctx, { allocation: 'equal'|'explicit', lanes: [{ key, name, targetShareBps?, configuration? }], measure?, driftToleranceBps?, note?, idempotencyKey? }) · getLanePolicy(ctx)
recordWork(ctx, { lane, task, objective?, startedAt, endedAt, activeSeconds, attempts?, actorId?, actorKind?, idempotencyKey }) · listWork(ctx, { lane?, limit? })
laneAllocationReport(ctx, { from?, to? }): Promise<LaneReport>
```

- Rate card: `pricePerMillion` = minor currency units per 1,000,000 meter units, effective from a timestamp; rates are
  never rewritten (a new effective date supersedes). Cost = Σ quantity × rate in force at `occurredAt` (project rate before
  organization rate, exact model before `*`). A meter without a rate is reported in `unpricedMeters` and the record is
  counted as unpriced; costs are never guessed. `cost` declares a provider-billed amount instead. `storage_bytes` is priced
  per recorded snapshot (the deployment chooses the snapshot interval and rate).
- With `reservationId`, the reservation is committed in the same transaction with the actual quantity in its unit.
- Lane policy is deployment configuration: lane keys, names, target **effort** shares and free-form reviewed
  `configuration` (e.g. a reviewed comparison selection). Code never chooses a lane. `equal` splits 10,000 bps evenly.
- `laneAllocationReport` measures recorded work and usage per lane — active seconds, attempts, work records, tokens,
  compute/render seconds, money per currency — and reports actual shares per measure, target share, drift on the policy
  measure, `underAllocated`/`overAllocated`. It contains no count of claims, findings or accusations and there is no field
  that could hold one: `recordWork` rejects any field outside its list, and lane configuration rejects conclusion-shaped
  keys and references.

## Commercial ledger

Double entry, append-only. Balance is enforced by deferred constraint triggers at commit (≥ 2 lines, debits = credits,
same scope); `UPDATE`, `DELETE` and `TRUNCATE` on journal tables raise. A correction is a reversing entry
(`reverseJournalEntry`; an entry can be reversed once). Default chart: 1000 cash, 1100 receivables, 1200 provider/channel
clearing, 2000 payables, 2100 tax payable, 2200 royalties payable, 3000 equity, 4000/4100 revenue, 5000 direct costs,
5100 purchase tax, 5200 inbound license costs, 5400 royalties, 5500 channel fees.

```ts
postJournalEntry(ctx, { date, currency, memo, lines: [{ account, debit?, credit?, workRef? }], idempotencyKey }) · reverseJournalEntry(ctx, entryId, reason)
createAccount(ctx, { code, name, type }) · listJournal(ctx, { sourceKind?, sourceId?, limit? }) · trialBalance(ctx)
createContributor(ctx, { kind, displayName, roles?, rates?, identityRef?, notes?, idempotencyKey? }) · updateContributor(ctx, id, patch) · listContributors(ctx, filters)
createAgreement(ctx, { contributorId, title, scope, terms, basis, rateMinor?, currency?, shareBps?, workRefs?, startsOn, endsOn?, documentRef?, idempotencyKey? })
setAgreementStatus(ctx, id, 'activate'|'terminate'|'expire', reason) · listAgreements(ctx, filters)
createLicense(ctx, { direction: 'inbound'|'outbound', title, counterparty, subjectRef, scope, territory?, startsOn, expiresOn?, feeMinor?, currency?, royaltyBps?, permissionRefs?, releaseRefs?, documentRef?, agreementId?, idempotencyKey? })
setLicenseStatus(ctx, id, 'activate'|'terminate'|'expire'|'clear_review', reason) · listLicenses(ctx, filters) · checkLicenseExpiry(ctx, { withinDays? })
submitExpense(ctx, { description, category, payee, contributorId?, amountMinor, taxMinor?, currency, incurredOn, workRef?, receiptRef?, idempotencyKey })
decideExpense(ctx, id, 'approve'|'reject', note) · markExpensePaid(ctx, id, { reference, paidOn? }) · listExpenses(ctx, filters)
createInvoice(ctx, { customer: { name, address?, taxId?, email?, country? }, currency, dueOn?, notes?, lines: [{ description, quantity, unitPriceMinor, taxCode?, taxRateBps?, workRef?, releaseRef?, channel?, licenseId? }], idempotencyKey })
issueInvoice(ctx, id) · markInvoiceSent(ctx, id, { channel, reference? }) · voidInvoice(ctx, id, reason) · getInvoice(ctx, id) · listInvoices(ctx, filters)
renderInvoice(ctx, id, 'pdf'|'html'): Promise<{ format, contentType, bytes, sha256, key }>
importRevenue(ctx, { source, channel, rows: [{ externalId, workRef?, releaseRef?, licenseId?, periodStart, periodEnd, occurredOn?, grossMinor, feesMinor?, currency }], idempotencyKey? }): Promise<{ imported, duplicates }>
reconcileRevenue(ctx, id, { reference, receivedOn? }) · clearRevenueReview(ctx, id, reason) · listRevenue(ctx, filters) · revenueByWork(ctx, { from?, to? })
issueStatement(ctx, { contributorId, periodStart, periodEnd, idempotencyKey }) · voidStatement(ctx, id, reason) · getStatement(ctx, id) · listStatements(ctx, filters)
projectPnl(ctx, { from?, to? }) · exportData(ctx, { dataset, format?: 'csv'|'json' })
```

- Compensation basis vocabulary: `fixed_fee, hourly, daily, per_deliverable, retainer, salary, royalty_share, revenue_share,
  expense_reimbursement, pro_bono`. Activation requires document evidence (`documentRef`) and a human approver.
- Expenses: `submitted → approved | rejected → paid`. The decider must be a human different from the submitter (service
  check and database constraint). Approval posts Dr 5000/5100, Cr 2000; `markExpensePaid` records an outside bank payment
  (Dr 2000, Cr 1000) — this engine moves no money for expenses.
- Invoices: `draft → issued → sent → paid`, or `void` (issued/sent with no money received and no payment in flight; posts a
  reversing entry; the number is kept and never reused). Numbers come from one gapless sequence per organization, assigned
  at issue. Tax code and rate are data per line. `markInvoiceSent` records delivery performed elsewhere (E03 or by hand).
  PDF/HTML rendering escapes all supplied text; with an object store the file is stored under
  `<tenantId>/<projectId>/invoices/<id>/…` and listed in `documents`.
- Licenses: inbound (assets licensed in; activating one with a fee posts Dr 5200, Cr 2000 against the licensed work) and
  outbound (licenses granted for works, with E11 `permissionRefs` and E12 `releaseRefs`). `checkLicenseExpiry` emits
  `resources.license_expiring` once per license; it must be scheduled by the host (no built-in timer).
- Revenue records exist per work/release/channel: one per invoice line at issue, one per imported row.
  `(source, externalId)` is unique, so re-importing a receipt creates no second income record.
- Statements: `royalty_share` applies to gross revenue, `revenue_share` to revenue net of channel fees, for the agreement's
  works within the period; revenue under rights review is held back and counted in `heldForReview`. One live statement per
  contributor and period; a correction voids (reversing entries) and re-issues.
- P&L: `margin = revenue − direct costs − allocated usage costs`, per currency and per work. Revenue and direct costs are
  read from the ledger (voids and reversals are reflected), usage costs from metered usage carrying `workRef`. Currencies
  are never converted. Do not also book the provider bill for metered usage against the same work.
- Exports (`resources:export`, audited): `journal, budgets, reservations, usage, work, incidents, contributors, agreements,
  licenses, expenses, invoices, invoice_lines, revenue, payments, statements, statement_lines, rates`; CSV cells that could
  be read as spreadsheet formulas are neutralised.

## Separation of incentives from facts

- No API accepts a claim, finding or assessment as a basis for pay, bonus, revenue or budget. Commercial inputs
  (contributors, agreements, licenses, expenses, invoices, revenue, journal lines, usage `workRef`) reject any reference to
  an E07/E08 object, any reference whose kind names a conclusion (`claim, finding, assessment, conclusion, verdict,
  allegation, accusation, hypothesis`), and any conclusion-shaped field name (also `outcome*`, `quota*`, `success*`) with
  `invalid_incentive_linkage` (HTTP 400). Budget selectors, fallback plans and lane policy reject conclusion-type references
  and fields. The same rules are CHECK constraints in the schema, and no column can store such a link.
- Reservation/usage `subject` and work `task` are passive cost attribution ("what was the work on") and accept any
  reference; they feed cost and effort reports only.
- `revenueByWork` and `projectPnl` state which works earn revenue to holders of `resources:read`. The engine emits only
  `resources.*` events; none carries revenue per claim or finding, and none is declared for consumption by E07/E08.

## Payments

```ts
createPayment(ctx, { invoiceId, provider, amountMinor?, method?, returnUrl?, idempotencyKey }): Promise<Payment & { clientSecret? }>
getPayment(ctx, id) · listPayments(ctx, { invoiceId?, state?, limit? })
handleProviderWebhook(providerName, rawBody, headers, now?): Promise<{ received: true, handling }>
reconcilePayment(ctx, id) · reconcilePayments(ctx, { olderThanSeconds? })
grantLivePayments(ctx, { provider, currency, maxAmountMinor, expiresAt, reason }) · revokeLivePayments(ctx, grantId)
```

Payments collect money for issued invoices. States: `created → processing | requires_action | succeeded | failed |
canceled | uncertain`.

- The payment row is committed before the provider is called, with one provider idempotency key per payment (`e13-<id>`).
  A lost or ambiguous response leaves the payment `uncertain` (incident `payment_uncertain`); it is never re-sent blindly.
  Kit job `resources.reconcile_payment` and `reconcilePayment(s)` ask the provider (by reference, else by the original
  idempotency key) and apply the answer; "no record at the provider" closes the attempt as failed
  (`provider_has_no_record`). In-flight payments count against the invoice's outstanding amount, so a second charge for the
  same money cannot be started while one is unresolved.
- Webhooks: signature `t=<unix>,v1=<hex HMAC-SHA256("<t>.<body>")>` verified in constant time over the raw body with a
  timestamp tolerance (default 300 s); the provider event id is stored unique (`provider_events`), so a duplicate or
  replayed delivery is acknowledged and changes nothing; an event older than the last applied one is ignored
  (`ignored_stale`); `succeeded` is terminal. On success exactly one ledger entry is posted (Dr 1200, Cr 1100), the invoice
  is marked paid when fully covered and its revenue records become `reconciled` (`resources.revenue_reconciled`).
- Adapter interface `PaymentProvider { name, mode: 'sandbox'|'test'|'live', createPayment, fetchPayment, recover, verifyWebhook }`.
- **Sandbox provider** (`SandboxProcessor` + `SandboxProvider`, clearly labelled, ids `sbx_…`): a simulator with its own
  persisted payments/events, idempotency keys, signed webhooks and controllable declines (`sandbox_decline:<code>`), delays
  (`sandbox_delay` + `advance`), lost responses (`sandbox_lost_response`), lost requests (`sandbox_never_arrives`),
  duplicate and out-of-order deliveries. In-process or over HTTP (`sandboxProcessorRoutes`, `sandboxHttpApi`). No money.
- **Stripe adapter** (`StripeProvider`, `stripeFromEnv`): PaymentIntents (default) or Checkout Sessions over HTTPS,
  form-encoded, `Idempotency-Key` on every POST, `Stripe-Signature` verification with tolerance, test/live mode check on
  events, error mapping (402 → declined; 409/429/5xx/timeout → outcome unknown; 401/403 → `provider_unavailable`), no
  secret in any error or log. A live key (`sk_live_`/`rk_live_`) is refused at construction unless
  `allowLivePayments: true`, and then every live payment additionally needs engine config `allowLivePayments` **and** an
  unexpired, unrevoked human grant covering currency and amount (`grant_invalid` otherwise). Stripe-hosted invoices are
  not used; invoices are this engine's own.
- `clientSecret` (Stripe's payer-side confirmation secret) is returned once from `createPayment` and never stored.

## Standard surface

`inspect(ctx, ref)` (kinds `budget, reservation, invoice, license, agreement, expense, contributor, revenue, statement,
payment, journal_entry, usage, work_record`; `null` outside scope; `blocked` for a frozen budget or a license under review,
`stale` for revenue under review, with reasons), `search`, `audit` (hash-chained per tenant), `events`
(`resources:events`; tenant-wide feed for the orchestrator's router), `health`, and

`applyUpstreamChange(ctx, { eventId, kind, refs, reason })` (`resources:write`): for `rights_changed`,
`permission_withdrawn`, `permission_changed`, every license whose subject/permission/release reference matches is flagged
`reviewRequired` (emits `resources.license.blocked`), and revenue records of those licenses or of the referenced
work/release are flagged (emits `resources.revenue.stale`). Nothing is deleted or rewritten. Idempotent by `eventId`;
returns the affected references. Other kinds are recorded and return `[]`. A human clears a review with
`setLicenseStatus(…, 'clear_review', …)` / `clearRevenueReview`.

## Events (type → subject kind)

`resources.budget_created|updated|frozen|unfrozen|closed|warning|exhausted|exceeded` → `budget` (exhausted without a
budget → `unbudgeted_actor`); `resources.budget_reserved|committed|released|reservation_expired|plan_downgraded` →
`reservation`; `resources.usage_recorded` → `usage`; `resources.work_recorded` → `work_record`; `resources.lane_policy_set`
→ `lane_policy`; `resources.expense_recorded|approved|rejected|paid` → `expense`;
`resources.invoice_issued|sent|voided|paid` → `invoice`; `resources.payment_created|succeeded|failed|canceled|uncertain` →
`payment`; `resources.live_payments_granted` → `live_payment_grant`; `resources.revenue_imported` → `revenue_import`;
`resources.revenue_reconciled`, `resources.revenue.stale` → `revenue`;
`resources.license_activated|terminated|expired|expiring|review_cleared`, `resources.license.blocked` → `license`;
`resources.agreement_activated|terminated|expired` → `agreement`; `resources.statement_issued|voided` → `statement`.
Catalog names map as: `budget.reserved` → `resources.budget_reserved`, `budget.exceeded` → `resources.budget_exceeded`,
`expense.recorded` → `resources.expense_recorded`, `license.expiring` → `resources.license_expiring`,
`revenue.reconciled` → `resources.revenue_reconciled`.

## HTTP routes

Standard: `GET /healthz`, `GET /v1/manifest`, `GET /v1/inspect?ref=`, `GET /v1/search?q=`, `GET /v1/audit`,
`GET /v1/events`, `POST /v1/upstream-changes`.

| Area | Routes |
|---|---|
| Budgets | `POST/GET /v1/budgets`, `GET/PATCH /v1/budgets/:id`, `POST /v1/budgets/:id/state` `{action,reason}`, `POST /v1/budgets/:id/assignments` `{actorId,assigned?}`, `POST /v1/fallback-plans`, `GET /v1/burn`, `GET /v1/incidents` |
| Reservations | `POST /v1/reservations` (`withPlans: true` for fallback plans), `GET /v1/reservations`, `GET /v1/reservations/:id`, `POST /v1/reservations/:id/commit` `{amount,detail?}`, `POST /v1/reservations/:id/release` `{reason}`, `POST /v1/reservations/expire` |
| Usage / lanes | `POST/GET /v1/rates`, `POST /v1/usage`, `GET /v1/usage/report`, `GET /v1/usage/top`, `POST/GET /v1/lanes/policy`, `GET /v1/lanes/report`, `POST/GET /v1/work`, `GET /v1/projects/:id/costs` (operator summary; `:id` must be the token's project) |
| Ledger | `POST/GET /v1/ledger/entries`, `POST /v1/ledger/entries/:id/reverse`, `GET /v1/ledger/trial-balance`, `POST /v1/ledger/accounts` |
| Commercial | `POST/GET /v1/contributors`, `PATCH /v1/contributors/:id`, `POST/GET /v1/agreements`, `POST /v1/agreements/:id/status`, `POST/GET /v1/licenses`, `POST /v1/licenses/:id/status`, `POST /v1/licenses/expiry-check`, `POST/GET /v1/expenses`, `POST /v1/expenses/:id/decision`, `POST /v1/expenses/:id/paid` |
| Invoices | `POST/GET /v1/invoices`, `GET /v1/invoices/:id`, `POST /v1/invoices/:id/issue|sent|void`, `GET /v1/invoices/:id/document?format=pdf|html` |
| Revenue | `POST /v1/revenue/imports`, `GET /v1/revenue`, `GET /v1/revenue/by-work`, `POST /v1/revenue/:id/reconcile|clear-review`, `POST/GET /v1/statements`, `GET /v1/statements/:id`, `POST /v1/statements/:id/void`, `GET /v1/pnl`, `GET /v1/exports/:dataset?format=csv|json` |
| Payments | `POST/GET /v1/payments`, `GET /v1/payments/:id`, `POST /v1/payments/:id/reconcile`, `POST /v1/payments/reconcile`, `POST /v1/payments/live-grants`, `DELETE /v1/payments/live-grants/:id`, `POST /v1/payments/webhooks/:provider` (public; signature-authenticated) |

Errors use the kit mapping (`budget_exhausted` → 402, foreign or missing object → 404 "Not found"). `unavailable` and
`provider_unavailable` are answered as 503 with their message by this engine's routes.

## Jobs

`resources.expire_reservation`, `resources.reconcile_payment` (8 attempts with backoff, then dead-lettered). `engine.runJobs(worker?, limit?)`
runs one pass; `serve` loops it and, with the sandbox enabled, delivers pending sandbox webhooks.

## Tests

`npm run check` with `TEST_DATABASE_URL` runs the legacy suites plus `tests/engine-*.test.ts` on real PostgreSQL
(disposable databases), real HTTP sockets, LibreOffice and poppler. Without `TEST_DATABASE_URL` the PostgreSQL tests are
reported as skipped. No test contacts a third party; the "Stripe" server in the tests is a local test double.

## Not implemented

- Currency conversion, tax calculation rules (tax codes/rates are caller-supplied data), credit notes and refunds (a paid
  invoice cannot be voided; a refund must be handled outside and booked with a manual journal entry), partial-payment
  dunning, editing a draft invoice (create a new draft instead).
- Outbound payouts through a provider (expenses and statements are settled outside and recorded).
- Stripe-hosted invoices, Stripe refunds/disputes events (received, stored and ignored as `ignored_type`).
- A scheduler for `checkLicenseExpiry` and for agreement/license auto-expiry (host must call them).
- Per-project restriction of the `events` feed (it is tenant-wide, as the kit's reader is) and compartments (E13 objects
  carry no compartment).
- `ports.authorization` is re-checked only before payment requests, not before every sensitive command.
- Lane membership is not enforced on `recordWork` (work in an unconfigured lane is reported with `configured: false`).
- Organization-level budgets, rates and their administration are authorised by `resources:admin` in any project of the
  tenant; there is no separate organization-admin capability.

## Not verified

- The Stripe adapter is implemented from the public API contract and exercised only against a local test double; it has
  **not** been run against Stripe (no credentials here). No live or test-mode Stripe call has ever been made by this code.
- S3 object storage for invoices (only filesystem and in-memory stores were exercised).
- No independent security review. Not deployed or checked in a hosted environment.
- The kit event feed withholds events while any older transaction is open on the same PostgreSQL cluster; consumers on a
  busy shared cluster see events late (never out of order).
