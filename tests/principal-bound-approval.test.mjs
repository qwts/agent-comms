import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createPairing } from '../lib/broker/pairing.mjs';
import { apply, emptyState } from '../lib/state.mjs';
import { admin, callPrincipal } from '../lib/client.mjs';
import { currentUid } from '../lib/platform/account-isolation.mjs';
import { withBroker } from './helpers/broker.mjs';
const a = 'principal_11111111-1111-4111-8111-111111111111';
const b = 'principal_22222222-2222-4222-8222-222222222222';
const unknown = 'principal_33333333-3333-4333-8333-333333333333';
const pending = (principal, code = 'SAME12') => ({ t: 'principal-request', principal, account: principal === a ? 'owner' : 'other', hash: createHash('sha256').update('synthetic-secret').digest('hex'), code, at: 1 });
function fixture() {
  const state = emptyState(), records = [], diagnostics = [];
  apply(state, pending(a)); apply(state, pending(b));
  const commit = r => { records.push(r); apply(state, r); };
  return { state, records, diagnostics, commit, approve: request => createPairing({ state, now: () => 2, reportDiagnostic: (...args) => diagnostics.push(args) }, commit, {}).handleAdmin({ op: Object.hasOwn(request, 'expectedPrincipal') ? 'principal-approve-exact' : 'principal-approve', code: 'SAME12', ...request }) };
}
test('code collisions refuse legacy approval but exact identity selects only its pending principal', () => {
  const f = fixture(), before = structuredClone(f.state);
  assert.throws(() => f.approve({}), { code: 'ambiguous-code', message: 'more than one pending principal has that code' });
  assert.equal(f.records.length, 0); assert.deepEqual(f.state, before);
  assert.deepEqual(f.diagnostics, []);
  assert.deepEqual(f.approve({ expectedPrincipal: b, grant: ['other'] }), { principal: b, account: 'other', state: 'approved', grant: ['other'] });
  assert.equal(f.state.principals.get(a).state, 'pending');
  assert.deepEqual(f.diagnostics.map(([event]) => event), ['pair-principal-approved']);
  assert.equal(f.records.length, 1); assert.equal(f.records[0].principal, b);
  assert.deepEqual(f.approve({}), { principal: a, account: 'owner', state: 'approved', grant: null });
});
test('malformed, unknown, wrong-code, approved and revoked expected identities never mutate another principal', () => {
  for (const expectedPrincipal of [undefined, null, '', 1, {}, a + '\n', 'principal_bad']) {
    const f = fixture(), before = structuredClone(f.state);
    assert.throws(() => f.approve({ expectedPrincipal }), { code: 'bad-request' });
    assert.equal(f.records.length, 0); assert.deepEqual(f.state, before);
  }
  for (const request of [{ op: 'principal-approve-exact' }, { op: 'principal-approve', expectedPrincipal: a }]) {
    const f = fixture(), before = structuredClone(f.state);
    assert.throws(() => f.approve(request), { code: 'bad-request' });
    assert.equal(f.records.length, 0); assert.deepEqual(f.state, before);
  }
  for (const mode of ['unknown', 'wrong-code', 'approved', 'revoked']) {
    const f = fixture();
    if (mode === 'wrong-code') f.state.principals.get(a).code = 'OTHER1';
    if (mode === 'approved') f.commit({ t: 'principal-approve', principal: a, grant: null, at: 2 });
    if (mode === 'revoked') f.commit({ t: 'principal-revoke', principal: a, at: 2 });
    const before = structuredClone(f.state), count = f.records.length;
    assert.throws(() => f.approve({ expectedPrincipal: mode === 'unknown' ? unknown : a }), { code: 'unknown-code' });
    assert.equal(f.records.length, count); assert.deepEqual(f.state, before);
  }
});
test('private socket approval returns exact identity/account and public callers cannot approve', async () => {
  await withBroker(async c => {
    // Deterministic collision fixture in the real broker; approval still uses
    // the production private socket and durable commit path.
    apply(c.broker.state, { ...pending(a), account: c.owner }); apply(c.broker.state, pending(b));
    await assert.rejects(admin(c.paths, { op: 'principal-approve', code: 'SAME12' }), { code: 'ambiguous-code' });
    const result = await c.cli(['admin', 'principal-approve', 'SAME12', '--expected-principal', a]);
    assert.equal(result.exit, 0);
    const reply = result.json;
    assert.equal(reply.principal, a); assert.equal(reply.account, c.owner);
    assert.equal(c.broker.state.principals.get(b).state, 'pending');
    await assert.rejects(callPrincipal(c.paths, { principal: a, secret: 'synthetic-secret', brokerUid: currentUid(), mode: 'single-account' }, { op: 'principal-approve-exact', code: 'SAME12', expectedPrincipal: b }));
    assert.equal(c.broker.state.principals.get(b).state, 'pending');
  }, { brokerOptions: { mode: 'single-account' } });
});
