import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Broker } from '../lib/broker.mjs';
import { createPairing } from '../lib/broker/pairing.mjs';
import { createWatchDelivery } from '../lib/broker/watch.mjs';
import { apply, EventLog } from '../lib/state.mjs';
import { OwnerDecisionJournalStore as Store } from '../lib/owner-decision-journal.mjs';
import { DisabledOwnerDecisionEnrollment as Enrollment } from '../lib/broker/owner-enrollment.mjs';
import { createDisabledOwnerDecisionCoordinator as coordinator } from '../lib/broker/owner-decisions.mjs';
import { decodeOwnerDecisionAction } from '../lib/owner-decision-codec.mjs';
import { bytes, f, namespaceDigest } from './helpers/owner-decision-lifecycle.mjs';

const darwin = { skip: process.platform !== 'darwin', timeout: 120000 };
const hash = value => createHash('sha256').update(value).digest('hex');
const reject = (fn, code) => assert.throws(fn, error => error.code === code && !/canary/.test(error.message));
// Socket sinks and enrollment keys are deliberately synthetic. The actual
// pairing/admin/auth, watch-binding implementation and on-disk journal are used.
class Sink extends EventEmitter {
  destroyed = false; writable = true; events = []; beforeWrite;
  write(line) { const event = JSON.parse(line); this.beforeWrite?.(event); this.events.push(event); return true; }
  destroy() { this.destroyed = true; this.writable = false; this.emit('close'); }
}
function fixture(t, vector = f.positive[0], journalOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-owner-coordinator-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const action = JSON.parse(vector.actionJson), brokerKeys = generateKeyPairSync('ed25519'),
    presenceKeys = generateKeyPairSync('ed25519'), daemonKeys = generateKeyPairSync('ed25519');
  let milliseconds = vector.receiptPayload.iat * 1000;
  const broker = new Broker({ paths: { state: path.join(root, 'broker'), socket: path.join(root, 'broker.sock'),
    admin: path.join(root, 'admin.sock'), proofs: path.join(root, 'proofs') }, now: () => milliseconds });
  const log = new EventLog(broker.paths.state);
  const commit = record => { log.append(record); apply(broker.state, record); };
  const secret = 'synthetic-principal-credential', daemonSecret = 'synthetic-daemon-credential';
  for (const record of [
    { t: 'pair-request', account: action.account, hash: hash('synthetic-account'), uid: process.getuid(), code: 'ACCT', at: milliseconds },
    { t: 'pair-approve', account: action.account, at: milliseconds },
    { t: 'daemon-pair-request', account: action.account, hash: hash(daemonSecret), uid: process.getuid(), code: 'DAEM',
      publicKey: daemonKeys.publicKey.export({ type: 'spki', format: 'pem' }), at: milliseconds },
    { t: 'daemon-pair-approve', account: action.account, daemonEpoch: 1, at: milliseconds },
    { t: 'principal-request', principal: action.principal, account: 'native-owner', hash: hash(secret), code: 'PRIN', at: milliseconds },
    { t: 'principal-approve', principal: action.principal, grant: null, at: milliseconds },
    { t: 'principal-owner-grants', principal: action.principal,
      grants: [{ account: action.account, souls: [action.soul], operations: [action.operation] }], at: milliseconds },
  ]) commit(record);
  let pairing;
  const watches = createWatchDelivery(broker, () => pairing, () => [], commit);
  pairing = createPairing(broker, commit, watches);
  const auth = { principal: action.principal, secret }, daemonAuth = { daemon: action.account, secret: daemonSecret };
  const socket = new Sink(); t.after(() => socket.destroy());
  const attach = sink => {
    const request = { v: 1, op: 'account-watch', auth: daemonAuth };
    watches.accountWatch(request, sink, pairing.daemon(request)); return sink;
  };
  attach(socket);
  const enrollment = new Enrollment({ namespaceDigest, service: { account: 'synthetic-broker', uid: process.getuid() } });
  enrollment.install({ revision: 1, brokerPrivateKey: brokerKeys.privateKey, presencePublicKey: presenceKeys.publicKey });
  const journalRoot = path.join(root, 'journal');
  fs.mkdirSync(journalRoot, { mode: 0o700 });
  const open = () => new Store(journalRoot, { namespaceDigest, format: 'fixed-v1',
    lifecycle: { brokerPublicKeys: [brokerKeys.publicKey], presencePublicKeys: [presenceKeys.publicKey] },
    now: () => milliseconds, ...journalOptions });
  const journal = open();
  const options = { broker, pairing, watches, journal, enrollment, namespaceDigest, syntheticFixture: true };
  const core = coordinator(options);
  const prepareRequest = { v: 1, op: 'owner-decision-prepare', auth, requestId: action.requestId,
    account: action.account, soul: action.soul, operation: action.operation, parameters: action.parameters };
  const principal = op => ({ v: 1, op, auth, requestId: action.requestId });
  const binding = () => {
    const a = JSON.parse(journal.read(action.requestId).acceptanceBytes);
    return { requestId: a.requestId, payloadDigest: a.payloadDigest, daemonKey: a.daemonKey, daemonEpoch: a.daemonEpoch, watchId: a.watchId };
  };
  const prepare = () => core.prepare(prepareRequest);
  const preparedRequest = () => {
    const at = Math.floor(milliseconds / 1000), p = action.parameters;
    return { v: 1, op: 'owner-decision-prepared', auth: daemonAuth, ...binding(), nonce: randomBytes(32).toString('base64url'),
      preparedAt: at, exp: Math.min(at + 180, JSON.parse(journal.read(action.requestId).acceptanceBytes).acceptedAt + 180),
      stage: p.stagingId ? { stagingId: p.stagingId, kind: action.operation === 'cold-wake.set' ? 'webhook' : 'package',
        contentDigest: p.packageDigest ?? p.configurationDigest, expiresAt: at + 180 } : null };
  };
  let retainedPrepared;
  const prepared = () => { retainedPrepared = preparedRequest(); return core.prepared(retainedPrepared); };
  const confirmRequest = () => {
    const row = journal.read(action.requestId), w = JSON.parse(row.slots.get('prepared-challenge'));
    const p = { v: 1, aud: 'agent-bot-owner', kind: 'presence', nonce: w.challenge.nonce,
      action: hash(decodeOwnerDecisionAction(row.actionBytes).actionText), iat: Math.floor(milliseconds / 1000), exp: Math.floor(milliseconds / 1000) + 120 };
    const segment = bytes(p).toString('base64url'), presence = `p1.${segment}.${sign(null, Buffer.from(segment), presenceKeys.privateKey).toString('base64url')}`;
    return { ...principal('owner-decision'), payloadDigest: binding().payloadDigest, presence };
  };
  let retainedConfirm;
  const confirm = () => { retainedConfirm = confirmRequest(); return core.confirm(retainedConfirm); };
  const checkRequest = () => ({ v: 1, op: 'owner-decision-check', auth: daemonAuth, ...binding(),
    receiptDigest: hash(journal.read(action.requestId).slots.get('receipt')) });
  const check = () => core.check(checkRequest());
  return { root, journalRoot, broker, pairing, watches, journal, enrollment, options, core, action, socket, attach, open,
    auth, daemonAuth, brokerKeys, presenceKeys, commit, prepareRequest, principal, prepare, preparedRequest, prepared,
    confirmRequest, confirm, checkRequest, check, binding, get retainedPrepared() { return retainedPrepared; },
    get retainedConfirm() { return retainedConfirm; }, setTime(value) { milliseconds = value; }, advance(value) { milliseconds += value; } };
}

test('connected synthetic dispatcher durably prepares authorizes releases and reports every shared operation once', darwin, t => {
  for (const vector of f.positive) {
    const x = fixture(t, vector), id = x.action.requestId;
    assert.equal(x.broker.state.souls.size, 0); // Deliberately unjoined: producer resolution is a fixture assumption.
    x.socket.beforeWrite = event => {
      if (event.event === 'owner-decision-prepare') assert.equal(x.journal.read(id).state, 'preparing');
      if (event.event === 'owner-decision') assert.equal(x.journal.read(id).state, 'authorized');
    };
    assert.equal(x.prepare().state, 'preparing'); assert.equal(x.prepare().state, 'preparing');
    assert.equal(x.prepared().state, 'prepared');
    assert.equal(x.core.prepared(x.retainedPrepared).state, 'prepared');
    assert.equal(x.confirm().state, 'authorized'); assert.equal(x.core.confirm(x.retainedConfirm).state, 'authorized');
    const released = x.check(); assert.equal(released.mayApply, true); assert.equal(released.state, 'released');
    assert.equal(x.check().mayApply, false);
    const report = { v: 1, op: 'owner-decision-result', auth: x.daemonAuth, ...x.binding(),
      receiptDigest: released.receiptDigest, state: 'applied', outcome: { code: 'applied', effectDigest: 'd'.repeat(64) }, reconciliation: null };
    assert.deepEqual(x.core.result(report), { requestId: id, state: 'applied', recorded: true });
    x.advance(1000);
    assert.deepEqual(x.core.result(report), { requestId: id, state: 'applied', recorded: false });
    reject(() => x.core.result({ ...report, outcome: { ...report.outcome, effectDigest: 'e'.repeat(64) } }), 'conflict');
    assert.equal(x.core.status(x.principal('owner-decision-status')).outcome.code, 'applied');
    assert.equal(x.socket.events.filter(e => e.event === 'owner-decision-prepare').length, 1);
    assert.equal(x.socket.events.filter(e => e.event === 'owner-decision').length, 1);
    assert.equal(x.core.capabilities.productionSupported, false);
    assert.equal(x.core.capabilities.authorizationSupported, false);
    assert.equal(x.core.capabilities.physicalAllocationSupported, false);
    assert.equal(x.core.cancel(x.principal('owner-decision-cancel')).state, 'applied');
  }
});

test('real pairing authentication refuses wrong kinds inbound credentials and nonexistent or foreign IDs without disclosure', darwin, t => {
  const x = fixture(t); x.prepare();
  for (const auth of [{ account: x.action.account, secret: 'wrong' }, x.daemonAuth,
    { ...x.auth, daemon: x.action.account }, { ...x.auth, secret: 'wrong' }]) {
    reject(() => x.core.status({ ...x.principal('owner-decision-status'), auth }), 'unauthenticated');
  }
  const inbound = x.pairing.inboundRequest(x.action.principal, x.principal('owner-decision-status'));
  reject(() => x.core.status(inbound), 'unauthenticated');
  reject(() => x.core.status({ ...x.principal('owner-decision-status'), requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }), 'owner-decision-unavailable');
  const foreign = 'principal_ffffffff-ffff-4fff-8fff-ffffffffffff';
  x.commit({ t: 'principal-request', principal: foreign, account: 'native-owner', hash: hash(x.auth.secret), code: 'OTH', at: 1 });
  x.commit({ t: 'principal-approve', principal: foreign, grant: null, at: 1 });
  x.commit({ t: 'principal-owner-grants', principal: foreign, grants: [{ account: x.action.account, souls: '*', operations: [x.action.operation] }], at: 1 });
  reject(() => x.core.status({ ...x.principal('owner-decision-status'), auth: { ...x.auth, principal: foreign } }), 'owner-decision-unavailable');
  reject(() => x.core.prepared({ ...x.preparedRequest(), account: 'fabricated' }), 'bad-request');
  reject(() => x.core.prepared({ ...x.preparedRequest(), daemonEpoch: 2 }), 'preparation-stale');
});

test('both grants and enrollment revisions recheck before issuance and release without joined or receive authority', darwin, t => {
  for (const boundary of ['issue', 'release']) for (const revoke of ['owner', 'target', 'principal', 'account', 'enrollment', 'same-keys-reinstall']) {
    const x = fixture(t); x.prepare(); x.prepared(); if (boundary === 'release') x.confirm();
    if (revoke === 'owner') x.pairing.handleAdmin({ op: 'principal-owner-grants', principal: x.action.principal, grants: [] });
    if (revoke === 'target') x.broker.state.principals.get(x.action.principal).grant = [];
    if (revoke === 'principal') x.pairing.handleAdmin({ op: 'principal-revoke', principal: x.action.principal });
    if (revoke === 'account') x.pairing.handleAdmin({ op: 'revoke', account: x.action.account });
    if (revoke === 'enrollment' || revoke === 'same-keys-reinstall') x.enrollment.revoke(2);
    if (revoke === 'same-keys-reinstall') x.enrollment.install({ revision: 3, brokerPrivateKey: x.brokerKeys.privateKey, presencePublicKey: x.presenceKeys.publicKey });
    if (boundary === 'issue') assert.throws(() => x.confirm());
    else {
      try { assert.equal(x.check().mayApply, false); } catch (error) { assert(['unauthenticated', 'owner-decision-unsupported'].includes(error.code)); }
      assert.equal(x.journal.read(x.action.requestId).slots.has('release'), false);
    }
    assert.equal(x.socket.events.filter(e => e.event === 'owner-decision').length, boundary === 'issue' ? 0 : 1);
  }
});

test('exact watch selection never fails over and a reopened released journal never replays positive permission', darwin, t => {
  const x = fixture(t); x.prepare(); x.prepared();
  const second = x.attach(new Sink()); t.after(() => second.destroy());
  x.socket.destroy(); reject(() => x.confirm(), 'daemon-unavailable');
  assert.equal(second.events.filter(e => e.event?.startsWith('owner-decision')).length, 0);
  const y = fixture(t); y.prepare(); y.prepared(); y.confirm(); assert.equal(y.check().mayApply, true);
  const reopened = y.open(); reject(() => coordinator({ ...y.options, journal: reopened }).check(y.checkRequest()), 'storage-failed');
  reopened.recover(y.action.requestId);
  const restarted = coordinator({ ...y.options, journal: reopened });
  assert.equal(restarted.check(y.checkRequest()).mayApply, false);
  assert.equal(y.socket.events.filter(e => e.event === 'owner-decision').length, 1);
});

test('cancel and expiry races preserve spent authorization and authorized expiry is refused', darwin, t => {
  const x = fixture(t); x.prepare(); x.prepared();
  assert.equal(x.core.cancel(x.principal('owner-decision-cancel')).state, 'cancelled');
  assert.equal(x.confirm().state, 'cancelled');
  assert.equal(x.socket.events.filter(e => e.event === 'owner-decision').length, 0);
  const y = fixture(t); y.prepare(); y.prepared(); y.confirm();
  assert.equal(y.core.cancel(y.principal('owner-decision-cancel')).state, 'authorized');
  y.advance(60000);
  const out = y.check(); assert.equal(out.mayApply, false); assert.equal(out.state, 'refused');
  assert.equal(y.core.status(y.principal('owner-decision-status')).outcome.code, 'deadline-expired');
  const z = fixture(t); z.prepare(); z.advance(180000);
  assert.equal(z.core.cancel(z.principal('owner-decision-cancel')).state, 'expired');
});

test('post-flush clock or socket loss suppresses first positive response and never refunds release', darwin, t => {
  for (const change of ['clock', 'socket']) {
    let x, armed = false;
    x = fixture(t, f.positive[0], { fault: event => {
      if (armed && event === 'release:fixed-trailer-flushed') {
        if (change === 'clock') x.advance(60000); else x.socket.destroy();
      }
    } });
    x.prepare(); x.prepared(); x.confirm(); armed = true;
    const out = x.check(); assert.equal(out.mayApply, false); assert.equal(out.state, 'indeterminate');
    assert.equal(x.journal.read(x.action.requestId).slots.has('release'), true);
    assert.equal(x.check().mayApply, false);
  }
});

test('journal failures before admission authorization and release never dispatch or acknowledge permission', darwin, t => {
  for (const [phase, point, eventCount] of [
    ['prepare', 'original-action:fixed-body-flushed', 0],
    ['prepare', 'acceptance:fixed-body-flushed', 0],
    ['prepare', 'acceptance:fixed-trailer-flushed', 0],
    ['prepared', 'prepared-challenge:fixed-body-flushed', 0],
    ['prepared', 'prepared-challenge:fixed-trailer-flushed', 0],
    ['confirm', 'presence:fixed-body-flushed', 0],
    ['confirm', 'presence:fixed-trailer-flushed', 0],
    ['confirm', 'receipt:fixed-body-flushed', 0],
    ['confirm', 'receipt:fixed-trailer-flushed', 0],
    ['confirm', 'authorization:fixed-body-flushed', 0],
    ['confirm', 'authorization:fixed-trailer-flushed', 0],
    ['check', 'release:fixed-body-flushed', 1],
    ['check', 'release:fixed-trailer-flushed', 1],
  ]) {
    let armed = false;
    const x = fixture(t, f.positive[0], { fault: event => { if (armed && event === point) throw new Error('canary-storage'); } });
    if (phase !== 'prepare') x.prepare();
    if (!['prepare', 'prepared'].includes(phase)) x.prepared();
    if (phase === 'check') x.confirm();
    armed = true; reject(() => x[phase](), 'storage-failed');
    assert.equal(x.socket.events.filter(e => e.event === 'owner-decision').length, eventCount);
    if (phase === 'prepare') assert.equal(x.socket.events.filter(e => e.event === 'owner-decision-prepare').length, 0);
  }
});

test('visible and reconciled foreign requests stay unavailable and unsupported reconciliation does not mutate', darwin, t => {
  const x = fixture(t); x.prepare(); x.prepared(); x.confirm(); const permit = x.check();
  const foreign = 'principal_ffffffff-ffff-4fff-8fff-ffffffffffff';
  x.commit({ t: 'principal-request', principal: foreign, account: 'native-owner', hash: hash(x.auth.secret), code: 'OTH', at: 1 });
  x.commit({ t: 'principal-approve', principal: foreign, grant: null, at: 1 });
  x.commit({ t: 'principal-owner-grants', principal: foreign, grants: [{ account: x.action.account, souls: '*', operations: [x.action.operation] }], at: 1 });
  const foreignStatus = { ...x.principal('owner-decision-status'), auth: { ...x.auth, principal: foreign } };
  const reopened = x.open(), restart = coordinator({ ...x.options, journal: reopened });
  reject(() => restart.status(foreignStatus), 'owner-decision-unavailable');
  reject(() => restart.status(x.principal('owner-decision-status')), 'storage-failed');
  const report = { v: 1, op: 'owner-decision-result', auth: x.daemonAuth, ...x.binding(), receiptDigest: permit.receiptDigest,
    state: 'indeterminate', outcome: { code: 'effect-uncertain', effectDigest: null }, reconciliation: null };
  x.core.result(report);
  const before = x.journal.read(x.action.requestId).slots;
  reject(() => x.core.result({ ...report, reconciliation: { auditId: '11111111-1111-4111-8111-111111111111', evidenceDigest: 'a'.repeat(64) } }), 'owner-decision-unsupported');
  assert.deepEqual(x.journal.read(x.action.requestId).slots, before);
  const a = JSON.parse(x.journal.read(x.action.requestId).acceptanceBytes);
  x.journal.recordResolution(x.action.requestId, bytes({ v: 1, kind: 'reconciliation-reference', requestId: a.requestId,
    payloadDigest: a.payloadDigest, originalDaemonKey: a.daemonKey, originalDaemonEpoch: a.daemonEpoch,
    reportingDaemonKey: a.daemonKey, reportingDaemonEpoch: a.daemonEpoch, at: a.acceptedAt + 1,
    finding: 'applied', auditId: '11111111-1111-4111-8111-111111111111', evidenceDigest: 'a'.repeat(64) }));
  reject(() => x.core.status(foreignStatus), 'owner-decision-unavailable');
  reject(() => x.core.status(x.principal('owner-decision-status')), 'owner-decision-unsupported');
});

test('same-key daemon epoch replacement and foreign authenticated prepared reports cannot reuse selection', darwin, t => {
  const x = fixture(t); x.prepare(); x.prepared(); x.confirm();
  const old = x.broker.state.daemons.get(x.action.account);
  x.commit({ t: 'daemon-pair-request', account: x.action.account, hash: old.hash, uid: old.uid,
    publicKey: old.publicKey, code: 'NEWDAEMON', at: 1 });
  x.pairing.handleAdmin({ op: 'approve', code: 'NEWDAEMON' });
  assert.equal(x.broker.state.daemons.get(x.action.account).epoch, 2);
  reject(() => x.check(), 'preparation-stale');
  assert.equal(x.journal.read(x.action.requestId).slots.has('release'), false);
  const y = fixture(t); y.prepare();
  // Hub membership elsewhere cannot authenticate a local preparation. C2's
  // real local census/identity resolution is a prerequisite, not exercised here.
  y.commit({ t: 'join', agentId: y.action.soul, account: 'foreign', at: 1 });
  const foreign = generateKeyPairSync('ed25519');
  for (const record of [
    { t: 'pair-request', account: 'foreign', hash: hash('account'), uid: process.getuid(), code: 'FACC', at: 1 },
    { t: 'pair-approve', account: 'foreign', at: 1 },
    { t: 'daemon-pair-request', account: 'foreign', hash: hash('foreign-secret'), uid: process.getuid(), code: 'FDAEM', at: 1,
      publicKey: foreign.publicKey.export({ type: 'spki', format: 'pem' }) },
    { t: 'daemon-pair-approve', account: 'foreign', daemonEpoch: 1, at: 1 },
  ]) y.commit(record);
  reject(() => y.core.prepared({ ...y.preparedRequest(), auth: { daemon: 'foreign', secret: 'foreign-secret' } }), 'owner-decision-unavailable');
  assert.equal(y.journal.read(y.action.requestId).state, 'preparing');
});

test('early producer refusal and outcome acknowledgment faults retain exact idempotent body independent of broker clock', darwin, t => {
  const x = fixture(t); x.prepare();
  const early = { v: 1, op: 'owner-decision-result', auth: x.daemonAuth, ...x.binding(), receiptDigest: null,
    state: 'refused', outcome: { code: 'validation-refused', effectDigest: null }, reconciliation: null };
  assert.equal(x.core.result(early).recorded, true); x.advance(3000);
  assert.equal(x.core.result(early).recorded, false);
  assert.equal(x.journal.read(x.action.requestId).slots.has('prepared-challenge'), false);
  for (const point of ['initial-outcome:fixed-body-flushed', 'initial-outcome:fixed-trailer-flushed']) {
    let armed = false;
    const y = fixture(t, f.positive[0], { fault: event => { if (armed && event === point) throw new Error('canary-outcome'); } });
    y.prepare(); y.prepared(); y.confirm(); const permit = y.check();
    const report = { v: 1, op: 'owner-decision-result', auth: y.daemonAuth, ...y.binding(), receiptDigest: permit.receiptDigest,
      state: 'applied', outcome: { code: 'applied', effectDigest: 'c'.repeat(64) }, reconciliation: null };
    armed = true; reject(() => y.core.result(report), 'storage-failed');
    if (point.endsWith('trailer-flushed')) {
      const fresh = y.open(); fresh.recover(y.action.requestId);
      y.advance(1000);
      assert.equal(coordinator({ ...y.options, journal: fresh }).result(report).recorded, false);
    }
  }
});

test('internal bounds refuse deep cyclic oversized inputs and enrollment exhaustion without production provider', darwin, t => {
  const x = fixture(t);
  reject(() => coordinator({ ...x.options, syntheticFixture: false }), 'owner-decision-unsupported');
  for (const parameters of [{ mode: 'x'.repeat(32769) }, { mode: undefined }]) reject(() => x.core.prepare({ ...x.prepareRequest, parameters }), 'bad-request');
  const cycle = {}; cycle.self = cycle; reject(() => x.core.prepare({ ...x.prepareRequest, parameters: cycle }), 'bad-request');
  let deep = {}; for (let i = 0; i < 10; i++) deep = { inner: deep };
  reject(() => x.core.prepare({ ...x.prepareRequest, parameters: deep }), 'bad-request');
  assert.equal(x.journal.inspect().retainedIds, 0);
  for (const uid of [0, -1, 0x100000000, 1.5]) assert.throws(() => new Enrollment({ namespaceDigest, service: { account: 'broker', uid } }));
  const upper = new Enrollment({ namespaceDigest, service: { account: 'broker', uid: 0xffffffff } });
  upper.install({ revision: 1023, brokerPrivateKey: x.brokerKeys.privateKey, presencePublicKey: x.presenceKeys.publicKey });
  assert.throws(() => upper.install({ revision: 1024, brokerPrivateKey: x.brokerKeys.privateKey, presencePublicKey: x.presenceKeys.publicKey }));
  upper.revoke(1024); assert.equal(upper.snapshot().active, false);
  assert.throws(() => upper.revoke(1025));
});
