import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/engine/index.ts';
import { code, ctx, memoryObjects, needsPg, withEngine, settled } from './engine-helpers.ts';

const alice = ctx({ actorId: 'alice' }), bob = ctx({ actorId: 'bob' });
const agent = ctx({ actorId: 'agent-1', kind: 'agent' });

test('ledger: always balanced by constraint, append-only, corrections are reversing entries', needsPg, async () => {
  await withEngine(async (engine, sql) => {
    const { entryId } = await engine.postJournalEntry(alice, { date: '2030-01-05', currency: 'EUR', memo: 'Opening funds', idempotencyKey: 'j1', lines: [{ account: '1000', debit: 50_000 }, { account: '3000', credit: 50_000 }] });
    assert.deepEqual(await engine.postJournalEntry(alice, { date: '2030-01-05', currency: 'EUR', memo: 'Opening funds', idempotencyKey: 'j1', lines: [{ account: '1000', debit: 50_000 }, { account: '3000', credit: 50_000 }] }), { entryId });
    await assert.rejects(engine.postJournalEntry(alice, { date: '2030-01-05', currency: 'EUR', memo: 'bad', idempotencyKey: 'j2', lines: [{ account: '1000', debit: 100 }, { account: '3000', credit: 99 }] }), code('invalid_input'));
    await assert.rejects(engine.postJournalEntry(alice, { date: '2030-01-05', currency: 'EUR', memo: 'bad', idempotencyKey: 'j3', lines: [{ account: '9999', debit: 1 }, { account: '3000', credit: 1 }] }), code('invalid_input'));
    await assert.rejects(engine.postJournalEntry(agent, { date: '2030-01-05', currency: 'EUR', memo: 'x', idempotencyKey: 'j4', lines: [{ account: '1000', debit: 1 }, { account: '3000', credit: 1 }] }), code('forbidden'));
    // the database itself refuses an unbalanced or mutated ledger, whatever the application does
    const id = '11111111-1111-4111-8111-111111111111';
    await assert.rejects(sql.tx(async (tx) => {
      await tx.query(`insert into e13_resources.journal_entries (id, tenant_id, project_id, effective_date, currency, memo, source_kind, source_id, posted_by, posted_at) values ($1,'org-a','proj-1','2030-01-01','EUR','raw','manual','x','x',now())`, [id]);
      await tx.query(`insert into e13_resources.journal_lines (entry_id, line_no, tenant_id, project_id, account_code, debit) values ($1,1,'org-a','proj-1','1000',5)`, [id]);
      await tx.query(`insert into e13_resources.journal_lines (entry_id, line_no, tenant_id, project_id, account_code, credit) values ($1,2,'org-a','proj-1','3000',4)`, [id]);
    }), /not balanced/);
    await assert.rejects(sql.query(`update e13_resources.journal_lines set debit = 1 where entry_id = $1 and line_no = 1`, [entryId]), /append-only/);
    await assert.rejects(sql.query(`delete from e13_resources.journal_entries where id = $1`, [entryId]), /append-only/);
    await assert.rejects(sql.query(`truncate e13_resources.journal_lines`), /append-only/);
    const rev = await engine.reverseJournalEntry(alice, entryId, 'entered twice');
    await assert.rejects(engine.reverseJournalEntry(alice, entryId, 'again'), code('conflict'));
    await assert.rejects(engine.reverseJournalEntry(alice, rev.entryId, 'reverse the reversal'), code('invalid_state'));
    const tb = await engine.trialBalance(alice);
    assert.equal(tb.balanced, true); assert.deepEqual(tb.totals.EUR, { debit: 100_000, credit: 100_000 });
    assert.ok(tb.accounts.every((a) => a.balance === 0));
    const journal = await engine.listJournal(alice);
    assert.equal(journal.length, 2); assert.equal(journal[0]!.reverses, entryId);
    assert.equal((await engine.listJournal(ctx({ tenantId: 'org-b' }))).length, 0);
  });
});

test('expenses: submitted → approved by a different human → paid; separation of duties', needsPg, async () => {
  await withEngine(async (engine, sql) => {
    const e = await engine.submitExpense(alice, { description: 'Archive copies', category: 'research', payee: 'Example Archive Ltd', amountMinor: 12_000, taxMinor: 2_000, currency: 'EUR', incurredOn: '2030-02-01', workRef: 'E09:work:film', receiptRef: 'E05:evidence_version:r1@1', idempotencyKey: 'x1' });
    assert.equal(e.state, 'submitted');
    await assert.rejects(engine.decideExpense(alice, e.id as string, 'approve', 'mine'), code('forbidden'));
    await assert.rejects(engine.decideExpense(agent, e.id as string, 'approve', 'auto'), code('forbidden'));
    await assert.rejects(engine.decideExpense(ctx({ actorId: 'bob', capabilities: ['resources:*'] }), e.id as string, 'approve', 'wildcard'), code('forbidden'));
    await assert.rejects(engine.markExpensePaid(bob, e.id as string, { reference: 'BANK-1' }), code('invalid_state'));
    await assert.rejects(sql.query(`update e13_resources.expenses set state='approved', decided_by=submitted_by where id=$1`, [e.id]), /check constraint/);
    assert.equal((await engine.decideExpense(bob, e.id as string, 'approve', 'receipt checked')).state, 'approved');
    await assert.rejects(engine.decideExpense(bob, e.id as string, 'reject', 'changed my mind'), code('invalid_state'));
    assert.equal((await engine.markExpensePaid(bob, e.id as string, { reference: 'BANK-1' })).state, 'paid');
    assert.equal((await engine.markExpensePaid(bob, e.id as string, { reference: 'BANK-1' })).state, 'paid');
    const r = await engine.submitExpense(alice, { description: 'Lunch', category: 'travel', payee: 'Cafe', amountMinor: 900, currency: 'EUR', incurredOn: '2030-02-02', idempotencyKey: 'x2' });
    assert.equal((await engine.decideExpense(bob, r.id as string, 'reject', 'not project related')).state, 'rejected');
    const tb = await engine.trialBalance(alice);
    const bal = (c: string) => tb.accounts.find((a) => a.code === c)?.balance;
    assert.deepEqual([bal('5000'), bal('5100'), bal('2000'), bal('1000')], [10_000, 2_000, 0, -12_000]); assert.ok(tb.balanced);
    const pnl = await engine.projectPnl(alice);
    assert.equal(pnl.works.find((w) => w.workRef === 'E09:work:film')!.directCostsMinor, 10_000);
    assert.ok((await settled(engine, alice)).some((x) => x.type === 'resources.expense_recorded'));
    assert.equal((await engine.listExpenses(alice, { state: 'paid' })).length, 1);
    assert.equal((await engine.listExpenses(ctx({ projectId: 'proj-2' }))).length, 0);
  });
});

test('incentives are separated from facts: API and schema reject claim/finding/assessment linkage', needsPg, async () => {
  await withEngine(async (engine, sql) => {
    const c = await engine.createContributor(alice, { kind: 'person', displayName: 'Rowan Example', roles: ['researcher'], rates: [{ basis: 'daily', amountMinor: 30_000, currency: 'EUR' }] });
    const base = { contributorId: c.id as string, title: 'Research', scope: 'Archive research', terms: 'Thirty days', startsOn: '2030-01-01', documentRef: 'E05:evidence_version:contract1@1' };
    for (const basis of ['per_finding', 'success_fee', 'bonus_on_publication_of_allegation', 'outcome_based']) {
      await assert.rejects(engine.createAgreement(alice, { ...base, basis: basis as never, rateMinor: 1, currency: 'EUR' }), code('invalid_input'));
      await assert.rejects(engine.createContributor(alice, { kind: 'person', displayName: 'X', rates: [{ basis, amountMinor: 1, currency: 'EUR' }] }), code('invalid_input'));
    }
    const linked = code('invalid_incentive_linkage');
    await assert.rejects(engine.createAgreement(alice, { ...base, basis: 'royalty_share', shareBps: 500, workRefs: ['E08:finding:f1'] }), linked);
    await assert.rejects(engine.createAgreement(alice, { ...base, basis: 'fixed_fee', rateMinor: 1, currency: 'EUR', workRefs: ['E07:claim:c1'] }), linked);
    await assert.rejects(engine.createAgreement(alice, { ...base, basis: 'fixed_fee', rateMinor: 1, currency: 'EUR', findingRef: 'x' } as never), linked);
    await assert.rejects(engine.createAgreement(alice, { ...base, basis: 'fixed_fee', rateMinor: 1, currency: 'EUR', documentRef: 'E08:assessment:a1' }), linked);
    await assert.rejects(engine.submitExpense(alice, { description: 'Bonus', category: 'bonus', payee: 'Rowan', amountMinor: 1, currency: 'EUR', incurredOn: '2030-01-01', workRef: 'E08:finding:f9', idempotencyKey: 'b1' }), linked);
    await assert.rejects(engine.submitExpense(alice, { description: 'Bonus', category: 'bonus', payee: 'Rowan', amountMinor: 1, currency: 'EUR', incurredOn: '2030-01-01', idempotencyKey: 'b2', claimRefs: ['E07:claim:1'] } as never), linked);
    await assert.rejects(engine.createInvoice(alice, { customer: { name: 'C' }, currency: 'EUR', idempotencyKey: 'b3', lines: [{ description: 'x', quantity: 1, unitPriceMinor: 1, workRef: 'E07:assessment:1' }] }), linked);
    await assert.rejects(engine.importRevenue(alice, { source: 'store', channel: 'vod', rows: [{ externalId: '1', workRef: 'E08:finding:f1', periodStart: '2030-01-01', periodEnd: '2030-01-31', grossMinor: 1, currency: 'EUR' }] }), linked);
    await assert.rejects(engine.createLicense(alice, { direction: 'outbound', title: 'T', counterparty: 'B', subjectRef: 'E08:finding:f1', scope: 's', startsOn: '2030-01-01' }), linked);
    await assert.rejects(engine.createBudget(alice, { name: 'Per finding', level: 'objective', unit: 'EUR', ceiling: 1, objective: 'E08:finding:f1' }), linked);
    await assert.rejects(engine.createBudget(alice, { name: 'Quota', level: 'project', unit: 'EUR', ceiling: 1, findingsQuota: 5 } as never), linked);
    await assert.rejects(engine.postJournalEntry(alice, { date: '2030-01-01', currency: 'EUR', memo: 'bonus', idempotencyKey: 'b4', lines: [{ account: '5000', debit: 1, workRef: 'E08:finding:f1' }, { account: '1000', credit: 1 }] }), linked);
    // schema level, bypassing the API entirely
    const raw = (q: string) => assert.rejects(sql.query(q), /check constraint/);
    await raw(`insert into e13_resources.agreements (id, tenant_id, project_id, contributor_id, title, scope, terms, basis, starts_on, created_by, created_at, updated_at) values (gen_random_uuid(),'org-a','proj-1','${c.id as string}','t','s','t','per_finding','2030-01-01','x',now(),now())`);
    await raw(`insert into e13_resources.agreements (id, tenant_id, project_id, contributor_id, title, scope, terms, basis, work_refs, starts_on, created_by, created_at, updated_at) values (gen_random_uuid(),'org-a','proj-1','${c.id as string}','t','s','t','fixed_fee','{E08:finding:f1}','2030-01-01','x',now(),now())`);
    await raw(`insert into e13_resources.revenue_records (id, tenant_id, project_id, source, external_id, channel, work_ref, period_start, period_end, occurred_on, gross_minor, currency, state, recorded_by, recorded_at) values (gen_random_uuid(),'org-a','proj-1','s','1','c','E07:claim:c1','2030-01-01','2030-01-01','2030-01-01',1,'EUR','recorded','x',now())`);
    await raw(`insert into e13_resources.budgets (id, tenant_id, project_id, level, depth, name, unit, objective, period, ceiling, overage_tolerance_bps, created_by, created_at, updated_at) values (gen_random_uuid(),'org-a','proj-1','objective',0,'n','money:EUR','E08:finding:f1','one_off',1,0,'x',now(),now())`);
    const cols = (await sql.query<{ c: string }>(`select table_name || '.' || column_name as c from information_schema.columns where table_schema='e13_resources'`)).map((r) => r.c);
    assert.deepEqual(cols.filter((x) => /claim|finding|assessment|verdict|accus|outcome|quota/i.test(x)), [], 'no column can hold a conclusion');
    // legitimate agreement works; the engine emits nothing that factual workflows consume
    const ok = await engine.createAgreement(alice, { ...base, basis: 'daily', rateMinor: 30_000, currency: 'EUR', workRefs: ['E09:work:film'] });
    await assert.rejects(engine.setAgreementStatus(agent, ok.id as string, 'activate', 'x'), code('forbidden'));
    assert.equal((await engine.setAgreementStatus(bob, ok.id as string, 'activate', 'signed copy filed')).status, 'active');
    assert.equal((await engine.listAgreements(alice, { status: 'active' })).length, 1);
    assert.ok(engine.manifest.emits.every((t) => t.startsWith('resources.')));
    assert.ok(!engine.manifest.emits.some((t) => /claim|finding|assessment/.test(t)));
  });
});

test('invoices: lifecycle, per-organization numbering, tax data, void by reversal, PDF checked with pdfinfo', needsPg, async () => {
  const objects = memoryObjects();
  await withEngine(async (engine, sql) => {
    const input = { customer: { name: 'Example Broadcasting Cooperative', address: '1 Example Street, Exampleville', taxId: 'XX-123456' }, currency: 'EUR', dueOn: '2030-04-30', notes: 'Reverse charge <b>not</b> applicable', idempotencyKey: 'i1',
      lines: [{ description: 'Broadcast license, one territory', quantity: 1, unitPriceMinor: 100_000, taxCode: 'STD', taxRateBps: 2000, workRef: 'E09:work:film', releaseRef: 'E12:release:r1', channel: 'broadcast' }, { description: 'Clip pack & subtitles', quantity: 3, unitPriceMinor: 5_000, taxCode: 'RED', taxRateBps: 700 }] };
    const draft = await engine.createInvoice(alice, input);
    assert.deepEqual([draft.state, draft.number, draft.subtotalMinor, draft.taxMinor, draft.totalMinor], ['draft', null, 115_000, 21_050, 136_050]);
    assert.equal((await engine.createInvoice(alice, input)).id, draft.id);
    await assert.rejects(engine.issueInvoice(agent, draft.id as string), code('forbidden'));
    await assert.rejects(engine.markInvoiceSent(alice, draft.id as string, { channel: 'email' }), code('invalid_state'));
    const issued = await engine.issueInvoice(bob, draft.id as string);
    assert.equal(issued.number, 'INV-000001'); assert.equal(issued.state, 'issued');
    assert.equal((await engine.issueInvoice(bob, draft.id as string)).number, 'INV-000001', 'issuing twice assigns no second number');
    // the sequence is per organization, across projects, and independent between tenants
    const p2 = ctx({ actorId: 'alice', projectId: 'proj-2' }), other = ctx({ actorId: 'zed', tenantId: 'org-b' });
    const second = await engine.createInvoice(p2, { ...input, idempotencyKey: 'i2' });
    assert.equal((await engine.issueInvoice(p2, second.id as string)).number, 'INV-000002');
    const foreign = await engine.createInvoice(other, { ...input, idempotencyKey: 'i1' });
    assert.equal((await engine.issueInvoice(other, foreign.id as string)).number, 'INV-000001');
    await assert.rejects(engine.getInvoice(other, draft.id as string), code('not_found'));
    await assert.rejects(engine.issueInvoice(p2, draft.id as string), code('not_found'));
    assert.equal((await engine.markInvoiceSent(alice, draft.id as string, { channel: 'email', reference: 'E03:message:m1' })).state, 'sent');
    const rev = await engine.revenueByWork(alice);
    assert.deepEqual(rev.find((r) => r.workRef === 'E09:work:film'), { workRef: 'E09:work:film', releaseRef: 'E12:release:r1', channel: 'broadcast', currency: 'EUR', grossMinor: 100_000, feesMinor: 0, netMinor: 100_000, records: 1, underReview: 0 });
    // rendering with real tools
    const html = await engine.renderInvoice(alice, draft.id as string, 'html');
    const text = Buffer.from(html.bytes).toString('utf8');
    assert.match(text, /INV-000001/); assert.match(text, /1360\.50 EUR/); assert.match(text, /&lt;b&gt;not&lt;\/b&gt;/, 'customer-supplied text is escaped');
    const pdf = await engine.renderInvoice(alice, draft.id as string, 'pdf');
    assert.equal(Buffer.from(pdf.bytes.subarray(0, 5)).toString(), '%PDF-');
    const file = join(mkdtempSync(join(tmpdir(), 'e13-test-')), 'invoice.pdf'); writeFileSync(file, pdf.bytes);
    const info = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
    assert.match(info, /Pages:\s+1/);
    assert.match(execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }), /INV-000001[\s\S]*Example Broadcasting Cooperative[\s\S]*1360\.50 EUR/);
    assert.ok(pdf.key!.startsWith('org-a/proj-1/invoices/')); assert.ok(objects.keys().every((k) => k.startsWith('org-a/proj-1/')));
    assert.equal(((await engine.getInvoice(alice, draft.id as string)).documents as unknown[]).length, 2);
    const missing = createEngine({ sql, config: { pdfConverter: 'no-such-converter-binary' } });
    await assert.rejects(missing.renderInvoice(alice, draft.id as string, 'pdf'), code('unavailable'));
    // void: reversing entry, revenue reversed, P&L returns to zero, number kept
    const before = await engine.projectPnl(alice);
    assert.equal(before.currencies.EUR!.revenueMinor, 115_000);
    const voided = await engine.voidInvoice(bob, draft.id as string, 'wrong customer');
    assert.equal(voided.state, 'void'); assert.equal(voided.number, 'INV-000001');
    assert.equal((await engine.projectPnl(alice)).currencies.EUR!.revenueMinor, 0);
    assert.equal((await engine.revenueByWork(alice)).length, 0);
    assert.ok((await engine.trialBalance(alice)).accounts.every((a) => a.balance === 0));
    await assert.rejects(engine.markInvoiceSent(alice, draft.id as string, { channel: 'email' }), code('invalid_state'));
    const third = await engine.createInvoice(alice, { ...input, idempotencyKey: 'i3' });
    assert.equal((await engine.issueInvoice(bob, third.id as string)).number, 'INV-000003', 'a void number is never reused');
  }, () => ({ objects }));
});

test('licenses, revenue import, statements, margins, exports and upstream rights changes', needsPg, async () => {
  await withEngine(async (engine) => {
    const work = 'E09:work:film';
    const inbound = await engine.createLicense(alice, { direction: 'inbound', title: 'Archive footage', counterparty: 'Example Archive Ltd', subjectRef: work, scope: 'Worldwide, 5 years', startsOn: '2030-01-01', expiresOn: '2030-03-01', feeMinor: 20_000, currency: 'EUR', permissionRefs: ['E11:permission:footage'] });
    const outbound = await engine.createLicense(alice, { direction: 'outbound', title: 'Streaming license', counterparty: 'Example Stream Co', subjectRef: work, scope: 'Streaming, one territory', startsOn: '2030-01-01', royaltyBps: 2500, permissionRefs: ['E11:permission:p1', 'E11:permission:p2'], releaseRefs: ['E12:release:r1'] });
    await assert.rejects(engine.setLicenseStatus(agent, inbound.id as string, 'activate', 'x'), code('forbidden'));
    await engine.setLicenseStatus(bob, inbound.id as string, 'activate', 'countersigned'); await engine.setLicenseStatus(bob, outbound.id as string, 'activate', 'countersigned');
    const at = ctx({ actorId: 'alice', now: '2030-02-10T00:00:00.000Z' });
    assert.deepEqual((await engine.checkLicenseExpiry(at, { withinDays: 30 })).expiring, [`E13:license:${inbound.id as string}`]);
    assert.deepEqual((await engine.checkLicenseExpiry(at, { withinDays: 30 })).expiring, [], 'notified once');
    assert.ok((await settled(engine, alice)).some((e) => e.type === 'resources.license_expiring'));
    // revenue import is idempotent per (source, externalId)
    const rows = [{ externalId: 'st-1', workRef: work, releaseRef: 'E12:release:r1', licenseId: outbound.id as string, periodStart: '2030-01-01', periodEnd: '2030-01-31', grossMinor: 80_000, feesMinor: 8_000, currency: 'EUR' },
      { externalId: 'st-2', workRef: 'E09:work:short', periodStart: '2030-01-01', periodEnd: '2030-01-31', grossMinor: 10_000, currency: 'EUR' }];
    const first = await engine.importRevenue(alice, { source: 'example-stream', channel: 'vod', rows });
    assert.equal(first.imported.length, 2);
    const again = await engine.importRevenue(alice, { source: 'example-stream', channel: 'vod', rows: [...rows, { externalId: 'st-3', workRef: work, periodStart: '2030-02-01', periodEnd: '2030-02-28', grossMinor: 5_000, currency: 'EUR' }] });
    assert.deepEqual(again.duplicates, ['st-1', 'st-2']); assert.equal(again.imported.length, 1);
    assert.equal((await engine.listRevenue(alice)).length, 3);
    const rec = await engine.reconcileRevenue(alice, first.imported[0]!, { reference: 'SETTLE-77' });
    assert.equal(rec.state, 'reconciled'); assert.equal((await engine.reconcileRevenue(alice, first.imported[0]!, { reference: 'SETTLE-77' })).state, 'reconciled');
    assert.equal((await settled(engine, alice)).filter((e) => e.type === 'resources.revenue_reconciled').length, 1);
    // margin = revenue − direct costs − allocated usage
    await engine.recordUsage(alice, { kind: 'rendering', provider: 'farm', quantities: { render_seconds: 100 }, cost: { amountMinor: 7_000, currency: 'EUR' }, subject: 'E10:render:r1', workRef: work, idempotencyKey: 'u1' });
    const pnl = await engine.projectPnl(alice);
    const film = pnl.works.find((w) => w.workRef === work)!;
    assert.deepEqual([film.revenueMinor, film.directCostsMinor, film.usageCostsMinor, film.marginMinor, film.marginBps], [85_000, 28_000, 7_000, 50_000, 5882]);
    assert.deepEqual(pnl.currencies.EUR, { revenueMinor: 95_000, directCostsMinor: 28_000, usageCostsMinor: 7_000, marginMinor: 60_000, marginBps: 6316 });
    // statements: royalty on gross, revenue share on net, one live statement per period
    const c = await engine.createContributor(alice, { kind: 'person', displayName: 'Rowan Example', roles: ['director'] });
    const mk = async (basis: 'royalty_share' | 'revenue_share', shareBps: number) => { const a = await engine.createAgreement(alice, { contributorId: c.id as string, title: basis, scope: 'Film', terms: 'Share of receipts', basis, shareBps, workRefs: [work], startsOn: '2030-01-01', documentRef: 'E05:evidence_version:c1@1' }); await engine.setAgreementStatus(bob, a.id as string, 'activate', 'signed'); };
    await mk('royalty_share', 1000); await mk('revenue_share', 500);
    const st = await engine.issueStatement(bob, { contributorId: c.id as string, periodStart: '2030-01-01', periodEnd: '2030-01-31', idempotencyKey: 's1' });
    assert.deepEqual(st.totals, { EUR: 8_000 + 3_600 }); assert.equal((st.lines as unknown[]).length, 2);
    await assert.rejects(engine.issueStatement(bob, { contributorId: c.id as string, periodStart: '2030-01-01', periodEnd: '2030-01-31', idempotencyKey: 's2' }), code('conflict'));
    await assert.rejects(engine.issueStatement(agent, { contributorId: c.id as string, periodStart: '2030-02-01', periodEnd: '2030-02-28', idempotencyKey: 's3' }), code('forbidden'));
    const payable = () => engine.trialBalance(alice).then((tb) => tb.accounts.find((a) => a.code === '2200')!.balance);
    assert.equal(await payable(), -11_600);
    assert.equal((await engine.voidStatement(bob, st.id as string, 'wrong period')).state, 'void'); assert.equal(await payable(), 0);
    // upstream: a withdrawn permission flags the outbound license and its revenue for review; idempotent by event id
    const change = { eventId: 'evt-1', kind: 'permission_withdrawn' as const, refs: ['E11:permission:p2@3'], reason: 'participant withdrew' };
    const out = await engine.applyUpstreamChange(alice, change);
    assert.deepEqual(out.affected.sort(), [`E13:license:${outbound.id as string}`, `E13:revenue:${first.imported[0]!}`].sort());
    assert.deepEqual((await engine.applyUpstreamChange(alice, change)).affected.sort(), out.affected.sort());
    assert.equal((await settled(engine, alice)).filter((e) => e.type === 'resources.license.blocked').length, 1);
    const lic = (await engine.listLicenses(alice, { direction: 'outbound' }))[0]!;
    assert.equal(lic.reviewRequired, true); assert.equal((lic.reviewReasons as { cause: string }[])[0]!.cause, 'evt-1');
    assert.equal((await engine.inspect(alice, `E13:license:${outbound.id as string}`))!.blocked, true);
    const rights = await engine.applyUpstreamChange(alice, { eventId: 'evt-2', kind: 'rights_changed', refs: [work], reason: 'rights holder changed' });
    assert.equal(rights.affected.length, 4, 'both licenses on the work and the two remaining revenue items for it');
    assert.deepEqual((await engine.applyUpstreamChange(alice, { eventId: 'evt-3', kind: 'source_corrected', refs: [work], reason: 'n/a' })).affected, []);
    assert.deepEqual((await engine.applyUpstreamChange(ctx({ tenantId: 'org-b' }), { ...change, eventId: 'evt-9' })).affected, []);
    const held = await engine.issueStatement(bob, { contributorId: c.id as string, periodStart: '2030-01-01', periodEnd: '2030-01-31', idempotencyKey: 's4' });
    assert.deepEqual(held.totals, {}); assert.equal(held.heldForReview, 2, 'revenue under rights review is held back from statements');
    await engine.clearRevenueReview(bob, first.imported[0]!, 'new permission on file');
    await engine.setLicenseStatus(bob, outbound.id as string, 'clear_review', 'new permission on file');
    assert.equal((await engine.inspect(alice, `E13:license:${outbound.id as string}`))!.blocked, false);
    // exports
    await assert.rejects(engine.exportData(ctx({ capabilities: ['resources:*'] }), { dataset: 'journal' }), code('forbidden'));
    const j = await engine.exportData(alice, { dataset: 'journal', format: 'csv' });
    assert.match(j.body, /^seq,entryId,effectiveDate,currency,memo/); assert.ok(j.rows > 6);
    const r = JSON.parse((await engine.exportData(alice, { dataset: 'revenue' })).body) as unknown[];
    assert.equal(r.length, 3);
    assert.equal((await engine.exportData(ctx({ tenantId: 'org-b' }), { dataset: 'revenue' })).rows, 0);
    await assert.rejects(engine.exportData(alice, { dataset: '_audit; drop' }), code('invalid_input'));
    assert.ok((await engine.search(alice, { q: 'streaming' })).some((h) => h.kind === 'license'));
    assert.equal((await engine.search(ctx({ tenantId: 'org-b' }), { q: 'streaming' })).length, 0);
  });
});
