import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sign } from 'node:crypto';
import { fixture } from './helpers/owner-coordinator.mjs';
import { bytes, f } from './helpers/owner-decision-lifecycle.mjs';
import { SyntheticOwnerReceiptCapability as Capability } from '../lib/broker/owner-receipt-fixture.mjs';
import { createDisabledOwnerDecisionCoordinator as coordinator } from '../lib/broker/owner-decisions.mjs';
import { createProtectedOwnerReceiptCapability } from '../lib/platform/owner-receipt-capability.mjs';
const darwin = { skip: process.platform !== 'darwin', timeout: 120000 };
const refuse = async promise => assert.rejects(promise, e => typeof e.code === 'string' && !/canary/.test(e.message));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function setup(t, options = {}, journalOptions = {}) {
  let calls = 0;
  const gate = deferred(), entered = deferred();
  const x = fixture(t, f.positive[0], journalOptions, {
    ...options, makeSigningCapability: enrollment => new Capability(enrollment, { syntheticFixture: true,
      ...options, beforeSign: async signal => { calls++; entered.resolve(); await gate.promise;
        if (options.fail) throw new Error('canary-native-secret'); if (options.onSign) options.onSign(signal); } }),
  });
  x.prepare(); x.prepared();
  return { ...x, gate, entered, calls: () => calls };
}
const events = x => x.socket.events.filter(e => e.event === 'owner-decision');

test('async protected seam retains presence before signer and dispatches only after durable authorization', darwin, async t => {
  const x = setup(t), request = x.confirmRequest(), id = x.action.requestId;
  x.socket.beforeWrite = e => { if (e.event === 'owner-decision') assert.equal(x.journal.read(id).state, 'authorized'); };
  const pending = x.core.confirm(request); await x.entered.promise;
  const row = x.journal.read(id);
  assert.equal(row.slots.get('presence').toString(), request.presence); assert.equal(row.state, 'prepared');
  assert.equal(row.slots.has('receipt'), false); assert.equal(events(x).length, 0); assert.equal(x.calls(), 1);
  await refuse(x.core.confirm(request)); assert.equal(x.calls(), 1);
  x.gate.resolve(); assert.equal((await pending).state, 'authorized');
  assert.equal(events(x).length, 1); assert.equal((await x.core.confirm(request)).state, 'authorized');
  assert.equal(events(x).length, 1); assert.equal(x.calls(), 1);
  assert.equal(x.check().mayApply, true); assert.equal(x.check().mayApply, false);
  assert.throws(createProtectedOwnerReceiptCapability, { message: 'owner-receipt-unavailable' });
});

test('cancel close and expiry defeat delayed private candidates and retries never resign', darwin, async t => {
  for (const boundary of ['cancel', 'close', 'expiry', 'presence-expiry', 'pre-microtask-cancel', 'pre-microtask-close']) {
    const x = setup(t), request = x.confirmRequest(), pending = x.core.confirm(request);
    // Observe rejection from the outset so intentional early cancellation is handled.
    const rejected = refuse(pending);
    if (!boundary.startsWith('pre-microtask')) await x.entered.promise;
    if (boundary.endsWith('cancel')) x.core.cancel(x.principal('owner-decision-cancel'));
    if (boundary.endsWith('close')) x.core.close();
    if (boundary === 'expiry') x.advance(180000);
    if (boundary === 'presence-expiry') x.advance(120000);
    x.gate.resolve(); await rejected;
    assert.equal(events(x).length, 0); assert.equal(x.journal.read(x.action.requestId).slots.has('authorization'), false);
    assert.equal(x.calls(), boundary.startsWith('pre-microtask') ? 0 : 1);
    if (!boundary.endsWith('close')) { try { await x.core.confirm(request); } catch {} assert.equal(x.calls(), boundary.startsWith('pre-microtask') ? 0 : 1); }
  }
});

test('fresh principal grant daemon epoch watch and source checks after await suppress issuance', darwin, async t => {
  for (const mutation of ['principal', 'owner-grant', 'target-grant', 'account', 'daemon', 'watch', 'enrollment', 'reinstall', 'credential', 'same-head-custody']) {
    const x = setup(t), pending = x.core.confirm(x.confirmRequest()), rejected = refuse(pending); await x.entered.promise;
    if (mutation === 'principal') x.pairing.handleAdmin({ op: 'principal-revoke', principal: x.action.principal });
    if (mutation === 'owner-grant') x.pairing.handleAdmin({ op: 'principal-owner-grants', principal: x.action.principal, grants: [] });
    if (mutation === 'target-grant') x.broker.state.principals.get(x.action.principal).grant = [];
    if (mutation === 'account') x.pairing.handleAdmin({ op: 'revoke', account: x.action.account });
    if (mutation === 'daemon') x.broker.state.daemons.get(x.action.account).epoch++;
    if (mutation === 'watch') x.socket.destroy();
    if (mutation === 'enrollment' || mutation === 'reinstall') x.enrollment.revoke(2);
    if (mutation === 'reinstall') x.enrollment.install({ revision: 3, brokerPrivateKey: x.brokerKeys.privateKey, presencePublicKey: x.presenceKeys.publicKey });
    if (mutation === 'credential') x.broker.state.principals.get(x.action.principal).hash = '0'.repeat(64);
    if (mutation === 'same-head-custody') {
      const original = x.options.signingCapability.observe.bind(x.options.signingCapability);
      x.options.signingCapability.observe = () => ({ ...original(), custodyFingerprint: 'c'.repeat(64) });
    }
    x.gate.resolve(); await rejected; assert.equal(events(x).length, 0);
    assert.equal(x.journal.read(x.action.requestId).slots.has('authorization'), false);
  }
});

test('restart and token signature aliases cannot obtain another signing handle or native attempt', darwin, async t => {
  const x = setup(t), request = x.confirmRequest(), pending = x.core.confirm(request); await x.entered.promise;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(request.presence.at(-1));
  const alias = request.presence.slice(0, -1) + alphabet[last ^ 1];
  assert.deepEqual(Buffer.from(alias.split('.')[2], 'base64url'), Buffer.from(request.presence.split('.')[2], 'base64url'));
  assert.throws(() => x.journal.beginSigning(x.action.requestId, Buffer.from(alias)), { message: 'owner-journal-id-spent' });
  const fresh = x.open(); fresh.recover(x.action.requestId);
  assert.throws(() => fresh.beginSigning(x.action.requestId, Buffer.from(request.presence)), { message: 'owner-journal-id-spent' });
  const restarted = coordinator({ ...x.options, journal: fresh }); await refuse(restarted.confirm(request)); assert.equal(x.calls(), 1);
  // Reuse the nonce under a different otherwise valid request/action and fresh signature.
  const nextId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const prepare = { ...x.prepareRequest, requestId: nextId }; x.core.prepare(prepare);
  const a = JSON.parse(x.journal.read(nextId).acceptanceBytes), original = JSON.parse(x.journal.read(x.action.requestId).slots.get('prepared-challenge'));
  x.core.prepared({ ...x.preparedRequest(), requestId: nextId, payloadDigest: a.payloadDigest,
    nonce: original.challenge.nonce });
  const w = JSON.parse(x.journal.read(nextId).slots.get('prepared-challenge'));
  const p = JSON.parse(Buffer.from(request.presence.split('.')[1], 'base64url'));
  const { decodeOwnerDecisionAction } = await import('../lib/owner-decision-codec.mjs');
  const { createHash } = await import('node:crypto');
  p.action = createHash('sha256').update(decodeOwnerDecisionAction(x.journal.read(nextId).actionBytes).actionText).digest('hex');
  const segment = bytes(p).toString('base64url'), token = `p1.${segment}.${sign(null, Buffer.from(segment), x.presenceKeys.privateKey).toString('base64url')}`;
  assert.equal(w.challenge.nonce, original.challenge.nonce);
  await refuse(x.core.confirm({ ...request, requestId: nextId, payloadDigest: a.payloadDigest, presence: token }));
  assert.equal(x.calls(), 1); x.gate.resolve(); await pending;
});

test('native failure timeout and unconfirmed terminal keep private candidates and spent IDs', darwin, async t => {
  for (const options of [{ fail: true }, { terminalConfirmed: false }, { safeClose: false }, { fail: true, terminalReject: true }, { signingTimeoutMilliseconds: 20 }]) {
    const x = setup(t, options), request = x.confirmRequest(), pending = x.core.confirm(request), rejected = refuse(pending);
    await x.entered.promise;
    if (!options.signingTimeoutMilliseconds) x.gate.resolve();
    await rejected;
    assert.equal(events(x).length, 0); assert.equal(x.journal.read(x.action.requestId).slots.has('receipt'), false);
    await refuse(x.core.confirm(request)); assert.equal(x.calls(), 1); x.gate.resolve();
  }
});

test('presence receipt and authorization write faults release no token and explicit recovery never resigns', darwin, async t => {
  for (const point of ['presence:fixed-body-flushed', 'presence:fixed-trailer-flushed',
    'receipt:fixed-body-flushed', 'receipt:fixed-trailer-flushed', 'authorization:fixed-body-flushed', 'authorization:fixed-trailer-flushed']) {
    let armed = false;
    const x = setup(t, {}, { fault: at => { if (armed && at === point) throw new Error('canary-uncertain-write'); } });
    armed = true; const pending = x.core.confirm(x.confirmRequest()), rejected = refuse(pending);
    if (!point.startsWith('presence')) { await x.entered.promise; x.gate.resolve(); }
    await rejected; assert.equal(events(x).length, 0);
    let fresh;
    try { fresh = x.open(); } catch (error) {
      assert.equal(error.message, 'owner-journal-corrupt');
      assert(point.endsWith('body-flushed')); assert.equal(x.calls(), point.startsWith('presence') ? 0 : 1); continue;
    }
    try { fresh.recover(x.action.requestId); } catch {}
    const restart = coordinator({ ...x.options, journal: fresh });
    try { await restart.confirm(x.confirmRequest()); } catch {}
    assert.equal(x.calls(), point.startsWith('presence') ? 0 : 1);
  }
});

test('actual ingress close cancels suspended coordinator before dropping its reference', darwin, async t => {
  const { createDisabledOwnerDecisionIngressForTest } = await import('../lib/broker/owner-ingress.mjs');
  const { lineReader } = await import('../lib/wire.mjs');
  const { EventEmitter } = await import('node:events');
  const x = setup(t), request = x.confirmRequest();
  const ingress = createDisabledOwnerDecisionIngressForTest({ ...x.options, fixtureCoordinator: x.core, syntheticFixture: true });
  const input = new EventEmitter(); let pending;
  lineReader(input, (r, metadata) => { pending = ingress.handle(r, metadata); }, assert.fail, { ownerRequests: true });
  input.emit('data', Buffer.from(JSON.stringify(request) + '\n'));
  const rejected = refuse(pending); await x.entered.promise; ingress.close(); x.gate.resolve(); await rejected;
  assert.equal(events(x).length, 0); assert.equal(x.journal.read(x.action.requestId).slots.has('receipt'), false);
});

test('unconfirmed or rejected terminal keeps finite capacity charged without unhandled rejections', darwin, async t => {
  for (const fault of [{ terminalConfirmed: false }, { terminalReject: true, fail: true }, { launchThrow: true }]) {
    const x = setup(t, fault); x.gate.resolve();
    let launches = 0;
    if (fault.launchThrow) x.options.signingCapability.startDecisionReceipt = () => { launches++; throw new Error('canary-launch-uncertain'); };
    for (let i = 0; i < 4; i++) {
      const id = i === 0 ? x.action.requestId : `ffffffff-ffff-4fff-8fff-${String(i).padStart(12, '0')}`;
      if (i) { x.prepare(id); x.prepared(id); }
      await refuse(x.core.confirm(x.confirmRequest(id)));
    }
    assert.equal(fault.launchThrow ? launches : x.calls(), 4);
    const id = 'ffffffff-ffff-4fff-8fff-000000000005'; x.prepare(id); x.prepared(id);
    await refuse(x.core.confirm(x.confirmRequest(id)));
    assert.equal(fault.launchThrow ? launches : x.calls(), 4); assert.equal(x.journal.read(id).slots.has('presence'), false);
    assert.equal(events(x).length, 0);
  }
});

test('global uncertain invocation budget refuses thirty-third principal before spending presence', darwin, async t => {
  const { createHash } = await import('node:crypto');
  const x = setup(t, { terminalConfirmed: false }); x.gate.resolve();
  for (let i = 0; i < 33; i++) {
    const requestId = i === 0 ? x.action.requestId : `ffffffff-ffff-4fff-8fff-${String(i).padStart(12, '0')}`;
    const principal = i === 0 ? x.action.principal : `principal_eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, '0')}`;
    const auth = { ...x.auth, principal };
    if (i) {
      x.commit({ t: 'principal-request', principal, account: 'native-owner', hash: createHash('sha256').update(auth.secret).digest('hex'), code: `P${i}`, at: 1 });
      x.commit({ t: 'principal-approve', principal, grant: null, at: 1 });
      x.commit({ t: 'principal-owner-grants', principal, grants: [{ account: x.action.account, souls: [x.action.soul], operations: [x.action.operation] }], at: 1 });
      x.core.prepare({ ...x.prepareRequest, requestId, auth }); x.prepared(requestId);
    }
    await refuse(x.core.confirm({ ...x.confirmRequest(requestId), auth }));
    assert.equal(x.calls(), Math.min(i + 1, 32));
    assert.equal(x.journal.read(requestId).slots.has('presence'), i < 32);
  }
  assert.equal(events(x).length, 0);
});


test('revocation after private result but before separate terminal receipt suppresses authorization', darwin, async t => {
  const terminalGate = deferred(), terminalEntered = deferred();
  const x = setup(t, { beforeTerminal: async () => { terminalEntered.resolve(); await terminalGate.promise; } });
  const pending = x.core.confirm(x.confirmRequest()), rejected = refuse(pending);
  await x.entered.promise; x.gate.resolve(); await terminalEntered.promise;
  x.pairing.handleAdmin({ op: 'principal-owner-grants', principal: x.action.principal, grants: [] });
  terminalGate.resolve(); await rejected;
  assert.equal(events(x).length, 0); assert.equal(x.journal.read(x.action.requestId).slots.has('authorization'), false);
});
