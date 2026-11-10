// E13 schema. `{s}` is replaced by the schema name. Every row carries tenant_id and project_id.
// Organization-level budgets and rate cards use the reserved project id `_org` (visible to every project of the tenant).
import type { Migration } from '../service-kit.ts';

const core = `
-- Incentive separation, enforced by the database as well as the API:
-- budget selectors must not name a conclusion-type object; commercial bases must not name any E07/E08 object at all.
create function {s}.ok_budget_ref(v text) returns boolean language sql immutable as $f$
  select v is null or v !~* '^E[0-9][0-9]:[a-z0-9_]*(claim|finding|assessment|conclusion|verdict|allegation|accusation|hypothesis)'
$f$;
create function {s}.ok_commercial_ref(v text) returns boolean language sql immutable as $f$
  select v is null or (v !~* '^E0[78]:' and v !~* '^E[0-9][0-9]:[a-z0-9_]*(claim|finding|assessment|conclusion|verdict|allegation|accusation|hypothesis)')
$f$;
create function {s}.ok_commercial_refs(v text[]) returns boolean language sql immutable as $f$
  select v is null or not exists (select 1 from unnest(v) x where not {s}.ok_commercial_ref(x))
$f$;

create table {s}.budgets (
  id uuid primary key, tenant_id text not null, project_id text not null,
  parent_id uuid references {s}.budgets(id),
  level text not null check (level in ('organization','project','objective','run','agent','lane')),
  depth int not null, name text not null, unit text not null,
  categories text[], actor_id text, lane text, objective text, run text,
  period text not null check (period in ('one_off','monthly')),
  ceiling bigint not null check (ceiling >= 0),
  warn_bps int[] not null default '{}',
  overage_tolerance_bps int not null check (overage_tolerance_bps between 0 and 10000),
  state text not null default 'active' check (state in ('active','frozen','closed')),
  state_reason text, revision int not null default 1,
  created_by text not null, created_at timestamptz not null, updated_at timestamptz not null,
  check ((level = 'organization') = (project_id = '_org')),
  check ({s}.ok_budget_ref(objective) and {s}.ok_budget_ref(run) and {s}.ok_budget_ref(lane))
);
create index budgets_scope on {s}.budgets (tenant_id, project_id, unit);
create table {s}.budget_periods (
  budget_id uuid not null references {s}.budgets(id), period_key text not null,
  tenant_id text not null, project_id text not null,
  reserved bigint not null default 0 check (reserved >= 0),
  committed bigint not null default 0 check (committed >= 0),
  warned_bps int[] not null default '{}',
  primary key (budget_id, period_key)
);
create table {s}.budget_assignments (
  budget_id uuid not null references {s}.budgets(id), actor_id text not null,
  tenant_id text not null, project_id text not null,
  assigned_by text not null, assigned_at timestamptz not null, revoked_at timestamptz,
  primary key (budget_id, actor_id)
);
create table {s}.reservations (
  id uuid primary key, tenant_id text not null, project_id text not null,
  idempotency_key text not null, actor_id text not null, actor_kind text not null,
  category text not null, unit text not null, amount bigint not null check (amount > 0),
  subject text not null, lane text, objective text, run text,
  state text not null check (state in ('held','committed','released','expired')),
  actual bigint check (actual >= 0), detail jsonb, reason text, plan text, tradeoffs text,
  budget_ids uuid[] not null, period_keys text[] not null,
  expires_at timestamptz not null, created_at timestamptz not null, settled_at timestamptz,
  unique (tenant_id, project_id, idempotency_key)
);
create index reservations_state on {s}.reservations (tenant_id, project_id, state, expires_at);
create index reservations_budgets on {s}.reservations using gin (budget_ids);
create table {s}.fallback_plans (
  id uuid primary key, tenant_id text not null, project_id text not null,
  category text not null, subject text, unit text not null, name text not null,
  amount bigint not null check (amount > 0), tradeoffs text not null,
  authorized_by text not null, authorized_at timestamptz not null, revoked_at timestamptz,
  unique (tenant_id, project_id, category, unit, name)
);
create table {s}.incidents (
  id uuid primary key, tenant_id text not null, project_id text not null,
  kind text not null, dedupe text not null, budget_id uuid, subject text not null, detail jsonb not null,
  count int not null default 1, first_at timestamptz not null, last_at timestamptz not null,
  resolved_at timestamptz, resolved_by text,
  unique (tenant_id, project_id, kind, dedupe)
);
create table {s}.rates (
  id uuid primary key, tenant_id text not null, project_id text not null,
  provider text not null, model text not null, meter text not null, currency text not null check (currency ~ '^[A-Z]{3}$'),
  price_per_million bigint not null check (price_per_million >= 0),
  effective_from timestamptz not null, note text, created_by text not null, created_at timestamptz not null,
  unique (tenant_id, project_id, provider, model, meter, effective_from)
);
create table {s}.usage (
  id uuid primary key, tenant_id text not null, project_id text not null, idempotency_key text,
  kind text not null check (kind in ('model_call','processing','rendering','storage','messaging','other')),
  provider text not null, model text not null,
  actor_id text not null, actor_kind text not null, lane text, objective text, subject text not null,
  work_ref text check ({s}.ok_commercial_ref(work_ref)),
  quantities jsonb not null, currency text, cost_micro bigint, cost_source text not null check (cost_source in ('rate_card','declared','unpriced')),
  unpriced_meters text[] not null default '{}', rate_ids uuid[] not null default '{}',
  reservation_id uuid, occurred_at timestamptz not null, recorded_at timestamptz not null
);
create index usage_scope on {s}.usage (tenant_id, project_id, occurred_at);
create table {s}.work_records (
  id uuid primary key, tenant_id text not null, project_id text not null,
  actor_id text not null, actor_kind text not null, lane text not null, objective text, task text not null,
  started_at timestamptz not null, ended_at timestamptz not null, check (ended_at >= started_at),
  active_seconds int not null check (active_seconds >= 0), attempts int not null default 1 check (attempts >= 0),
  recorded_by text not null, recorded_at timestamptz not null
);
create index work_scope on {s}.work_records (tenant_id, project_id, started_at);
create table {s}.lane_policies (
  id uuid primary key, tenant_id text not null, project_id text not null, version int not null,
  allocation text not null check (allocation in ('equal','explicit')), measure text not null,
  drift_tolerance_bps int not null, lanes jsonb not null, note text,
  created_by text not null, created_at timestamptz not null,
  unique (tenant_id, project_id, version)
);
create table {s}.upstream_changes (
  tenant_id text not null, project_id text not null, event_id text not null,
  kind text not null, affected jsonb not null, applied_at timestamptz not null,
  primary key (tenant_id, project_id, event_id)
);
`;

const commercial = `
create table {s}.accounts (
  tenant_id text not null, project_id text not null, code text not null, name text not null,
  type text not null check (type in ('asset','liability','equity','revenue','expense')),
  primary key (tenant_id, project_id, code)
);
create table {s}.journal_entries (
  id uuid primary key, seq bigint generated always as identity,
  tenant_id text not null, project_id text not null,
  effective_date text not null check (effective_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'), memo text not null,
  source_kind text not null, source_id text not null,
  reverses uuid unique references {s}.journal_entries(id),
  posted_by text not null, posted_at timestamptz not null
);
create index journal_scope on {s}.journal_entries (tenant_id, project_id, seq);
create table {s}.journal_lines (
  entry_id uuid not null references {s}.journal_entries(id), line_no int not null,
  tenant_id text not null, project_id text not null, account_code text not null,
  debit bigint not null default 0 check (debit >= 0), credit bigint not null default 0 check (credit >= 0),
  check ((debit = 0) <> (credit = 0)),
  work_ref text check ({s}.ok_commercial_ref(work_ref)),
  primary key (entry_id, line_no),
  foreign key (tenant_id, project_id, account_code) references {s}.accounts (tenant_id, project_id, code)
);
create function {s}.journal_check(entry uuid) returns void language plpgsql as $f$
declare d numeric; c numeric; n int; scopes int;
begin
  select coalesce(sum(l.debit),0), coalesce(sum(l.credit),0), count(*),
         count(*) filter (where l.tenant_id <> e.tenant_id or l.project_id <> e.project_id)
    into d, c, n, scopes from {s}.journal_lines l join {s}.journal_entries e on e.id = l.entry_id where l.entry_id = entry;
  if n < 2 or d <> c or d = 0 or scopes > 0 then
    raise exception 'journal entry % is not balanced (debit %, credit %, lines %)', entry, d, c, n using errcode = '23514';
  end if;
end $f$;
create function {s}.journal_entry_trg() returns trigger language plpgsql as $f$ begin perform {s}.journal_check(new.id); return null; end $f$;
create function {s}.journal_line_trg() returns trigger language plpgsql as $f$ begin perform {s}.journal_check(new.entry_id); return null; end $f$;
create function {s}.append_only() returns trigger language plpgsql as $f$
begin raise exception '% is append-only; post a reversing entry instead', tg_table_name using errcode = '23514'; end $f$;
create constraint trigger journal_entry_balanced after insert on {s}.journal_entries deferrable initially deferred for each row execute function {s}.journal_entry_trg();
create constraint trigger journal_line_balanced after insert on {s}.journal_lines deferrable initially deferred for each row execute function {s}.journal_line_trg();
create trigger journal_entries_append_only before update or delete on {s}.journal_entries for each row execute function {s}.append_only();
create trigger journal_lines_append_only before update or delete on {s}.journal_lines for each row execute function {s}.append_only();
create trigger journal_entries_no_truncate before truncate on {s}.journal_entries for each statement execute function {s}.append_only();
create trigger journal_lines_no_truncate before truncate on {s}.journal_lines for each statement execute function {s}.append_only();

create table {s}.contributors (
  id uuid primary key, tenant_id text not null, project_id text not null,
  kind text not null check (kind in ('person','organisation')), display_name text not null,
  roles text[] not null default '{}', rates jsonb not null default '[]', identity_ref text, notes text,
  status text not null default 'active' check (status in ('active','inactive')), revision int not null default 1,
  created_by text not null, created_at timestamptz not null, updated_at timestamptz not null
);
create table {s}.agreements (
  id uuid primary key, tenant_id text not null, project_id text not null,
  contributor_id uuid not null references {s}.contributors(id), title text not null, scope text not null, terms text not null,
  -- Compensation basis vocabulary: deliberately contains no outcome- or finding-contingent type.
  basis text not null check (basis in ('fixed_fee','hourly','daily','per_deliverable','retainer','salary','royalty_share','revenue_share','expense_reimbursement','pro_bono')),
  rate_minor bigint check (rate_minor >= 0), currency text check (currency ~ '^[A-Z]{3}$'),
  share_bps int check (share_bps between 0 and 10000),
  work_refs text[] not null default '{}' check ({s}.ok_commercial_refs(work_refs)),
  starts_on text not null, ends_on text, document_ref text check ({s}.ok_commercial_ref(document_ref)),
  status text not null default 'draft' check (status in ('draft','active','terminated','expired')),
  status_reason text, approved_by text, revision int not null default 1,
  created_by text not null, created_at timestamptz not null, updated_at timestamptz not null
);
create table {s}.licenses (
  id uuid primary key, tenant_id text not null, project_id text not null,
  direction text not null check (direction in ('inbound','outbound')),
  title text not null, counterparty text not null, subject_ref text not null check ({s}.ok_commercial_ref(subject_ref)),
  scope text not null, territory text, starts_on text not null, expires_on text,
  fee_minor bigint not null default 0 check (fee_minor >= 0), currency text check (currency ~ '^[A-Z]{3}$'),
  royalty_bps int not null default 0 check (royalty_bps between 0 and 10000),
  permission_refs text[] not null default '{}', release_refs text[] not null default '{}',
  sources text[] not null default '{}' check ({s}.ok_commercial_refs(sources)),
  document_ref text, agreement_id uuid references {s}.agreements(id),
  status text not null default 'draft' check (status in ('draft','active','expired','terminated')),
  review_required boolean not null default false, review_reasons jsonb not null default '[]',
  expiring_notified_at timestamptz, journal_entry_id uuid, approved_by text, revision int not null default 1,
  created_by text not null, created_at timestamptz not null, updated_at timestamptz not null
);
create index licenses_sources on {s}.licenses using gin (sources);
create table {s}.expenses (
  id uuid primary key, tenant_id text not null, project_id text not null,
  description text not null, category text not null, payee text not null, contributor_id uuid references {s}.contributors(id),
  amount_minor bigint not null check (amount_minor > 0), tax_minor bigint not null default 0 check (tax_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'), incurred_on text not null,
  work_ref text check ({s}.ok_commercial_ref(work_ref)), receipt_ref text check ({s}.ok_commercial_ref(receipt_ref)),
  state text not null check (state in ('submitted','approved','rejected','paid')),
  submitted_by text not null, submitted_at timestamptz not null,
  decided_by text, decided_at timestamptz, decision_note text, check (decided_by is null or decided_by <> submitted_by),
  paid_by text, paid_at timestamptz, payment_reference text,
  approval_entry_id uuid, payment_entry_id uuid
);
create table {s}.invoice_counters (tenant_id text primary key, last_number bigint not null);
create table {s}.invoices (
  id uuid primary key, tenant_id text not null, project_id text not null,
  number text, customer jsonb not null, currency text not null check (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint not null, tax_minor bigint not null, total_minor bigint not null check (total_minor >= 0),
  paid_minor bigint not null default 0, notes text, due_on text, issued_on text,
  state text not null check (state in ('draft','issued','sent','paid','void')),
  check ((state = 'draft') = (number is null)),
  sent jsonb, void_reason text, issue_entry_id uuid, documents jsonb not null default '[]',
  created_by text not null, created_at timestamptz not null, updated_at timestamptz not null,
  unique (tenant_id, number)
);
create table {s}.invoice_lines (
  invoice_id uuid not null references {s}.invoices(id), line_no int not null,
  tenant_id text not null, project_id text not null,
  description text not null, quantity bigint not null check (quantity > 0), unit_price_minor bigint not null check (unit_price_minor >= 0),
  amount_minor bigint not null, tax_code text, tax_rate_bps int not null default 0 check (tax_rate_bps between 0 and 10000), tax_minor bigint not null,
  work_ref text check ({s}.ok_commercial_ref(work_ref)), release_ref text check ({s}.ok_commercial_ref(release_ref)),
  channel text, license_id uuid references {s}.licenses(id),
  primary key (invoice_id, line_no)
);
create table {s}.revenue_records (
  id uuid primary key, tenant_id text not null, project_id text not null,
  source text not null, external_id text not null, channel text not null,
  work_ref text check ({s}.ok_commercial_ref(work_ref)), release_ref text check ({s}.ok_commercial_ref(release_ref)),
  license_id uuid references {s}.licenses(id), invoice_id uuid references {s}.invoices(id),
  period_start text not null, period_end text not null, occurred_on text not null,
  gross_minor bigint not null check (gross_minor >= 0), fees_minor bigint not null default 0 check (fees_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  state text not null check (state in ('recorded','reconciled','reversed')),
  review_required boolean not null default false, review_reasons jsonb not null default '[]',
  reconciliation jsonb, journal_entry_id uuid, recorded_by text not null, recorded_at timestamptz not null,
  unique (tenant_id, project_id, source, external_id)
);
create table {s}.statements (
  id uuid primary key, tenant_id text not null, project_id text not null,
  contributor_id uuid not null references {s}.contributors(id), period_start text not null, period_end text not null,
  totals jsonb not null, state text not null check (state in ('issued','void')), void_reason text,
  entry_ids uuid[] not null default '{}', issued_by text not null, issued_at timestamptz not null
);
create unique index statements_one_live on {s}.statements (tenant_id, project_id, contributor_id, period_start, period_end) where state = 'issued';
create table {s}.statement_lines (
  statement_id uuid not null references {s}.statements(id), line_no int not null,
  tenant_id text not null, project_id text not null,
  agreement_id uuid not null, work_ref text not null check ({s}.ok_commercial_ref(work_ref)), currency text not null,
  revenue_minor bigint not null, share_bps int not null, amount_minor bigint not null, revenue_record_ids uuid[] not null,
  primary key (statement_id, line_no)
);

create table {s}.payments (
  id uuid primary key, tenant_id text not null, project_id text not null,
  invoice_id uuid not null references {s}.invoices(id), provider text not null, mode text not null check (mode in ('sandbox','test','live')),
  amount_minor bigint not null check (amount_minor > 0), currency text not null,
  state text not null check (state in ('created','processing','requires_action','succeeded','failed','canceled','uncertain')),
  provider_ref text, idempotency_key text not null, method text, checkout_url text,
  failure_code text, last_event_at timestamptz, last_checked_at timestamptz, checks int not null default 0,
  entry_id uuid, created_by text not null, created_at timestamptz not null, updated_at timestamptz not null,
  unique (tenant_id, project_id, idempotency_key)
);
create unique index payments_provider_ref on {s}.payments (provider, provider_ref) where provider_ref is not null;
-- Replay resistance: a provider event id is stored once, ever.
create table {s}.provider_events (
  provider text not null, event_id text not null, tenant_id text not null, project_id text not null,
  payment_id uuid, type text not null, event_created_at timestamptz not null, received_at timestamptz not null,
  payload_sha256 text not null, outcome text not null,
  primary key (provider, event_id)
);
create table {s}.live_payment_grants (
  id uuid primary key, tenant_id text not null, project_id text not null, provider text not null,
  max_amount_minor bigint not null check (max_amount_minor > 0), currency text not null,
  granted_by text not null, granted_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz, reason text not null
);

-- Sandbox payment processor: the simulated provider's own persisted state. Never a real processor.
create table {s}.sandbox_payments (
  id text primary key, account text not null, tenant_id text not null, project_id text not null,
  idempotency_key text not null, amount_minor bigint not null, currency text not null, method text not null,
  status text not null, failure_code text, metadata jsonb not null, created_at timestamptz not null, updated_at timestamptz not null,
  unique (account, idempotency_key)
);
create table {s}.sandbox_events (
  id text primary key, seq bigint generated always as identity, account text not null, tenant_id text not null, project_id text not null,
  payment_id text not null references {s}.sandbox_payments(id), type text not null, body jsonb not null,
  created_at timestamptz not null, deliveries int not null default 0, last_status int
);
`;

export const migrations: readonly Migration[] = [
  { id: '001_core', sql: core },
  { id: '002_commercial', sql: commercial },
];
