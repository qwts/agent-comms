import assert from 'node:assert/strict';
import test from 'node:test';
import { probePinnedCustody } from '../tools/acceptance/windows-capacity-custody.mjs';

function api(failAt) {
  const calls = [], phases = [], owner = 'CANARY-private-owner', paths = {
    shared: 'CANARY-private-shared', proofs: 'CANARY-private-proofs', state: 'CANARY-private-state' };
  const fault = new Error('CANARY-private-error');
  const load = async name => {
    calls.push(['load', name]);
    if (name === 'lib/paths.mjs') return { brokerPaths: () => paths };
    assert.equal(name, 'lib/platform/account-isolation.mjs');
    return { createAccountIsolation: () => ({
      currentUid() { calls.push(['uid']); if (failAt === 'uid') throw fault; return owner; },
      assertOwnedDir(dir, uid, options) {
        assert.equal(uid, owner); calls.push(['check', dir, options.code]);
        if (failAt === dir) throw fault;
      },
    }) };
  };
  return { calls, phases, paths, fault, run: () => probePinnedCustody(load,
    (dir, options) => { assert.deepEqual(options, { recursive: true }); calls.push(['mkdir', dir]); }, phase => phases.push(phase)) };
}
test('custody discriminant uses actual API shape and exact ordered three-directory prepare checks without owner/path reporting', async () => {
  const fixture = api();
  assert.deepEqual(await fixture.run(), { ready: true, startupCustodyChecks: 4 });
  assert.deepEqual(fixture.calls, [['load','lib/platform/account-isolation.mjs'], ['load','lib/paths.mjs'], ['uid'],
    ['mkdir',fixture.paths.shared], ['check',fixture.paths.shared,'shared-dir-untrusted'],
    ['mkdir',fixture.paths.proofs], ['check',fixture.paths.proofs,'shared-dir-untrusted'],
    ['mkdir',fixture.paths.state], ['check',fixture.paths.state,'state-dir-untrusted']]);
  assert.equal(JSON.stringify(fixture.phases).includes('CANARY'), false);
  assert.equal(fixture.phases.at(-1), 'custody-ready');
});
test('each real API boundary remains a refusal and never advances to a later check or emits ready', async () => {
  for (const [failAt, lastPhase, checks] of [['uid','custody-current-uid',0],
    ['CANARY-private-shared','custody-shared',1], ['CANARY-private-proofs','custody-proofs',2],
    ['CANARY-private-state','custody-state',3]]) {
    const fixture = api(failAt);
    await assert.rejects(fixture.run(), error => error === fixture.fault);
    assert.equal(fixture.phases.at(-1), lastPhase); assert.equal(fixture.phases.includes('custody-ready'), false);
    assert.equal(fixture.calls.filter(call => call[0] === 'check').length, checks);
    assert.equal(JSON.stringify(fixture.phases).includes('CANARY'), false);
  }
});
