import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, emptyState, EventLog, nextDaemonEpoch } from '../lib/state.mjs';
import { createPairing } from '../lib/broker/pairing.mjs';
const request = { t: 'daemon-pair-request', account: 'persona', hash: 'test', uid: 501, code: 'TEST', publicKey: 'test', at: 1 };
const approve = { t: 'daemon-pair-approve', account: 'persona', at: 2 };
const checksum = snapshot => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ac-daemon-epoch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = new EventLog(root); let state = log.replay();
  return { log, get state() { return state; }, commit(record) { log.append(record); apply(state, record); },
    reopen() { state = new EventLog(root).replay(); return state; } };
}
test('approval, same-key replacement, daemon/account revoke retain monotonic epochs across compaction/restart', t => {
  const f = fixture(t);
  f.commit(request); assert.equal(f.state.daemonEpochs.size, 0);
  f.commit(approve); assert.equal(f.state.daemons.get('persona').epoch, 1);
  f.commit(request); assert.equal(f.state.daemons.get('persona').epoch, 1);
  f.commit(approve); assert.equal(f.state.daemons.get('persona').epoch, 2);
  f.commit({ t: 'daemon-pair-revoke', account: 'persona', at: 3 });
  assert.equal(f.state.daemonEpochs.get('persona'), 3); assert.equal(f.state.daemons.size, 0);
  f.log.compact(f.state); f.reopen();
  f.commit(request); f.commit(approve); assert.equal(f.state.daemons.get('persona').epoch, 4);
  f.commit({ t: 'pair-revoke', account: 'persona', at: 4 });
  f.log.compact(f.state); f.reopen();
  assert.equal(f.state.daemonEpochs.get('persona'), 5);
  f.commit(request); f.commit(approve); f.reopen();
  assert.equal(f.state.daemons.get('persona').epoch, 6);
  assert.equal(f.state.daemonEpochs.get('persona'), 6);
});
test('legacy checkpoint migration establishes a baseline without mutating authenticated snapshot', t => {
  for (const version of [1, 2]) {
    const f = fixture(t); f.commit(request); f.commit(approve); f.log.compact(f.state);
    const record = JSON.parse(readFileSync(f.log.file, 'utf8'));
    record.version = version; delete record.snapshot.daemonEpochs;
    for (const [, daemon] of record.snapshot.daemons) delete daemon.epoch;
    if (version === 1) for (const field of ['originHubId', 'channels', 'principalChannelGrants']) delete record.snapshot[field];
    record.checksum = checksum(record.snapshot);
    const original = JSON.stringify(record);
    for (let i = 0; i < 2; i++) {
      const state = emptyState(); apply(state, record);
      assert.equal(state.daemons.get('persona').epoch, 1);
      assert.equal(JSON.stringify(record), original);
    }
    writeFileSync(f.log.file, original + '\n'); f.reopen();
    f.commit({ t: 'pair-revoke', account: 'persona' }); f.commit(request); f.commit(approve);
    assert.equal(f.state.daemons.get('persona').epoch, 3);
  }
});
test('safe-integer exhaustion refuses approval but still permits final revocation', () => {
  const state = emptyState(); apply(state, request);
  state.daemonEpochs.set('persona', Number.MAX_SAFE_INTEGER - 2);
  apply(state, approve);
  assert.equal(state.daemons.get('persona').epoch, Number.MAX_SAFE_INTEGER - 1);
  assert.throws(() => nextDaemonEpoch(state, 'persona'), /exhausted/);
  apply(state, { t: 'daemon-pair-revoke', account: 'persona' });
  assert.equal(state.daemonEpochs.get('persona'), Number.MAX_SAFE_INTEGER);
  apply(state, request); assert.throws(() => apply(state, approve), /exhausted/);
  apply(state, { t: 'pair-revoke', account: 'persona' });
  assert.equal(state.daemonEpochs.get('persona'), Number.MAX_SAFE_INTEGER);
});
test('corrupt v3 epoch state or mismatched explicit approval epoch fails closed', t => {
  const f = fixture(t); f.commit(request); f.commit(approve); f.log.compact(f.state);
  const original = JSON.parse(readFileSync(f.log.file, 'utf8'));
  for (const mutate of [
    r => { r.snapshot.daemonEpochs = []; },
    r => { r.snapshot.daemonEpochs[0][1] = 0; },
    r => { r.snapshot.daemonEpochs[0][1] = 1.5; },
    r => { r.snapshot.daemons[0][1].epoch = 2; },
    r => { r.snapshot.daemonEpochs[0][0] += '\n'; },
    r => { r.snapshot.daemons[0][1].epoch = Number.MAX_SAFE_INTEGER; r.snapshot.daemonEpochs[0][1] = Number.MAX_SAFE_INTEGER; },
  ]) {
    const record = structuredClone(original); mutate(record); record.checksum = checksum(record.snapshot);
    assert.throws(() => apply(emptyState(), record), /daemon epoch/);
  }
  const state = emptyState(); apply(state, request);
  assert.throws(() => apply(state, { ...approve, daemonEpoch: 2 }), /epoch transition/);
  assert.equal(state.daemonEpochs.size, 0);
  assert.equal(state.daemons.get('persona').state, 'pending');
});

test('admin approval at exhaustion does not append or poison storage, and revocation still works', t => {
  for (const kind of ['daemon', 'account']) {
    const f = fixture(t); f.commit(request); f.commit(approve); f.commit(request);
    f.state.daemonEpochs.set('persona', Number.MAX_SAFE_INTEGER - 1);
    f.state.daemons.get('persona').epoch = Number.MAX_SAFE_INTEGER - 1;
    f.commit({ t: 'pair-request', account: 'persona', hash: 'test', uid: 501, code: 'ACCOUNT', at: 3 });
    f.commit({ t: 'pair-approve', account: 'persona', at: 4 });
    f.log.compact(f.state);
    let revoked = 0;
    const pairing = createPairing({ state: f.state, now: () => 5 }, f.commit, {
      revokeDaemon() { revoked++; return 1; }, revoke() { revoked++; return 1; },
    });
    const before = readFileSync(f.log.file);
    assert.throws(() => pairing.handleAdmin({ op: 'approve', code: 'TEST' }), { code: 'conflict' });
    assert.deepEqual(readFileSync(f.log.file), before);
    assert.equal(f.log.poisoned, false);
    assert.equal(f.state.daemons.get('persona').state, 'approved');
    const result = pairing.handleAdmin({ op: 'revoke', account: 'persona', kind });
    assert.equal(result.state, 'revoked'); assert.equal(revoked, 1);
    assert.equal(f.log.poisoned, false);
    const recovered = f.reopen();
    assert.equal(recovered.daemons.has('persona'), false);
    assert.equal(recovered.daemonEpochs.get('persona'), Number.MAX_SAFE_INTEGER);
  }
});
