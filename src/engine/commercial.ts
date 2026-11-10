// Commercial operations: double-entry ledger, contributors, agreements, licenses, expenses, invoices, revenue,
// royalty/revenue-share statements, project P&L, exports and upstream rights changes.
// Nothing in this module accepts a claim, finding or assessment as a basis for pay (see assertNoFactualLinkage).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { urefMatches, parseUref } from '../service-kit.ts';
import type { ServiceContext, Sql, UpstreamChange } from '../service-kit.ts';
import { COMPENSATION_BASES, S, assertNoFactualLinkage, bps, cap, csv, currency, day, humanWith, id, int, limitOf, microToMinor, norm, norms, num, optDay, optStr, ref, sha, str, strings } from './core.ts';
import type { Internals, Tx } from './core.ts';

export const CHART: readonly (readonly [string, string, string])[] = [
  ['1000', 'Cash and bank', 'asset'], ['1100', 'Accounts receivable', 'asset'], ['1200', 'Payment provider and channel clearing', 'asset'],
  ['2000', 'Accounts payable', 'liability'], ['2100', 'Tax payable', 'liability'], ['2200', 'Royalties and revenue shares payable', 'liability'], ['3000', 'Equity', 'equity'],
  ['4000', 'Revenue: licensing and sales', 'revenue'], ['4100', 'Revenue: distribution channels', 'revenue'],
  ['5000', 'Direct costs', 'expense'], ['5100', 'Tax on purchases', 'expense'], ['5200', 'Inbound license costs', 'expense'], ['5400', 'Royalties and revenue shares', 'expense'], ['5500', 'Channel and processing fees', 'expense'],
];
export type JournalLine = { account: string; debit?: number; credit?: number; workRef?: string | null };
export type JournalInput = { date: string; currency: string; memo: string; sourceKind: string; sourceId: string; lines: JournalLine[]; reverses?: string };
type R = Record<string, unknown>;
const pgCode = (e: unknown): string | undefined => (e as { code?: string }).code;
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
export function money(minor: number, cur: string): string {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits ?? 2;
  const s = String(Math.abs(minor)).padStart(digits + 1, '0');
  return `${minor < 0 ? '-' : ''}${digits === 0 ? s : `${s.slice(0, -digits)}.${s.slice(-digits)}`} ${cur}`;
}

/** Posts one balanced journal entry. The database re-checks balance at commit and forbids any later update or delete. */
export async function postEntry(t: Tx, e: JournalInput): Promise<string> {
  const { ctx, sql } = t;
  await sql.query(`insert into ${S}.accounts (tenant_id, project_id, code, name, type) select $1, $2, c.code, c.name, c.type from jsonb_to_recordset($3::jsonb) as c(code text, name text, type text) on conflict do nothing`,
    [ctx.tenantId, ctx.projectId, JSON.stringify(CHART.map(([code, name, type]) => ({ code, name, type })))]);
  const lines = e.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  const debit = lines.reduce((a, l) => a + int(l.debit ?? 0, 'debit'), 0), credit = lines.reduce((a, l) => a + int(l.credit ?? 0, 'credit'), 0);
  invariant(lines.length >= 2 && debit === credit && debit > 0 && lines.every((l) => ((l.debit ?? 0) === 0) !== ((l.credit ?? 0) === 0)), 'invalid_input', 'Journal entry must balance: total debits equal total credits, one side per line');
  const eid = randomUUID();
  try {
    await sql.query(`insert into ${S}.journal_entries (id, tenant_id, project_id, effective_date, currency, memo, source_kind, source_id, reverses, posted_by, posted_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [eid, ctx.tenantId, ctx.projectId, day(e.date, 'date'), currency(e.currency), str(e.memo, 'memo', 500), e.sourceKind, e.sourceId, e.reverses ?? null, ctx.actor.id, ctx.now]);
    for (const [i, l] of lines.entries()) await sql.query(`insert into ${S}.journal_lines (entry_id, line_no, tenant_id, project_id, account_code, debit, credit, work_ref) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [eid, i + 1, ctx.tenantId, ctx.projectId, l.account, l.debit ?? 0, l.credit ?? 0, l.workRef ?? null]);
  } catch (err) {
    if (pgCode(err) === '23505') throw new DomainError('conflict', 'Journal entry was already reversed');
    if (pgCode(err) === '23503') throw new DomainError('invalid_input', 'Unknown ledger account');
    if (pgCode(err) === '23514') throw new DomainError('invalid_incentive_linkage', 'Ledger lines cannot reference knowledge or investigation objects');
    throw err;
  }
  t.audit('ledger.posted', ref('journal_entry', eid), { sourceKind: e.sourceKind, sourceId: e.sourceId, currency: e.currency, amount: debit, ...(e.reverses === undefined ? {} : { reverses: e.reverses }) });
  return eid;
}
/** A correction is a new entry with the debits and credits swapped; the original is never touched. */
export async function reverseEntry(t: Tx, entryId: string, reason: string): Promise<string> {
  const e = (await t.sql.query<R>(`select * from ${S}.journal_entries where id=$1 and tenant_id=$2 and project_id=$3`, [id(entryId), t.ctx.tenantId, t.ctx.projectId]))[0];
  invariant(e !== undefined, 'not_found', 'Not found');
  invariant(e.reverses === null, 'invalid_state', 'A reversing entry cannot itself be reversed; post a new entry');
  const lines = await t.sql.query<R>(`select * from ${S}.journal_lines where entry_id=$1 order by line_no`, [e.id]);
  return postEntry(t, { date: t.ctx.now.slice(0, 10), currency: e.currency as string, memo: `Reversal: ${reason}`.slice(0, 500), sourceKind: 'reversal', sourceId: e.id as string, reverses: e.id as string,
    lines: lines.map((l) => ({ account: l.account_code as string, debit: num(l.credit), credit: num(l.debit), workRef: l.work_ref as string | null })) });
}

export function commercialService(d: Internals) {
  const sc = (ctx: ServiceContext): [string, string] => [ctx.tenantId, ctx.projectId];
  async function one(sql: Sql, ctx: ServiceContext, table: string, rowId: string, lock = false): Promise<R> {
    const r = await sql.query<R>(`select * from ${S}.${table} where id=$1 and tenant_id=$2 and project_id=$3${lock ? ' for update' : ''}`, [id(rowId), ...sc(ctx)]);
    invariant(r[0] !== undefined, 'not_found', 'Not found');
    return r[0];
  }
  const list = (table: string, order: string) => async (ctx: ServiceContext, o: { limit?: number } & Record<string, unknown> = {}): Promise<R[]> => {
    cap(ctx, 'read');
    const filters = Object.entries(o).filter(([k, v]) => k !== 'limit' && v !== undefined && /^[a-z][A-Za-z]*$/.test(k));
    const where = filters.map(([k], i) => ` and ${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}=$${i + 3}`).join('');
    try { return norms(await d.sql.query(`select * from ${S}.${table} where tenant_id=$1 and project_id=$2${where} order by ${order} limit ${limitOf(o.limit)}`, [...sc(ctx), ...filters.map(([, v]) => v)])); }
    catch (e) { if (pgCode(e) === '42703' || pgCode(e) === '22P02') throw new DomainError('invalid_input', 'Unknown filter'); throw e; }
  };
  const guard = (input: unknown): void => assertNoFactualLinkage(input, 'commercial');
  const check = async <T>(p: Promise<T>): Promise<T> => p.catch((e: unknown) => { if (pgCode(e) === '23514') throw new DomainError('invalid_input', 'Value rejected by a ledger or vocabulary constraint'); if (pgCode(e) === '23503') throw new DomainError('invalid_input', 'Referenced record does not exist'); throw e; });

  async function invoiceWithLines(sql: Sql, ctx: ServiceContext, invoiceId: string): Promise<R & { lines: R[] }> {
    const inv = norm<R>(await one(sql, ctx, 'invoices', invoiceId));
    return { ...inv, lines: norms(await sql.query(`select * from ${S}.invoice_lines where invoice_id=$1 order by line_no`, [inv.id])) };
  }
  function invoiceHtml(inv: R & { lines: R[] }): string {
    const c = inv.customer as Record<string, string | undefined>; const cur = inv.currency as string; const iss = d.cfg.issuer;
    const rows = inv.lines.map((l) => `<tr><td>${esc(l.lineNo)}</td><td>${esc(l.description)}</td><td class="n">${esc(l.quantity)}</td><td class="n">${esc(money(l.unitPriceMinor as number, cur))}</td><td class="n">${esc(l.taxCode ?? '')} ${(l.taxRateBps as number) / 100}%</td><td class="n">${esc(money(l.taxMinor as number, cur))}</td><td class="n">${esc(money(l.amountMinor as number, cur))}</td></tr>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice ${esc(inv.number ?? 'DRAFT')}</title><style>body{font-family:sans-serif;font-size:11pt}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px}.n{text-align:right}</style></head><body>
<h1>Invoice ${esc(inv.number ?? 'DRAFT — not issued')}</h1>${inv.state === 'void' ? '<h2>VOID</h2>' : ''}
<p><b>${esc(iss.name)}</b><br>${esc(iss.address ?? '')}<br>${iss.taxId === undefined ? '' : `Tax ID: ${esc(iss.taxId)}<br>`}${esc(iss.email ?? '')}</p>
<p><b>Bill to:</b> ${esc(c.name)}<br>${esc(c.address ?? '')}<br>${c.taxId === undefined ? '' : `Tax ID: ${esc(c.taxId)}`}</p>
<p>Issued: ${esc(inv.issuedOn ?? '—')} &nbsp; Due: ${esc(inv.dueOn ?? '—')} &nbsp; Status: ${esc(inv.state)}</p>
<table><tr><th>#</th><th>Description</th><th>Qty</th><th>Unit price</th><th>Tax</th><th>Tax amount</th><th>Net amount</th></tr>${rows}</table>
<p class="n">Subtotal: ${esc(money(inv.subtotalMinor as number, cur))}<br>Tax: ${esc(money(inv.taxMinor as number, cur))}<br><b>Total: ${esc(money(inv.totalMinor as number, cur))}</b><br>Paid: ${esc(money(inv.paidMinor as number, cur))}</p>
<p>${esc(inv.notes ?? '')}</p></body></html>`;
  }
  async function htmlToPdf(html: string): Promise<Uint8Array> {
    const dir = await mkdtemp(join(tmpdir(), 'e13-invoice-'));
    try {
      await writeFile(join(dir, 'invoice.html'), html, { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        execFile(d.cfg.pdfConverter, ['--headless', '--norestore', `-env:UserInstallation=file://${join(dir, 'profile')}`, '--convert-to', 'pdf:writer_web_pdf_Export', '--outdir', dir, join(dir, 'invoice.html')], { timeout: 120_000, maxBuffer: 1 << 20 },
          (err) => { if (err === null) resolve(); else reject(new DomainError('unavailable', (err as NodeJS.ErrnoException).code === 'ENOENT' ? `PDF rendering is unavailable: converter "${d.cfg.pdfConverter}" (LibreOffice) is not installed` : 'PDF rendering failed or timed out')); });
      });
      try { return new Uint8Array(await readFile(join(dir, 'invoice.pdf'))); } catch { throw new DomainError('unavailable', 'PDF rendering produced no output'); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  const svc = {
    // ───────────── Ledger ─────────────
    /** Manual journal entry (human approval authority). Domain operations post their own entries. */
    async postJournalEntry(ctx: ServiceContext, input: { date: string; currency: string; memo: string; lines: JournalLine[]; idempotencyKey: string }): Promise<{ entryId: string }> {
      humanWith(ctx, 'approve'); guard(input);
      return d.run(ctx, 'journal', str(input.idempotencyKey, 'idempotencyKey', 150), input, async (t) => ({ entryId: await postEntry(t, { ...input, sourceKind: 'manual', sourceId: input.idempotencyKey }) }));
    },
    async reverseJournalEntry(ctx: ServiceContext, entryId: string, reason: string): Promise<{ entryId: string }> {
      humanWith(ctx, 'approve'); str(reason, 'reason', 400);
      return d.run(ctx, 'journal.reverse', undefined, null, async (t) => ({ entryId: await reverseEntry(t, entryId, reason) }));
    },
    async createAccount(ctx: ServiceContext, input: { code: string; name: string; type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' }): Promise<void> {
      cap(ctx, 'admin'); invariant(/^[0-9A-Za-z._-]{1,20}$/.test(input.code), 'invalid_input', 'Invalid account code');
      await d.run(ctx, 'account', undefined, null, async (t) => {
        await check(t.sql.query(`insert into ${S}.accounts (tenant_id, project_id, code, name, type) values ($1,$2,$3,$4,$5)`, [...sc(ctx), input.code, str(input.name, 'name', 200), input.type]).catch((e: unknown) => { if (pgCode(e) === '23505') throw new DomainError('conflict', 'Account exists'); throw e; }));
        t.audit('ledger.account_created', ref('account', input.code), { type: input.type });
      });
    },
    async listJournal(ctx: ServiceContext, o: { sourceKind?: string; sourceId?: string; limit?: number } = {}): Promise<R[]> {
      cap(ctx, 'read');
      const entries = norms<R>(await d.sql.query(`select * from ${S}.journal_entries where tenant_id=$1 and project_id=$2 and ($3::text is null or source_kind=$3) and ($4::text is null or source_id=$4) order by seq desc limit ${limitOf(o.limit)}`, [...sc(ctx), o.sourceKind ?? null, o.sourceId ?? null]));
      const lines = norms<R>(await d.sql.query(`select * from ${S}.journal_lines where entry_id = any($1::uuid[]) order by entry_id, line_no`, [entries.map((e) => e.id)]));
      return entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entryId === e.id) }));
    },
    /** Per account and currency. `balanced` is true when total debits equal total credits (always, by constraint). */
    async trialBalance(ctx: ServiceContext): Promise<{ accounts: R[]; totals: Record<string, { debit: number; credit: number }>; balanced: boolean }> {
      cap(ctx, 'read');
      const rows = await d.sql.query<Record<string, string>>(`select a.code, a.name, a.type, e.currency, sum(l.debit) as debit, sum(l.credit) as credit from ${S}.journal_lines l join ${S}.journal_entries e on e.id=l.entry_id
        join ${S}.accounts a on a.tenant_id=l.tenant_id and a.project_id=l.project_id and a.code=l.account_code where l.tenant_id=$1 and l.project_id=$2 group by 1,2,3,4 order by 1,4`, sc(ctx));
      const totals: Record<string, { debit: number; credit: number }> = {};
      const accounts = rows.map((r) => { const debit = num(r.debit), credit = num(r.credit); const tot = (totals[r.currency!] ??= { debit: 0, credit: 0 }); tot.debit += debit; tot.credit += credit; return { code: r.code, name: r.name, type: r.type, currency: r.currency, debit, credit, balance: debit - credit }; });
      return { accounts, totals, balanced: Object.values(totals).every((x) => x.debit === x.credit) };
    },

    // ───────────── Contributors and agreements ─────────────
    async createContributor(ctx: ServiceContext, input: { kind: 'person' | 'organisation'; displayName: string; roles?: string[]; rates?: { basis: string; amountMinor: number; currency: string; note?: string }[]; identityRef?: string; notes?: string; idempotencyKey?: string }): Promise<R> {
      cap(ctx, 'write'); guard(input);
      const rates = (input.rates ?? []).map((r) => { invariant((COMPENSATION_BASES as readonly string[]).includes(r.basis), 'invalid_input', `Unknown compensation basis; allowed: ${COMPENSATION_BASES.join(', ')}`); return { basis: r.basis, amountMinor: int(r.amountMinor, 'amountMinor'), currency: currency(r.currency), ...(r.note === undefined ? {} : { note: str(r.note, 'note', 300) }) }; });
      return d.run(ctx, 'contributor', input.idempotencyKey, input, async (t) => {
        const row = (await check(t.sql.query(`insert into ${S}.contributors (id, tenant_id, project_id, kind, display_name, roles, rates, identity_ref, notes, created_by, created_at, updated_at) values ($1,$2,$3,$4,$5,$6::text[],$7::jsonb,$8,$9,$10,$11,$11) returning *`,
          [randomUUID(), ...sc(ctx), input.kind, str(input.displayName, 'displayName', 200), strings(input.roles, 'roles'), JSON.stringify(rates), optStr(input.identityRef, 'identityRef', 300), optStr(input.notes, 'notes'), ctx.actor.id, ctx.now])))[0]!;
        t.audit('contributor.created', ref('contributor', row.id as string), { kind: input.kind });
        return norm(row);
      });
    },
    async updateContributor(ctx: ServiceContext, contributorId: string, patch: { displayName?: string; roles?: string[]; rates?: { basis: string; amountMinor: number; currency: string }[]; status?: 'active' | 'inactive'; expectedRevision?: number }): Promise<R> {
      cap(ctx, 'write'); guard(patch);
      for (const r of patch.rates ?? []) invariant((COMPENSATION_BASES as readonly string[]).includes(r.basis), 'invalid_input', 'Unknown compensation basis');
      return d.run(ctx, 'contributor.update', undefined, null, async (t) => {
        const c = await one(t.sql, ctx, 'contributors', contributorId, true);
        if (patch.expectedRevision !== undefined) invariant(patch.expectedRevision === c.revision, 'revision_conflict', 'Contributor was changed by someone else');
        const row = (await check(t.sql.query(`update ${S}.contributors set display_name=$2, roles=$3::text[], rates=$4::jsonb, status=$5, revision=revision+1, updated_at=$6 where id=$1 returning *`,
          [c.id, patch.displayName ?? c.display_name, patch.roles ?? c.roles, JSON.stringify(patch.rates ?? c.rates), patch.status ?? c.status, ctx.now])))[0]!;
        t.audit('contributor.updated', ref('contributor', c.id as string), { revision: row.revision as number, previousRates: c.rates as Json });
        return norm(row);
      });
    },
    listContributors: list('contributors', 'display_name'),
    async createAgreement(ctx: ServiceContext, input: { contributorId: string; title: string; scope: string; terms: string; basis: typeof COMPENSATION_BASES[number]; rateMinor?: number; currency?: string; shareBps?: number; workRefs?: string[]; startsOn: string; endsOn?: string; documentRef?: string; idempotencyKey?: string }): Promise<R> {
      cap(ctx, 'write'); guard(input);
      invariant((COMPENSATION_BASES as readonly string[]).includes(input.basis), 'invalid_input', `Unknown compensation basis; allowed: ${COMPENSATION_BASES.join(', ')}`);
      const share = input.basis === 'royalty_share' || input.basis === 'revenue_share';
      if (share) invariant(input.shareBps !== undefined && (input.workRefs ?? []).length > 0, 'invalid_input', 'Share agreements need shareBps and at least one work reference');
      else if (input.basis !== 'pro_bono' && input.basis !== 'expense_reimbursement') invariant(input.rateMinor !== undefined && input.currency !== undefined, 'invalid_input', 'Rate and currency are required for this basis');
      for (const w of input.workRefs ?? []) parseUref(w);
      return d.run(ctx, 'agreement', input.idempotencyKey, input, async (t) => {
        const c = await one(t.sql, ctx, 'contributors', input.contributorId);
        const row = (await check(t.sql.query(`insert into ${S}.agreements (id, tenant_id, project_id, contributor_id, title, scope, terms, basis, rate_minor, currency, share_bps, work_refs, starts_on, ends_on, document_ref, created_by, created_at, updated_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],$13,$14,$15,$16,$17,$17) returning *`,
          [randomUUID(), ...sc(ctx), c.id, str(input.title, 'title', 300), str(input.scope, 'scope', 5000), str(input.terms, 'terms', 20000), input.basis, input.rateMinor === undefined ? null : int(input.rateMinor, 'rateMinor'), input.currency === undefined ? null : currency(input.currency),
            input.shareBps === undefined ? null : int(input.shareBps, 'shareBps', 0, 10000), strings(input.workRefs, 'workRefs'), day(input.startsOn, 'startsOn'), optDay(input.endsOn, 'endsOn'), optStr(input.documentRef, 'documentRef', 300), ctx.actor.id, ctx.now])))[0]!;
        t.audit('agreement.created', ref('agreement', row.id as string), { contributorId: c.id as string, basis: input.basis });
        return norm(row);
      });
    },
    /** activate (draft → active, requires document evidence) | terminate | expire. Commercial authority: human with resources:approve. */
    async setAgreementStatus(ctx: ServiceContext, agreementId: string, action: 'activate' | 'terminate' | 'expire', reason: string): Promise<R> {
      humanWith(ctx, 'approve'); str(reason, 'reason', 500);
      return d.run(ctx, 'agreement.status', undefined, null, async (t) => {
        const a = await one(t.sql, ctx, 'agreements', agreementId, true);
        if (action === 'activate') { invariant(a.status === 'draft', 'invalid_state', `Agreement is ${a.status as string}`); invariant(a.document_ref !== null, 'invalid_state', 'An agreement needs document evidence before activation'); }
        else invariant(a.status === 'active', 'invalid_state', `Agreement is ${a.status as string}`);
        const status = action === 'activate' ? 'active' : action === 'terminate' ? 'terminated' : 'expired';
        const row = (await t.sql.query(`update ${S}.agreements set status=$2, status_reason=$3, approved_by=case when $2='active' then $4 else approved_by end, revision=revision+1, updated_at=$5 where id=$1 returning *`, [a.id, status, reason, ctx.actor.id, ctx.now]))[0]!;
        t.event(`resources.agreement_${status === 'active' ? 'activated' : status}`, ref('agreement', a.id as string), { agreementId: a.id as string });
        t.audit(`agreement.${status}`, ref('agreement', a.id as string), { reason });
        return norm(row);
      });
    },
    listAgreements: list('agreements', 'created_at desc'),

    // ───────────── Licenses ─────────────
    /** inbound = assets we license from others; outbound = licenses we grant for works (linked to E11 permissions and E12 releases). */
    async createLicense(ctx: ServiceContext, input: { direction: 'inbound' | 'outbound'; title: string; counterparty: string; subjectRef: string; scope: string; territory?: string; startsOn: string; expiresOn?: string; feeMinor?: number; currency?: string; royaltyBps?: number; permissionRefs?: string[]; releaseRefs?: string[]; documentRef?: string; agreementId?: string; idempotencyKey?: string }): Promise<R> {
      cap(ctx, 'write'); guard(input);
      const refs = [str(input.subjectRef, 'subjectRef', 300), ...strings(input.permissionRefs, 'permissionRefs'), ...strings(input.releaseRefs, 'releaseRefs')];
      for (const r of refs) parseUref(r);
      const fee = int(input.feeMinor ?? 0, 'feeMinor'); if (fee > 0) invariant(input.currency !== undefined, 'invalid_input', 'Currency is required with a fee');
      return d.run(ctx, 'license', input.idempotencyKey, input, async (t) => {
        if (input.agreementId !== undefined) await one(t.sql, ctx, 'agreements', input.agreementId);
        const row = (await check(t.sql.query(`insert into ${S}.licenses (id, tenant_id, project_id, direction, title, counterparty, subject_ref, scope, territory, starts_on, expires_on, fee_minor, currency, royalty_bps, permission_refs, release_refs, sources, document_ref, agreement_id, created_by, created_at, updated_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16::text[],$17::text[],$18,$19,$20,$21,$21) returning *`,
          [randomUUID(), ...sc(ctx), input.direction, str(input.title, 'title', 300), str(input.counterparty, 'counterparty', 300), input.subjectRef, str(input.scope, 'scope', 5000), optStr(input.territory, 'territory', 300), day(input.startsOn, 'startsOn'), optDay(input.expiresOn, 'expiresOn'),
            fee, input.currency === undefined ? null : currency(input.currency), int(input.royaltyBps ?? 0, 'royaltyBps', 0, 10000), strings(input.permissionRefs, 'permissionRefs'), strings(input.releaseRefs, 'releaseRefs'), [...new Set(refs)], optStr(input.documentRef, 'documentRef', 300), input.agreementId ?? null, ctx.actor.id, ctx.now])))[0]!;
        t.audit('license.created', ref('license', row.id as string), { direction: input.direction, subjectRef: input.subjectRef });
        return norm(row);
      });
    },
    /** activate | terminate | expire | clear_review. Activating an inbound license with a fee posts its cost (Dr 5200, Cr 2000). */
    async setLicenseStatus(ctx: ServiceContext, licenseId: string, action: 'activate' | 'terminate' | 'expire' | 'clear_review', reason: string): Promise<R> {
      humanWith(ctx, 'approve'); str(reason, 'reason', 500);
      return d.run(ctx, 'license.status', undefined, null, async (t) => {
        const l = await one(t.sql, ctx, 'licenses', licenseId, true);
        let entry = l.journal_entry_id as string | null, status = l.status as string;
        if (action === 'clear_review') invariant(l.review_required === true, 'invalid_state', 'License is not under review');
        else if (action === 'activate') {
          invariant(l.status === 'draft', 'invalid_state', `License is ${status}`); status = 'active';
          if (l.direction === 'inbound' && num(l.fee_minor) > 0) entry = await postEntry(t, { date: ctx.now.slice(0, 10), currency: l.currency as string, memo: `Inbound license: ${l.title as string}`.slice(0, 500), sourceKind: 'license', sourceId: l.id as string, lines: [{ account: '5200', debit: num(l.fee_minor), workRef: l.subject_ref as string }, { account: '2000', credit: num(l.fee_minor) }] });
        } else { invariant(l.status === 'active', 'invalid_state', `License is ${status}`); status = action === 'terminate' ? 'terminated' : 'expired'; }
        const reasons = action === 'clear_review' ? [...(l.review_reasons as Json[]), { clearedBy: ctx.actor.id, at: ctx.now, reason }] : l.review_reasons;
        const row = (await t.sql.query(`update ${S}.licenses set status=$2, review_required=$3, review_reasons=$4::jsonb, journal_entry_id=$5, approved_by=case when $6 then $7 else approved_by end, revision=revision+1, updated_at=$8 where id=$1 returning *`,
          [l.id, status, action === 'clear_review' ? false : l.review_required, JSON.stringify(reasons), entry, action === 'activate', ctx.actor.id, ctx.now]))[0]!;
        t.event(`resources.license_${action === 'activate' ? 'activated' : action === 'clear_review' ? 'review_cleared' : status}`, ref('license', l.id as string), { licenseId: l.id as string });
        t.audit(`license.${action}`, ref('license', l.id as string), { reason });
        return norm(row);
      });
    },
    listLicenses: list('licenses', 'created_at desc'),
    /** Emits `resources.license_expiring` once per active license expiring within the window; marks passed ones for expiry review. */
    async checkLicenseExpiry(ctx: ServiceContext, o: { withinDays?: number } = {}): Promise<{ expiring: string[] }> {
      cap(ctx, 'write');
      const until = new Date(Date.parse(ctx.now) + int(o.withinDays ?? 30, 'withinDays', 0, 3650) * 86_400_000).toISOString().slice(0, 10);
      return d.run(ctx, 'license.expiry', undefined, null, async (t) => {
        const rows = await t.sql.query<R>(`update ${S}.licenses set expiring_notified_at=$3 where tenant_id=$1 and project_id=$2 and status='active' and expires_on is not null and expires_on <= $4 and expiring_notified_at is null returning id, expires_on, direction`, [...sc(ctx), ctx.now, until]);
        for (const r of rows) t.event('resources.license_expiring', ref('license', r.id as string), { licenseId: r.id as string, expiresOn: r.expires_on as string, direction: r.direction as string });
        return { expiring: rows.map((r) => ref('license', r.id as string)) };
      });
    },

    // ───────────── Expenses (submitted → approved by a different human → paid) ─────────────
    async submitExpense(ctx: ServiceContext, input: { description: string; category: string; payee: string; contributorId?: string; amountMinor: number; taxMinor?: number; currency: string; incurredOn: string; workRef?: string; receiptRef?: string; idempotencyKey: string }): Promise<R> {
      cap(ctx, 'write'); guard(input);
      const amount = int(input.amountMinor, 'amountMinor', 1), tax = int(input.taxMinor ?? 0, 'taxMinor', 0, amount);
      return d.run(ctx, 'expense', str(input.idempotencyKey, 'idempotencyKey', 150), input, async (t) => {
        if (input.contributorId !== undefined) await one(t.sql, ctx, 'contributors', input.contributorId);
        const row = (await check(t.sql.query(`insert into ${S}.expenses (id, tenant_id, project_id, description, category, payee, contributor_id, amount_minor, tax_minor, currency, incurred_on, work_ref, receipt_ref, state, submitted_by, submitted_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'submitted',$14,$15) returning *`,
          [randomUUID(), ...sc(ctx), str(input.description, 'description'), str(input.category, 'category', 100), str(input.payee, 'payee', 300), input.contributorId ?? null, amount, tax, currency(input.currency), day(input.incurredOn, 'incurredOn'), optStr(input.workRef, 'workRef', 300), optStr(input.receiptRef, 'receiptRef', 300), ctx.actor.id, ctx.now])))[0]!;
        t.event('resources.expense_recorded', ref('expense', row.id as string), { expenseId: row.id as string, amountMinor: amount, currency: input.currency, category: input.category });
        t.audit('expense.submitted', ref('expense', row.id as string), { amountMinor: amount, currency: input.currency });
        return norm(row);
      });
    },
    /** Separation of duties: the decider must be a human other than the submitter (also a database constraint). */
    async decideExpense(ctx: ServiceContext, expenseId: string, decision: 'approve' | 'reject', note: string): Promise<R> {
      humanWith(ctx, 'approve'); str(note, 'note', 1000);
      return d.run(ctx, 'expense.decide', undefined, null, async (t) => {
        const e = await one(t.sql, ctx, 'expenses', expenseId, true);
        invariant(e.state === 'submitted', 'invalid_state', `Expense is ${e.state as string}`);
        if (e.submitted_by === ctx.actor.id) throw new DomainError('forbidden', 'An expense must be approved by a different person than the one who submitted it');
        let entry: string | null = null;
        if (decision === 'approve') {
          const amount = num(e.amount_minor), tax = num(e.tax_minor);
          entry = await postEntry(t, { date: e.incurred_on as string, currency: e.currency as string, memo: `Expense: ${e.description as string}`.slice(0, 500), sourceKind: 'expense', sourceId: e.id as string,
            lines: [{ account: '5000', debit: amount - tax, workRef: e.work_ref as string | null }, { account: '5100', debit: tax }, { account: '2000', credit: amount }] });
        }
        const row = (await t.sql.query(`update ${S}.expenses set state=$2, decided_by=$3, decided_at=$4, decision_note=$5, approval_entry_id=$6 where id=$1 returning *`, [e.id, decision === 'approve' ? 'approved' : 'rejected', ctx.actor.id, ctx.now, note, entry]))[0]!;
        t.event(`resources.expense_${decision === 'approve' ? 'approved' : 'rejected'}`, ref('expense', e.id as string), { expenseId: e.id as string });
        t.audit(`expense.${decision === 'approve' ? 'approved' : 'rejected'}`, ref('expense', e.id as string), { note });
        return norm(row);
      });
    },
    /** Records that an approved expense was paid outside this engine (bank reference). No money is moved by this call. */
    async markExpensePaid(ctx: ServiceContext, expenseId: string, input: { reference: string; paidOn?: string }): Promise<R> {
      cap(ctx, 'spend'); str(input?.reference, 'reference', 300);
      return d.run(ctx, 'expense.pay', undefined, null, async (t) => {
        const e = await one(t.sql, ctx, 'expenses', expenseId, true);
        if (e.state === 'paid' && e.payment_reference === input.reference) return norm<R>(e);
        invariant(e.state === 'approved', 'invalid_state', `Expense is ${e.state as string}`);
        const entry = await postEntry(t, { date: input.paidOn ?? ctx.now.slice(0, 10), currency: e.currency as string, memo: `Expense paid: ${input.reference}`.slice(0, 500), sourceKind: 'expense_payment', sourceId: e.id as string, lines: [{ account: '2000', debit: num(e.amount_minor) }, { account: '1000', credit: num(e.amount_minor) }] });
        const row = (await t.sql.query(`update ${S}.expenses set state='paid', paid_by=$2, paid_at=$3, payment_reference=$4, payment_entry_id=$5 where id=$1 returning *`, [e.id, ctx.actor.id, ctx.now, input.reference, entry]))[0]!;
        t.event('resources.expense_paid', ref('expense', e.id as string), { expenseId: e.id as string });
        t.audit('expense.paid', ref('expense', e.id as string), { reference: input.reference });
        return norm(row);
      });
    },
    listExpenses: list('expenses', 'submitted_at desc'),

    // ───────────── Invoices ─────────────
    async createInvoice(ctx: ServiceContext, input: { customer: { name: string; address?: string; taxId?: string; email?: string; country?: string }; currency: string; dueOn?: string; notes?: string; lines: { description: string; quantity: number; unitPriceMinor: number; taxCode?: string; taxRateBps?: number; workRef?: string; releaseRef?: string; channel?: string; licenseId?: string }[]; idempotencyKey: string }): Promise<R> {
      cap(ctx, 'write'); guard(input);
      invariant(Array.isArray(input.lines) && input.lines.length >= 1 && input.lines.length <= 500, 'invalid_input', 'An invoice needs between 1 and 500 lines');
      const customer = { name: str(input.customer?.name, 'customer.name', 300), ...Object.fromEntries(['address', 'taxId', 'email', 'country'].flatMap((k) => { const v = (input.customer as Record<string, unknown>)[k]; return v === undefined ? [] : [[k, str(v, `customer.${k}`, 1000)]]; })) };
      const lines = input.lines.map((l) => {
        const amount = num(int(l.quantity, 'quantity', 1) * int(l.unitPriceMinor, 'unitPriceMinor', 0)); const rate = int(l.taxRateBps ?? 0, 'taxRateBps', 0, 10000);
        return { ...l, amount, rate, tax: Math.round((amount * rate) / 10000) };
      });
      const subtotal = lines.reduce((a, l) => a + l.amount, 0), tax = lines.reduce((a, l) => a + l.tax, 0);
      return d.run(ctx, 'invoice', str(input.idempotencyKey, 'idempotencyKey', 150), input, async (t) => {
        const iid = randomUUID();
        await t.sql.query(`insert into ${S}.invoices (id, tenant_id, project_id, customer, currency, subtotal_minor, tax_minor, total_minor, notes, due_on, state, created_by, created_at, updated_at) values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,'draft',$11,$12,$12)`,
          [iid, ...sc(ctx), JSON.stringify(customer), currency(input.currency), subtotal, tax, num(subtotal + tax), optStr(input.notes, 'notes', 5000), optDay(input.dueOn, 'dueOn'), ctx.actor.id, ctx.now]);
        for (const [i, l] of lines.entries()) {
          if (l.licenseId !== undefined) await one(t.sql, ctx, 'licenses', l.licenseId);
          await check(t.sql.query(`insert into ${S}.invoice_lines (invoice_id, line_no, tenant_id, project_id, description, quantity, unit_price_minor, amount_minor, tax_code, tax_rate_bps, tax_minor, work_ref, release_ref, channel, license_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [iid, i + 1, ...sc(ctx), str(l.description, 'description', 1000), l.quantity, l.unitPriceMinor, l.amount, optStr(l.taxCode, 'taxCode', 50), l.rate, l.tax, optStr(l.workRef, 'workRef', 300), optStr(l.releaseRef, 'releaseRef', 300), optStr(l.channel, 'channel', 100), l.licenseId ?? null]));
        }
        t.audit('invoice.drafted', ref('invoice', iid), { currency: input.currency, totalMinor: subtotal + tax });
        return invoiceWithLines(t.sql, ctx, iid);
      });
    },
    /** Assigns the next number of the organization's gapless sequence, posts receivable/revenue/tax and records revenue per line. */
    async issueInvoice(ctx: ServiceContext, invoiceId: string): Promise<R> {
      humanWith(ctx, 'approve');
      return d.run(ctx, 'invoice.issue', undefined, null, async (t) => {
        const inv = await one(t.sql, ctx, 'invoices', invoiceId, true);
        if (inv.state !== 'draft') { invariant(inv.state !== 'void', 'invalid_state', 'Invoice is void'); return invoiceWithLines(t.sql, ctx, invoiceId); }
        invariant(/^[A-Za-z0-9._-]{0,20}$/.test(d.cfg.invoicePrefix), 'invalid_config', 'Invalid invoice prefix');
        const n = num((await t.sql.query<{ last_number: string }>(`insert into ${S}.invoice_counters (tenant_id, last_number) values ($1, 1) on conflict (tenant_id) do update set last_number = ${S}.invoice_counters.last_number + 1 returning last_number`, [ctx.tenantId]))[0]!.last_number);
        const number = `${d.cfg.invoicePrefix}${String(n).padStart(6, '0')}`; const today = ctx.now.slice(0, 10);
        const lines = await t.sql.query<R>(`select * from ${S}.invoice_lines where invoice_id=$1 order by line_no`, [inv.id]);
        const entry = await postEntry(t, { date: today, currency: inv.currency as string, memo: `Invoice ${number}`, sourceKind: 'invoice', sourceId: inv.id as string,
          lines: [{ account: '1100', debit: num(inv.total_minor) }, ...lines.map((l) => ({ account: '4000', credit: num(l.amount_minor), workRef: l.work_ref as string | null })), { account: '2100', credit: num(inv.tax_minor) }] });
        for (const l of lines) if (num(l.amount_minor) > 0) await t.sql.query(`insert into ${S}.revenue_records (id, tenant_id, project_id, source, external_id, channel, work_ref, release_ref, license_id, invoice_id, period_start, period_end, occurred_on, gross_minor, currency, state, journal_entry_id, recorded_by, recorded_at)
          values ($1,$2,$3,'invoice',$4,$5,$6,$7,$8,$9,$10,$10,$10,$11,$12,'recorded',$13,$14,$15)`, [randomUUID(), ...sc(ctx), `${inv.id as string}:${l.line_no as number}`, (l.channel as string | null) ?? 'direct', l.work_ref, l.release_ref, l.license_id, inv.id, today, l.amount_minor, inv.currency, entry, ctx.actor.id, ctx.now]);
        await t.sql.query(`update ${S}.invoices set state='issued', number=$2, issued_on=$3, issue_entry_id=$4, updated_at=$5 where id=$1`, [inv.id, number, today, entry, ctx.now]);
        t.event('resources.invoice_issued', ref('invoice', inv.id as string), { invoiceId: inv.id as string, number, totalMinor: num(inv.total_minor), currency: inv.currency as string });
        t.audit('invoice.issued', ref('invoice', inv.id as string), { number });
        return invoiceWithLines(t.sql, ctx, invoiceId);
      });
    },
    /** Records that the invoice was delivered (by E03 or by hand). This engine does not send mail itself. */
    async markInvoiceSent(ctx: ServiceContext, invoiceId: string, input: { channel: string; reference?: string }): Promise<R> {
      cap(ctx, 'send');
      return d.run(ctx, 'invoice.sent', undefined, null, async (t) => {
        const inv = await one(t.sql, ctx, 'invoices', invoiceId, true);
        invariant(inv.state === 'issued' || inv.state === 'sent', 'invalid_state', `Invoice is ${inv.state as string}`);
        await t.sql.query(`update ${S}.invoices set state='sent', sent=$2::jsonb, updated_at=$3 where id=$1`, [inv.id, JSON.stringify({ channel: str(input?.channel, 'channel', 100), reference: optStr(input.reference, 'reference', 300), at: ctx.now, by: ctx.actor.id }), ctx.now]);
        t.event('resources.invoice_sent', ref('invoice', inv.id as string), { invoiceId: inv.id as string, channel: input.channel });
        t.audit('invoice.sent', ref('invoice', inv.id as string), { channel: input.channel });
        return invoiceWithLines(t.sql, ctx, invoiceId);
      });
    },
    /** Voids an issued/sent invoice with no money received: reversing entry, revenue records reversed, number retained. */
    async voidInvoice(ctx: ServiceContext, invoiceId: string, reason: string): Promise<R> {
      humanWith(ctx, 'approve'); str(reason, 'reason', 500);
      return d.run(ctx, 'invoice.void', undefined, null, async (t) => {
        const inv = await one(t.sql, ctx, 'invoices', invoiceId, true);
        if (inv.state === 'void') return invoiceWithLines(t.sql, ctx, invoiceId);
        invariant(inv.state === 'issued' || inv.state === 'sent', 'invalid_state', inv.state === 'draft' ? 'A draft has nothing to void' : 'A paid invoice cannot be voided');
        invariant(num(inv.paid_minor) === 0, 'invalid_state', 'Money was already received for this invoice');
        const open = await t.sql.query(`select 1 from ${S}.payments where invoice_id=$1 and state in ('created','processing','requires_action','uncertain') limit 1`, [inv.id]);
        invariant(open.length === 0, 'invalid_state', 'A payment for this invoice is still in flight');
        await reverseEntry(t, inv.issue_entry_id as string, `void invoice ${inv.number as string}: ${reason}`);
        await t.sql.query(`update ${S}.revenue_records set state='reversed' where invoice_id=$1`, [inv.id]);
        await t.sql.query(`update ${S}.invoices set state='void', void_reason=$2, updated_at=$3 where id=$1`, [inv.id, reason, ctx.now]);
        t.event('resources.invoice_voided', ref('invoice', inv.id as string), { invoiceId: inv.id as string });
        t.audit('invoice.voided', ref('invoice', inv.id as string), { reason });
        return invoiceWithLines(t.sql, ctx, invoiceId);
      });
    },
    async getInvoice(ctx: ServiceContext, invoiceId: string): Promise<R> { cap(ctx, 'read'); return invoiceWithLines(d.sql, ctx, invoiceId); },
    listInvoices: list('invoices', 'created_at desc'),
    /** Renders HTML, or PDF through LibreOffice. With an object store the document is stored under `<tenant>/<project>/invoices/…`. */
    async renderInvoice(ctx: ServiceContext, invoiceId: string, format: 'html' | 'pdf' = 'pdf'): Promise<{ format: string; contentType: string; bytes: Uint8Array; sha256: string; key: string | null }> {
      cap(ctx, 'read'); invariant(format === 'html' || format === 'pdf', 'invalid_input', 'Unknown format');
      const inv = await invoiceWithLines(d.sql, ctx, invoiceId);
      const html = invoiceHtml(inv);
      const bytes = format === 'html' ? new Uint8Array(Buffer.from(html, 'utf8')) : await htmlToPdf(html);
      let key: string | null = null;
      if (d.objects !== undefined) {
        key = `${ctx.tenantId}/${ctx.projectId}/invoices/${inv.id as string}/${(inv.number as string | null) ?? 'draft'}-${inv.state as string}.${format}`;
        await d.objects.put(key, bytes);
        await d.run(ctx, 'invoice.render', undefined, null, async (t) => {
          await t.sql.query(`update ${S}.invoices set documents = (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(documents) x where x->>'key' <> $2) || $3::jsonb where id=$1`, [inv.id, key, JSON.stringify([{ key, format, sha256: sha(bytes), size: bytes.byteLength, renderedAt: ctx.now }])]);
          t.audit('invoice.rendered', ref('invoice', inv.id as string), { format, sha256: sha(bytes) });
        });
      }
      return { format, contentType: format === 'pdf' ? 'application/pdf' : 'text/html; charset=utf-8', bytes, sha256: sha(bytes), key };
    },

    // ───────────── Revenue ─────────────
    /** Imports distribution/channel receipts. `(source, externalId)` is unique: a re-imported row creates no second income record. */
    async importRevenue(ctx: ServiceContext, input: { source: string; channel: string; rows: { externalId: string; workRef?: string; releaseRef?: string; licenseId?: string; periodStart: string; periodEnd: string; occurredOn?: string; grossMinor: number; feesMinor?: number; currency: string }[]; idempotencyKey?: string }): Promise<{ imported: string[]; duplicates: string[] }> {
      cap(ctx, 'write'); guard(input);
      invariant(Array.isArray(input.rows) && input.rows.length >= 1 && input.rows.length <= 5000, 'invalid_input', 'Between 1 and 5000 rows are required');
      const source = str(input.source, 'source', 100); invariant(source !== 'invoice', 'invalid_input', 'Source "invoice" is reserved');
      return d.run(ctx, 'revenue.import', input.idempotencyKey, input, async (t) => {
        const imported: string[] = [], duplicates: string[] = [];
        for (const r of input.rows) {
          const gross = int(r.grossMinor, 'grossMinor'), fees = int(r.feesMinor ?? 0, 'feesMinor', 0, gross); const rid = randomUUID();
          if (r.licenseId !== undefined) await one(t.sql, ctx, 'licenses', r.licenseId);
          const ins = await check(t.sql.query(`insert into ${S}.revenue_records (id, tenant_id, project_id, source, external_id, channel, work_ref, release_ref, license_id, period_start, period_end, occurred_on, gross_minor, fees_minor, currency, state, recorded_by, recorded_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'recorded',$16,$17) on conflict (tenant_id, project_id, source, external_id) do nothing returning id`,
            [rid, ...sc(ctx), source, str(r.externalId, 'externalId', 200), str(input.channel, 'channel', 100), optStr(r.workRef, 'workRef', 300), optStr(r.releaseRef, 'releaseRef', 300), r.licenseId ?? null, day(r.periodStart, 'periodStart'), day(r.periodEnd, 'periodEnd'), day(r.occurredOn ?? r.periodEnd, 'occurredOn'), gross, fees, currency(r.currency), ctx.actor.id, ctx.now]));
          if (ins.length === 0) { duplicates.push(r.externalId); continue; }
          if (gross > 0) {
            const entry = await postEntry(t, { date: r.occurredOn ?? r.periodEnd, currency: r.currency, memo: `Revenue ${source} ${r.externalId}`.slice(0, 500), sourceKind: 'revenue', sourceId: rid, lines: [{ account: '1200', debit: gross - fees }, { account: '5500', debit: fees, workRef: r.workRef ?? null }, { account: '4100', credit: gross, workRef: r.workRef ?? null }] });
            await t.sql.query(`update ${S}.revenue_records set journal_entry_id=$2 where id=$1`, [rid, entry]);
          }
          imported.push(rid);
        }
        t.event('resources.revenue_imported', ref('revenue_import', sha(`${source}:${ctx.requestId}`).slice(0, 24)), { source, imported: imported.length, duplicates: duplicates.length });
        return { imported, duplicates };
      });
    },
    /** Matches an imported revenue record to money actually received (bank/settlement reference). Idempotent. */
    async reconcileRevenue(ctx: ServiceContext, revenueId: string, input: { reference: string; receivedOn?: string }): Promise<R> {
      cap(ctx, 'write'); str(input?.reference, 'reference', 300);
      return d.run(ctx, 'revenue.reconcile', undefined, null, async (t) => {
        const r = await one(t.sql, ctx, 'revenue_records', revenueId, true);
        if (r.state === 'reconciled') return norm<R>(r);
        invariant(r.state === 'recorded' && r.source !== 'invoice', 'invalid_state', r.source === 'invoice' ? 'Invoice revenue is reconciled by its payment' : `Revenue record is ${r.state as string}`);
        const net = num(r.gross_minor) - num(r.fees_minor);
        if (net > 0) await postEntry(t, { date: input.receivedOn ?? ctx.now.slice(0, 10), currency: r.currency as string, memo: `Settlement ${input.reference}`.slice(0, 500), sourceKind: 'revenue_settlement', sourceId: r.id as string, lines: [{ account: '1000', debit: net }, { account: '1200', credit: net }] });
        const row = (await t.sql.query(`update ${S}.revenue_records set state='reconciled', reconciliation=$2::jsonb where id=$1 returning *`, [r.id, JSON.stringify({ reference: input.reference, at: ctx.now, by: ctx.actor.id })]))[0]!;
        t.event('resources.revenue_reconciled', ref('revenue', r.id as string), { revenueId: r.id as string, source: r.source as string });
        t.audit('revenue.reconciled', ref('revenue', r.id as string), { reference: input.reference });
        return norm(row);
      });
    },
    listRevenue: list('revenue_records', 'recorded_at desc'),
    /** Which works earn revenue, per work/release/channel/currency. A commercial read; never delivered to factual workflows. */
    async revenueByWork(ctx: ServiceContext, o: { from?: string; to?: string } = {}): Promise<R[]> {
      cap(ctx, 'read');
      return (await d.sql.query<Record<string, string | null>>(`select work_ref, release_ref, channel, currency, sum(gross_minor) as gross, sum(fees_minor) as fees, count(*) as records, count(*) filter (where review_required) as under_review from ${S}.revenue_records
        where tenant_id=$1 and project_id=$2 and state <> 'reversed' and ($3::text is null or occurred_on >= $3) and ($4::text is null or occurred_on <= $4) group by 1,2,3,4 order by sum(gross_minor) desc`, [...sc(ctx), o.from ?? null, o.to ?? null]))
        .map((r) => ({ workRef: r.work_ref, releaseRef: r.release_ref, channel: r.channel, currency: r.currency, grossMinor: num(r.gross), feesMinor: num(r.fees), netMinor: num(r.gross) - num(r.fees), records: num(r.records), underReview: num(r.under_review) }));
    },

    // ───────────── Royalty / revenue-share statements ─────────────
    /** royalty_share applies to gross revenue, revenue_share to revenue net of channel fees. Revenue under rights review is held back, not paid. */
    async issueStatement(ctx: ServiceContext, input: { contributorId: string; periodStart: string; periodEnd: string; idempotencyKey: string }): Promise<R> {
      humanWith(ctx, 'approve');
      const from = day(input.periodStart, 'periodStart'), to = day(input.periodEnd, 'periodEnd'); invariant(from <= to, 'invalid_input', 'Period is reversed');
      return d.run(ctx, 'statement', str(input.idempotencyKey, 'idempotencyKey', 150), input, async (t) => {
        const c = await one(t.sql, ctx, 'contributors', input.contributorId);
        const agreements = await t.sql.query<R>(`select * from ${S}.agreements where contributor_id=$1 and tenant_id=$2 and project_id=$3 and basis in ('royalty_share','revenue_share') and status in ('active','expired','terminated') and starts_on <= $5 and (ends_on is null or ends_on >= $4) order by created_at`, [c.id, ...sc(ctx), from, to]);
        const lines: { agreementId: string; workRef: string; currency: string; revenue: number; share: number; amount: number; ids: string[] }[] = []; let held = 0;
        for (const a of agreements) for (const work of a.work_refs as string[]) {
          const lo = from > (a.starts_on as string) ? from : (a.starts_on as string), hi = a.ends_on !== null && (a.ends_on as string) < to ? (a.ends_on as string) : to;
          const recs = await t.sql.query<R>(`select id, currency, gross_minor, fees_minor, review_required from ${S}.revenue_records where tenant_id=$1 and project_id=$2 and work_ref=$3 and state <> 'reversed' and occurred_on between $4 and $5`, [...sc(ctx), work, lo, hi]);
          held += recs.filter((r) => r.review_required === true).length;
          for (const cur of new Set(recs.map((r) => r.currency as string))) {
            const mine = recs.filter((r) => r.currency === cur && r.review_required !== true); if (mine.length === 0) continue;
            const revenue = mine.reduce((s, r) => s + num(r.gross_minor) - (a.basis === 'revenue_share' ? num(r.fees_minor) : 0), 0);
            lines.push({ agreementId: a.id as string, workRef: work, currency: cur, revenue, share: a.share_bps as number, amount: Math.floor((revenue * (a.share_bps as number)) / 10000), ids: mine.map((r) => r.id as string) });
          }
        }
        const totals: Record<string, number> = {}; for (const l of lines) totals[l.currency] = (totals[l.currency] ?? 0) + l.amount;
        const sid = randomUUID(); const entries: string[] = [];
        for (const [cur, total] of Object.entries(totals)) if (total > 0) entries.push(await postEntry(t, { date: to, currency: cur, memo: `Statement ${from}..${to} for contributor ${c.id as string}`, sourceKind: 'statement', sourceId: sid,
          lines: [...lines.filter((l) => l.currency === cur).map((l) => ({ account: '5400', debit: l.amount, workRef: l.workRef })), { account: '2200', credit: total }] }));
        await t.sql.query(`insert into ${S}.statements (id, tenant_id, project_id, contributor_id, period_start, period_end, totals, state, entry_ids, issued_by, issued_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,'issued',$8::uuid[],$9,$10)`, [sid, ...sc(ctx), c.id, from, to, JSON.stringify(totals), entries, ctx.actor.id, ctx.now])
          .catch((e: unknown) => { if (pgCode(e) === '23505') throw new DomainError('conflict', 'A statement for this contributor and period already exists; void it before issuing a corrected one'); throw e; });
        for (const [i, l] of lines.entries()) await t.sql.query(`insert into ${S}.statement_lines (statement_id, line_no, tenant_id, project_id, agreement_id, work_ref, currency, revenue_minor, share_bps, amount_minor, revenue_record_ids) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid[])`, [sid, i + 1, ...sc(ctx), l.agreementId, l.workRef, l.currency, l.revenue, l.share, l.amount, l.ids]);
        t.event('resources.statement_issued', ref('statement', sid), { statementId: sid, contributorId: c.id as string, totals });
        t.audit('statement.issued', ref('statement', sid), { periodStart: from, periodEnd: to, totals, heldForReview: held });
        return { ...(await svc.getStatement(ctx, sid, t.sql)), heldForReview: held };
      });
    },
    async voidStatement(ctx: ServiceContext, statementId: string, reason: string): Promise<R> {
      humanWith(ctx, 'approve'); str(reason, 'reason', 400);
      return d.run(ctx, 'statement.void', undefined, null, async (t) => {
        const s = await one(t.sql, ctx, 'statements', statementId, true);
        if (s.state === 'void') return svc.getStatement(ctx, statementId, t.sql);
        for (const e of s.entry_ids as string[]) await reverseEntry(t, e, `void statement: ${reason}`);
        await t.sql.query(`update ${S}.statements set state='void', void_reason=$2 where id=$1`, [s.id, reason]);
        t.event('resources.statement_voided', ref('statement', s.id as string), { statementId: s.id as string });
        t.audit('statement.voided', ref('statement', s.id as string), { reason });
        return svc.getStatement(ctx, statementId, t.sql);
      });
    },
    async getStatement(ctx: ServiceContext, statementId: string, sql: Sql = d.sql): Promise<R> {
      cap(ctx, 'read');
      const s = norm<R>(await one(sql, ctx, 'statements', statementId));
      return { ...s, lines: norms(await sql.query(`select * from ${S}.statement_lines where statement_id=$1 order by line_no`, [s.id])) };
    },
    listStatements: list('statements', 'issued_at desc'),

    // ───────────── P&L and margins ─────────────
    /**
     * margin = revenue − direct costs − allocated usage costs. Revenue and direct costs come from the ledger (so voids and
     * reversals are reflected); usage costs come from metered usage attributed to a work. Per currency; never converted.
     */
    async projectPnl(ctx: ServiceContext, o: { from?: string; to?: string } = {}): Promise<{ currencies: Record<string, { revenueMinor: number; directCostsMinor: number; usageCostsMinor: number; marginMinor: number; marginBps: number }>; works: R[]; unpricedUsageRecords: number }> {
      cap(ctx, 'read');
      const ledger = await d.sql.query<Record<string, string | null>>(`select e.currency, l.work_ref, a.type, sum(l.credit - l.debit) as net from ${S}.journal_lines l join ${S}.journal_entries e on e.id=l.entry_id
        join ${S}.accounts a on a.tenant_id=l.tenant_id and a.project_id=l.project_id and a.code=l.account_code
        where l.tenant_id=$1 and l.project_id=$2 and a.type in ('revenue','expense') and ($3::text is null or e.effective_date >= $3) and ($4::text is null or e.effective_date <= $4) group by 1,2,3`, [...sc(ctx), o.from ?? null, o.to ?? null]);
      const usage = await d.sql.query<Record<string, string | null>>(`select currency, work_ref, sum(cost_micro) as micro from ${S}.usage where tenant_id=$1 and project_id=$2 and cost_micro is not null and ($3::text is null or occurred_at >= $3::date) and ($4::text is null or occurred_at < $4::date + 1) group by 1,2`, [...sc(ctx), o.from ?? null, o.to ?? null]);
      const unpriced = num((await d.sql.query<{ n: string }>(`select count(*) as n from ${S}.usage where tenant_id=$1 and project_id=$2 and (cost_micro is null or cardinality(unpriced_meters) > 0)`, sc(ctx)))[0]!.n);
      const cells = new Map<string, { currency: string; workRef: string | null; revenueMinor: number; directCostsMinor: number; usageCostsMinor: number }>();
      const cell = (cur: string, work: string | null) => { const k = `${cur}|${work ?? ''}`; let c = cells.get(k); if (c === undefined) { c = { currency: cur, workRef: work, revenueMinor: 0, directCostsMinor: 0, usageCostsMinor: 0 }; cells.set(k, c); } return c; };
      for (const r of ledger) { const c = cell(r.currency!, r.work_ref ?? null); if (r.type === 'revenue') c.revenueMinor += num(r.net); else c.directCostsMinor -= num(r.net); }
      for (const u of usage) cell(u.currency!, u.work_ref ?? null).usageCostsMinor += microToMinor(num(u.micro));
      const finish = <T extends { revenueMinor: number; directCostsMinor: number; usageCostsMinor: number }>(c: T) => { const marginMinor = c.revenueMinor - c.directCostsMinor - c.usageCostsMinor; return { ...c, marginMinor, marginBps: c.revenueMinor === 0 ? 0 : bps(marginMinor, c.revenueMinor) }; };
      const currencies: Record<string, ReturnType<typeof finish<{ revenueMinor: number; directCostsMinor: number; usageCostsMinor: number }>>> = {};
      for (const c of cells.values()) { const tot = (currencies[c.currency] ??= { revenueMinor: 0, directCostsMinor: 0, usageCostsMinor: 0, marginMinor: 0, marginBps: 0 }); tot.revenueMinor += c.revenueMinor; tot.directCostsMinor += c.directCostsMinor; tot.usageCostsMinor += c.usageCostsMinor; }
      for (const k of Object.keys(currencies)) currencies[k] = finish(currencies[k]!);
      return { currencies, works: [...cells.values()].map(finish).sort((a, b) => b.revenueMinor - a.revenueMinor), unpricedUsageRecords: unpriced };
    },

    // ───────────── Exports ─────────────
    async exportData(ctx: ServiceContext, input: { dataset: string; format?: 'csv' | 'json' }): Promise<{ dataset: string; format: string; contentType: string; rows: number; body: string }> {
      cap(ctx, 'export');
      const tables: Record<string, string> = { budgets: 'budgets', reservations: 'reservations', usage: 'usage', work: 'work_records', incidents: 'incidents', contributors: 'contributors', agreements: 'agreements', licenses: 'licenses', expenses: 'expenses', invoices: 'invoices', invoice_lines: 'invoice_lines', revenue: 'revenue_records', payments: 'payments', statements: 'statements', statement_lines: 'statement_lines', rates: 'rates' };
      const format = input.format ?? 'json'; invariant(format === 'csv' || format === 'json', 'invalid_input', 'Unknown format');
      let rows: R[];
      if (input.dataset === 'journal') rows = norms(await d.sql.query(`select e.seq, e.id as entry_id, e.effective_date, e.currency, e.memo, e.source_kind, e.source_id, e.reverses, e.posted_by, e.posted_at, l.line_no, l.account_code, l.debit, l.credit, l.work_ref from ${S}.journal_entries e join ${S}.journal_lines l on l.entry_id=e.id where e.tenant_id=$1 and e.project_id=$2 order by e.seq, l.line_no`, sc(ctx)));
      else { const table = tables[input.dataset]; invariant(table !== undefined, 'invalid_input', `Unknown dataset; available: journal, ${Object.keys(tables).join(', ')}`); rows = norms(await d.sql.query(`select * from ${S}.${table} where tenant_id=$1 and project_id=$2 order by 1`, sc(ctx))); }
      await d.run(ctx, 'export', undefined, null, async (t) => { t.audit('export.created', ref('export', input.dataset), { format, rows: rows.length }); });
      return { dataset: input.dataset, format, contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json', rows: rows.length, body: format === 'csv' ? csv(rows) : JSON.stringify(rows) };
    },

    // ───────────── Upstream rights changes ─────────────
    /**
     * rights_changed / permission_withdrawn / permission_changed on a licensed work or its permission: affected licenses and
     * their revenue items are flagged for human review (outbound licenses are reported blocked for new use). Nothing is deleted.
     */
    async applyUpstreamChange(ctx: ServiceContext, change: UpstreamChange): Promise<{ affected: string[] }> {
      cap(ctx, 'write');
      str(change?.eventId, 'eventId', 200); invariant(Array.isArray(change.refs) && change.refs.length <= 1000, 'invalid_input', 'refs must be a list');
      for (const r of change.refs) parseUref(r);
      return d.run(ctx, 'upstream', undefined, null, async (t) => {
        const prior = await t.sql.query<{ affected: string[] }>(`select affected from ${S}.upstream_changes where tenant_id=$1 and project_id=$2 and event_id=$3`, [...sc(ctx), change.eventId]);
        if (prior[0] !== undefined) return { affected: prior[0].affected };
        const affected: string[] = [];
        if (['rights_changed', 'permission_withdrawn', 'permission_changed'].includes(change.kind) && change.refs.length > 0) {
          const bases = change.refs.map((r) => r.replace(/@\d+$/, ''));
          const note = JSON.stringify([{ cause: change.eventId, kind: change.kind, reason: String(change.reason ?? '').slice(0, 500), at: ctx.now, refs: change.refs as string[] }]);
          const candidates = await t.sql.query<R>(`select * from ${S}.licenses where tenant_id=$1 and project_id=$2 and exists (select 1 from unnest(sources) s where regexp_replace(s, '@[0-9]+$', '') = any($3::text[])) for update`, [...sc(ctx), bases]);
          const licenses = candidates.filter((l) => (l.sources as string[]).some((s) => change.refs.some((r) => urefMatches(r, s))));
          for (const l of licenses) {
            await t.sql.query(`update ${S}.licenses set review_required=true, review_reasons = review_reasons || $2::jsonb, updated_at=$3 where id=$1`, [l.id, note, ctx.now]);
            const u = ref('license', l.id as string); affected.push(u);
            t.event('resources.license.blocked', u, { reason: change.kind, cause: change.eventId, direction: l.direction as string });
          }
          const revs = await t.sql.query<R>(`update ${S}.revenue_records set review_required=true, review_reasons = review_reasons || $4::jsonb where tenant_id=$1 and project_id=$2 and state <> 'reversed'
            and (license_id = any($3::uuid[]) or regexp_replace(coalesce(work_ref,''), '@[0-9]+$', '') = any($5::text[]) or regexp_replace(coalesce(release_ref,''), '@[0-9]+$', '') = any($5::text[])) returning id`, [...sc(ctx), licenses.map((l) => l.id), note, bases]);
          for (const r of revs) { const u = ref('revenue', r.id as string); affected.push(u); t.event('resources.revenue.stale', u, { reason: change.kind, cause: change.eventId }); }
        }
        await t.sql.query(`insert into ${S}.upstream_changes (tenant_id, project_id, event_id, kind, affected, applied_at) values ($1,$2,$3,$4,$5::jsonb,$6)`, [...sc(ctx), change.eventId, String(change.kind), JSON.stringify(affected), ctx.now]);
        t.audit('upstream.applied', ref('upstream_change', sha(change.eventId).slice(0, 24)), { eventId: change.eventId, kind: String(change.kind), affected });
        return { affected };
      });
    },
    async clearRevenueReview(ctx: ServiceContext, revenueId: string, reason: string): Promise<R> {
      humanWith(ctx, 'approve'); str(reason, 'reason', 500);
      return d.run(ctx, 'revenue.review', undefined, null, async (t) => {
        const r = await one(t.sql, ctx, 'revenue_records', revenueId, true);
        invariant(r.review_required === true, 'invalid_state', 'Revenue record is not under review');
        const row = (await t.sql.query(`update ${S}.revenue_records set review_required=false, review_reasons = review_reasons || $2::jsonb where id=$1 returning *`, [r.id, JSON.stringify([{ clearedBy: ctx.actor.id, at: ctx.now, reason }])]))[0]!;
        t.audit('revenue.review_cleared', ref('revenue', r.id as string), { reason });
        return norm(row);
      });
    },
  };
  return svc;
}
