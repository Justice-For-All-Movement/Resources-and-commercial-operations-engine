import test from 'node:test';
import assert from 'node:assert/strict';
import {createBudget, reserve, commitReservation, markUncertain, release, settle, recordOverage, budgetBalance, verifyCostLedger} from '../src/index.ts';
import type {Context, Ref} from '../src/contracts.ts';

const owner: Context = {tenantId:'alpha', projectId:'study', actor:{id:'owner', kind:'human', roles:['owner']}, purpose:'research', requestId:'request', now:'2026-01-01T00:00:00Z'};
const agent: Context = {...owner, actor:{id:'agent', kind:'agent', roles:[]}};
const receipt: Ref = {tenantId:'alpha', projectId:'study', kind:'provider-receipt', id:'receipt-1', revision:1};
function held() {
  return reserve(createBudget(owner, {id:'budget', unit:'credits', limit:100, operators:[{id:'owner',kind:'human'}, {id:'agent',kind:'agent'}]}), agent,
    {id:'reservation', units:60, purpose:'research', expiresAt:'2026-01-01T00:01:00Z', effectKey:'provider-effect'});
}

test('every reservation transition binds the authenticated purpose, including owner overage', () => {
  const h = held();
  const committed = commitReservation(h, agent, 'reservation');
  const uncertain = markUncertain(committed, agent, 'reservation');
  for (const actor of [agent, owner]) {
    const other = {...actor, purpose:'unrelated'};
    const operations = [
      () => commitReservation(h, other, 'reservation'),
      () => markUncertain(committed, other, 'reservation'),
      () => release(h, other, 'reservation'),
      () => release(committed, other, 'reservation', receipt),
      () => release(uncertain, other, 'reservation', receipt),
      () => settle(committed, other, 'reservation', 45, receipt),
      () => settle(uncertain, other, 'reservation', 45, receipt),
    ];
    for (const operation of operations) assert.throws(operation, {code:'purpose_denied'});
  }
  assert.throws(() => recordOverage(committed, {...owner, purpose:'unrelated'}, 'reservation', 120, receipt, 'Provider exceeded ceiling'), {code:'purpose_denied'});
  assert.equal(h.reservations[0]?.status, 'held');
  assert.equal(committed.reservations[0]?.status, 'committed');
  assert.equal(uncertain.reservations[0]?.status, 'uncertain');
  assert.equal(budgetBalance(uncertain).reserved, 60);
  assert.ok(verifyCostLedger(uncertain));
});

test('public settlement and release entry points reject malformed runtime receipt references', () => {
  const h = held();
  const committed = commitReservation(h, agent, 'reservation');
  const malformed: unknown[] = [
    false, 0, '', [],
    {tenantId:'alpha', projectId:'study'},
    {...receipt, revision:0}, {...receipt, revision:1.5},
    {...receipt, kind:''}, {...receipt, id:' '},
    {...receipt, extra:'unrecognized'},
  ];
  for (const value of malformed) {
    const invalid = value as Ref;
    for (const operation of [
      () => release(h, agent, 'reservation', invalid),
      () => release(committed, agent, 'reservation', invalid),
      () => settle(committed, agent, 'reservation', 45, invalid),
      () => recordOverage(committed, owner, 'reservation', 120, invalid, 'Provider exceeded ceiling'),
    ]) assert.throws(operation);
  }
  assert.equal(committed.spent, 0);
  assert.equal(budgetBalance(committed).reserved, 60);
  assert.equal(committed.reservations[0]?.receipt, null);
  assert.ok(verifyCostLedger(committed));
  assert.throws(() => settle(committed, agent, 'reservation', 45, null as unknown as Ref), {code:'invalid_reference'});
  assert.throws(() => recordOverage(committed, owner, 'reservation', 120, null as unknown as Ref, 'Provider exceeded ceiling'), {code:'invalid_reference'});
});

test('same-purpose operator and owner transitions retain valid receipt snapshots and accounting', () => {
  const committed = commitReservation(held(), agent, 'reservation');
  const proof = {...receipt};
  const released = release(committed, owner, 'reservation', proof);
  const settled = settle(committed, agent, 'reservation', 45, proof);
  const overage = recordOverage(committed, owner, 'reservation', 120, proof, 'Provider exceeded ceiling');
  proof.id = 'mutated-after-transition';
  for (const state of [released, settled, overage]) {
    assert.equal(state.reservations[0]?.receipt?.id, receipt.id);
    assert.ok(verifyCostLedger(state));
    assert.equal(budgetBalance(state).reserved, 0);
  }
  assert.equal(settled.spent, 45);
  assert.equal(overage.spent, 120);
  assert.equal(budgetBalance(overage).overLimit, true);
});
