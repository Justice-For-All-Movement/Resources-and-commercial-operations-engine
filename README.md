# Resources and Commercial Operations Engine

Reusable country-neutral engine. Initial capabilities and limits are documented in [architecture](docs/ARCHITECTURE.md); the canonical work plan is [registry/prs.json](registry/prs.json).

```sh
npm ci
npm run check
```

All research and jurisdiction configuration belong in downstream deployments. Implementation, local tests, CI, merge and live acceptance are separate.

## Service layer

The engine's service layer (budgets and the `BudgetPort`, usage metering, lane allocation, double-entry ledger, invoices,
expenses, licenses, revenue, statements, payment adapters) lives in `src/engine/` and is documented in
[docs/ENGINE_API.md](docs/ENGINE_API.md), including what is not implemented or not verified.

```sh
# test (real PostgreSQL; tests create and drop their own databases)
TEST_DATABASE_URL=postgresql://pam:pam@127.0.0.1:5432/postgres npm run check

# run standalone (sandbox payments only; no real processor is contacted)
DATABASE_URL=postgresql://… PORT=8013 IDENTITY_PUBLIC_KEYS='{"kid":"-----BEGIN PUBLIC KEY-----…"}' PAYMENT_SANDBOX=1 npm run serve
```

```ts
import { createEngine, migrate, routes } from '@accountability/resource-operations/engine';
await migrate(sql);
const engine = createEngine({ sql });
const { reservationId } = await engine.budgetPort.reserve(ctx, { category: 'render', amount: 120, unit: 'render_seconds', subject: 'E10:render:r1', idempotencyKey: 'r1' });
await engine.budgetPort.commit(ctx, reservationId, { amount: 97 });
```

Spending is denied by default: without an applicable budget, or for an agent or service without an explicit budget
assignment, `reserve` throws `budget_exhausted`. Real payments stay off unless a live key, `ALLOW_LIVE_PAYMENTS=true` and a
human grant are all present. Invoice PDFs need LibreOffice.
