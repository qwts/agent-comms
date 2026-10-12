import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { createOwnerDecisionLifecycleValidator } from '../lib/owner-decision-lifecycle-records.mjs';
import { decodeOwnerDecisionPrepared } from '../lib/owner-decision-prepared.mjs';
import { decodeOwnerDecisionAction } from '../lib/owner-decision-codec.mjs';
import { f, bytes, hash, daemonKey, watchId, config, lifecycleInput } from './helpers/owner-decision-lifecycle.mjs';
const validate = createOwnerDecisionLifecycleValidator(config);
const reject = fn => assert.throws(fn, { message: 'invalid-owner-journal-record' });

test('every shared operation validates exact typed monotonic prefixes and retains public stage outside challenge bytes', () => {
  for (const vector of f.positive) {
    const i = lifecycleInput(vector), prefix = new Map();
    for (const [slot, value] of i.slots) {
      prefix.set(slot, value);
      if (slot === 'original-action') continue;
      const result = validate(prefix);
      const expected = { acceptance: 'preparing', 'prepared-challenge': 'prepared', presence: 'prepared', receipt: 'prepared',
        authorization: 'authorized', release: 'released', 'initial-outcome': 'indeterminate',
        'observation-reference': 'indeterminate', 'terminal-reference': 'applied' }[slot];
      assert.equal(result.state, expected); assert.equal(result.authorizationSupported, false); assert.equal(result.physicalAllocationSupported, false);
      if (result.prepared) {
        assert.deepEqual(result.prepared.challengeBytes, bytes(i.challenge));
        assert.equal(Object.hasOwn(result.prepared.challenge, 'stage'), false);
      }
    }
  }
});

test('standalone presence crash prefixes verify exact challenge, pinned key and signed times with inherited p1 encoding', () => {
  const i = lifecycleInput(), prefix = new Map([...i.slots].slice(0, 4));
  assert.equal(validate(prefix).proofIncomplete, true);
  for (const value of ['malformed', i.vector.presenceToken + 'suffix', '\u00ff', 'x'.repeat(4097)]) {
    const bad = new Map(prefix); bad.set('presence', Buffer.from(value)); reject(() => validate(bad));
  }
  const key = generateKeyPairSync('ed25519');
  const pinned = createOwnerDecisionLifecycleValidator({ ...config, presencePublicKeys: [key.publicKey] });
  const presence = (changes = {}) => {
    // Whitespace/noncanonical JSON is intentionally allowed by the bot-owned
    // verifier; this module must not fork p1 into a canonical-JSON protocol.
    const segment = Buffer.from(JSON.stringify({ ...i.vector.presencePayload, ...changes }, null, 2)).toString('base64url');
    return Buffer.from(`p1.${segment}.${sign(null, Buffer.from(segment), key.privateKey).toString('base64url')}`);
  };
  const legacy = new Map(prefix); legacy.set('presence', presence()); assert.equal(pinned(legacy).state, 'prepared');
  reject(() => validate(legacy));
  for (const changes of [{ action: 'e'.repeat(64) }, { nonce: Buffer.alloc(32).toString('base64url') },
    { iat: i.challenge.preparedAt - 31 }, { iat: -1 }, { exp: i.challenge.preparedAt + 121 },
    { exp: i.challenge.preparedAt }, { aud: 'other' }, { kind: 'other' }]) {
    const bad = new Map(prefix); bad.set('presence', presence(changes)); reject(() => pinned(bad));
  }
});

test('wrapper exact fields, operation binding, stage expiry and original caps refuse before prepared publication', () => {
  for (const vector of [f.positive[0], ...f.positive.filter(v => JSON.parse(v.actionJson).parameters.stagingId)]) {
    const i = lifecycleInput(vector);
    const saved = { originalActionBytes: i.slots.get('original-action'), ...i.acceptance };
    const bound = decodeOwnerDecisionPrepared(bytes(i.prepared), saved, i.acceptance.acceptedAt * 1000);
    assert.deepEqual(bound.challengeBytes, bytes(i.challenge));
    const bad = [{ ...i.prepared, extra: true }, { ...i.prepared, v: 2 }, { ...i.prepared, stage: i.stage ? null : {} },
      { ...i.prepared, challenge: { ...i.challenge, exp: i.challenge.exp + 1 } }];
    if (i.stage) for (const change of [{ extra: true }, { kind: 'other' }, { stagingId: watchId },
      { contentDigest: 'e'.repeat(64) }, { expiresAt: i.stage.expiresAt - 1 }, { expiresAt: -1 }])
      bad.push({ ...i.prepared, stage: { ...i.stage, ...change } });
    for (const wrapper of bad) assert.throws(() => decodeOwnerDecisionPrepared(bytes(wrapper), saved), { message: 'invalid-owner-decision' });
    assert.throws(() => decodeOwnerDecisionPrepared(bytes(i.prepared), saved, i.challenge.exp * 1000));
  }
});

test('signed history derives a valid verification clock and never depends on an arbitrary recovery now', () => {
  const i = lifecycleInput();
  i.acceptance.acceptedAt += 60; i.challenge.acceptedAt += 60; i.challenge.preparedAt += 30; i.challenge.exp += 30;
  i.prepared.challenge = i.challenge; i.authorization.challengeDigest = hash(bytes(i.challenge));
  i.slots.set('acceptance', bytes(i.acceptance)); i.slots.set('prepared-challenge', bytes(i.prepared));
  i.slots.set('authorization', bytes(i.authorization));
  const bound = validate(i.slots);
  assert.equal(bound.historicalClock, (i.vector.receiptPayload.iat + 30) * 1000);
  assert.equal(bound.state, 'applied'); // Retained history remains readable long after expiry.
  const future = new Map(i.slots), bad = { ...i.challenge, preparedAt: i.challenge.preparedAt + 1 };
  future.set('prepared-challenge', bytes({ ...i.prepared, challenge: bad }));
  future.set('authorization', bytes({ ...i.authorization, challengeDigest: hash(bytes(bad)) })); reject(() => validate(future));
  const wrong = generateKeyPairSync('ed25519').publicKey;
  reject(() => createOwnerDecisionLifecycleValidator({ ...config, brokerPublicKeys: [wrong] })(i.slots));
  reject(() => createOwnerDecisionLifecycleValidator({ ...config, presencePublicKeys: [wrong] })(i.slots));
  reject(() => createOwnerDecisionLifecycleValidator({ ...config, brokerPublicKeys: [...config.brokerPublicKeys, ...config.brokerPublicKeys] }));
  const mutable = { ...config, brokerPublicKeys: [...config.brokerPublicKeys], presencePublicKeys: [...config.presencePublicKeys] };
  const captured = createOwnerDecisionLifecycleValidator(mutable); mutable.brokerPublicKeys.length = 0; mutable.presencePublicKeys.length = 0;
  assert.equal(captured(i.slots).state, 'applied');
});

test('missing predecessors, conflicting exact bindings, invalid proofs and impossible outcome graphs refuse', () => {
  const i = lifecycleInput();
  for (const slot of ['original-action', 'acceptance', 'prepared-challenge', 'presence', 'receipt', 'authorization', 'release', 'initial-outcome']) {
    const bad = new Map(i.slots); bad.delete(slot); reject(() => validate(bad));
  }
  for (const [slot, object, field, value] of [
    ['authorization', i.authorization, 'requestId', watchId], ['authorization', i.authorization, 'actionDigest', 'e'.repeat(64)],
    ['authorization', i.authorization, 'challengeDigest', hash(i.slots.get('prepared-challenge'))],
    ['authorization', i.authorization, 'presenceDigest', 'e'.repeat(64)], ['release', i.release, 'mayApply', false],
    ['release', i.release, 'exp', i.release.exp + 1], ['release', i.release, 'watchId', i.action.requestId],
    ['initial-outcome', i.outcome, 'receiptDigest', null], ['observation-reference', i.reference, 'originalDaemonEpoch', 2],
    ['terminal-reference', { ...i.reference, finding: 'applied' }, 'finding', 'indeterminate']]) {
    const bad = new Map(i.slots); bad.set(slot, bytes({ ...object, [field]: value })); reject(() => validate(bad));
  }
  for (const slot of ['presence', 'receipt']) {
    const bad = new Map(i.slots); bad.set(slot, Buffer.from(i.slots.get(slot).toString().replace(/.$/, '!'))); reject(() => validate(bad));
  }
  const bad = new Map(i.slots); bad.set('arbitrary', bytes({ secret: 'not disclosed' })); reject(() => validate(bad));
  assert.equal(decodeOwnerDecisionAction(i.slots.get('original-action')).payloadDigest, i.acceptance.payloadDigest);
});

test('early terminal outcomes, request-linked daemon outcomes and reconciliation preserve monotonic evidence', () => {
  const i = lifecycleInput();
  for (const [state, code] of [['cancelled', 'cancelled'], ['expired', 'deadline-expired'], ['refused', 'authority-refused']]) {
    const early = new Map([...i.slots].slice(0, 2));
    early.set('initial-outcome', bytes({ ...i.outcome, state, receiptDigest: null, outcome: { code, effectDigest: null } }));
    assert.equal(validate(early).state, state);
    early.set('terminal-reference', i.slots.get('terminal-reference')); reject(() => validate(early));
  }
  const daemon = new Map([...i.slots].slice(0, 7));
  const applied = { ...i.outcome, state: 'applied', source: 'daemon', reportingDaemonKey: daemonKey, reportingDaemonEpoch: 1,
    outcome: { code: 'applied', effectDigest: 'e'.repeat(64) } };
  daemon.set('initial-outcome', bytes(applied)); assert.equal(validate(daemon).state, 'applied');
  for (const changes of [{ source: 'broker', reportingDaemonKey: null, reportingDaemonEpoch: null },
    { reportingDaemonEpoch: 2 }, { outcome: { code: 'applied', effectDigest: null } }]) {
    const bad = new Map(daemon); bad.set('initial-outcome', bytes({ ...applied, ...changes })); reject(() => validate(bad));
  }
  const refused = new Map(i.slots); refused.set('terminal-reference', bytes({ ...i.reference, finding: 'refused' }));
  assert.equal(validate(refused).state, 'refused');
});
