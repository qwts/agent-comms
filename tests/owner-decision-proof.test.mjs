import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { verifyOwnerDecisionProof as verify } from '../lib/owner-decision-proof.mjs';
import { actionDigest, verifyPresence } from '../lib/vendor/agent-bot-presence/identity-presence.mjs';
const f = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions/v1.json', import.meta.url)));
const canonical = v => v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(canonical)}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const bytes = v => Buffer.from(canonical(v));
const hash = v => createHash('sha256').update(v).digest('hex');
const key = b64 => createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
const reject = fn => assert.throws(fn, { message: 'invalid-owner-decision' });
function input(vector = f.positive[0]) {
  const action = JSON.parse(vector.actionJson), p = vector.receiptPayload;
  const challenge = { requestId: action.requestId, principal: action.principal, account: action.account,
    soul: action.soul, operation: action.operation, payloadDigest: vector.payloadDigest,
    action: vector.actionBase64url, nonce: p.nonce, acceptedAt: p.iat, preparedAt: p.iat, exp: p.iat + 180,
    daemonKey: 'a'.repeat(64), daemonEpoch: 1, watchId: '11111111-1111-4111-8111-111111111111' };
  const saved = { originalActionBytes: Buffer.from(vector.actionJson), acceptedAt: p.iat,
    daemonKey: challenge.daemonKey, daemonEpoch: 1, watchId: challenge.watchId,
    ...(action.parameters.stagingId ? { stageExpiresAt: p.iat + 180 } : {}) };
  return { challengeBytes: bytes(challenge), saved, presenceToken: vector.presenceToken,
    receiptToken: vector.receiptToken, brokerPublicKey: key(f.keys.brokerSpkiBase64),
    presencePublicKey: key(f.keys.presenceSpkiBase64), nowMilliseconds: p.iat * 1000 };
}
const broker = generateKeyPairSync('ed25519');
function receipt(options, changes = {}) {
  const payload = JSON.parse(Buffer.from(options.receiptToken.split('.')[1], 'base64url'));
  Object.assign(payload, { brokerKey: hash(broker.publicKey.export({ type: 'spki', format: 'der' })) }, changes);
  const segment = bytes(payload).toString('base64url');
  return { ...options, brokerPublicKey: broker.publicKey,
    receiptToken: `d1.${segment}.${sign(null, Buffer.from(segment), broker.privateKey).toString('base64url')}` };
}
test('shared vectors verify complete action/challenge/d1/p1 bindings through bot-owned verifier', () => {
  for (const vector of f.positive) {
    const result = verify(input(vector));
    assert.equal(result.receiptDigest, vector.receiptDigest);
    assert.equal(result.presenceDigest, vector.receiptPayload.presenceDigest);
    assert.equal(result.actionText, vector.actionText);
    assert.deepEqual(Object.keys(result.presence).sort(), ['exp', 'iat']);
  }
});
test('validly signed receipts still refuse mismatched saved fields, presence key and complete token digest', () => {
  const options = input();
  for (const change of [ { account: 'other' }, { soul: 'agent_22222222-2222-4222-8222-222222222222' },
    { requestId: '22222222-2222-4222-8222-222222222222' }, { principal: 'principal_22222222-2222-4222-8222-222222222222' },
    { operation: 'revision.reject' }, { payloadDigest: 'b'.repeat(64) }, { nonce: Buffer.alloc(32, 8).toString('base64url') },
    { presenceKey: 'c'.repeat(64) }, { presenceDigest: 'd'.repeat(64) } ]) reject(() => verify(receipt(options, change)));
  reject(() => verify({ ...options, presencePublicKey: broker.publicKey }));
  reject(() => verify({ ...options, presencePublicKey: broker.privateKey }));
  for (const token of ['', 'p1.' + 'x'.repeat(4094), options.presenceToken + '\u00e9', options.presenceToken.slice(0, -2)]) {
    reject(() => verify(receipt({ ...options, presenceToken: token }, { presenceDigest: hash(token) })));
  }
});
test('receipt lifetime cannot extend preparation or presence, even when independent signature verification succeeds', () => {
  const options = input(); const now = options.nowMilliseconds / 1000;
  const short = JSON.parse(options.challengeBytes); short.exp = now + 10;
  const shortened = { ...options, challengeBytes: bytes(short), saved: { ...options.saved, acceptedAt: now - 170 } };
  short.acceptedAt = now - 170; short.preparedAt = now - 170; shortened.challengeBytes = bytes(short);
  reject(() => verify(receipt(shortened, { exp: now + 11 })));
  verify(receipt(shortened, { exp: now + 10 }));
  const p = JSON.parse(Buffer.from(options.presenceToken.split('.')[1], 'base64url'));
  reject(() => verify(receipt({ ...options, nowMilliseconds: (p.exp - 1) * 1000 }, { iat: p.exp - 1, exp: p.exp + 1 })));
  reject(() => verify({ ...options, nowMilliseconds: JSON.parse(Buffer.from(options.receiptToken.split('.')[1], 'base64url')).exp * 1000 }));
});
test('vendored public closure hashes match pinned provenance and preserves shared p1 parity', () => {
  const root = new URL('../lib/vendor/agent-bot-presence/', import.meta.url);
  const source = JSON.parse(readFileSync(new URL('source.json', root)));
  assert.equal(source.commit, 'c5f8399c8832dea323c156fd71270ea4786182df');
  for (const [name, digest] of Object.entries(source.files)) assert.equal(hash(readFileSync(new URL(name, root))), digest);
  for (const vector of f.positive) {
    assert.equal(actionDigest(vector.actionText), vector.presencePayload.action);
    assert.deepEqual(verifyPresence(vector.presenceToken, { key: f.keys.presenceRawBase64,
      action: vector.actionText, nonce: vector.presencePayload.nonce, now: vector.receiptPayload.iat * 1000 }), vector.presencePayload);
  }
});
test('malformed proof options and nested getters remain sanitized', () => {
  reject(() => verify(null));
  const options = input();
  for (const field of Object.keys(options)) {
    const hostile = { ...options }; Object.defineProperty(hostile, field, { get() { throw new Error('secret-canary'); } });
    reject(() => verify(hostile));
  }
  const saved = { ...options.saved }; Object.defineProperty(saved, 'watchId', { get() { throw new Error('secret-canary'); } });
  reject(() => verify({ ...options, saved }));
});

test('freshly signed p1 must bind action and nonce while retaining bot decoding semantics', () => {
  const options = input();
  const presence = generateKeyPairSync('ed25519');
  const base = JSON.parse(Buffer.from(options.presenceToken.split('.')[1], 'base64url'));
  function proof(changes, pretty = false) {
    const payload = { ...base, ...changes };
    const segment = Buffer.from(JSON.stringify(payload, null, pretty ? 2 : 0)).toString('base64url');
    const token = `p1.${segment}.${sign(null, Buffer.from(segment), presence.privateKey).toString('base64url')}`;
    return receipt({ ...options, presenceToken: token, presencePublicKey: presence.publicKey }, {
      presenceKey: hash(presence.publicKey.export({ type: 'spki', format: 'der' })), presenceDigest: hash(token),
    });
  }
  verify(proof({}));
  const result = verify(proof({ extra: 'not returned' }, true));
  assert.deepEqual(Object.keys(result.presence).sort(), ['exp', 'iat']);
  for (const change of [{ action: 'a'.repeat(64) }, { nonce: 'wrong' }, { aud: 'other' },
    { kind: 'other' }, { exp: base.iat + 121 }, { iat: base.iat + 31, exp: base.iat + 60 }]) {
    reject(() => verify(proof(change)));
  }
});

test('cross-clock issuance ordering accepts equality but refuses one second beyond skew', () => {
  const options = input(), now = options.nowMilliseconds / 1000;
  const presence = generateKeyPairSync('ed25519');
  const base = JSON.parse(Buffer.from(options.presenceToken.split('.')[1], 'base64url'));
  function proof(presenceIat, receiptIat, preparedAt = now) {
    const payload = { ...base, iat: presenceIat, exp: now + 20 };
    const segment = bytes(payload).toString('base64url');
    const token = `p1.${segment}.${sign(null, Buffer.from(segment), presence.privateKey).toString('base64url')}`;
    const challenge = JSON.parse(options.challengeBytes);
    challenge.preparedAt = preparedAt;
    challenge.exp = Math.min(preparedAt + 180, now + 180);
    return receipt({ ...options, challengeBytes: bytes(challenge), presenceToken: token, presencePublicKey: presence.publicKey }, {
      iat: receiptIat, exp: now + 20,
      presenceKey: hash(presence.publicKey.export({ type: 'spki', format: 'der' })), presenceDigest: hash(token),
    });
  }
  verify(proof(now - 30, now));
  reject(() => verify(proof(now - 31, now)));
  verify(proof(now, now - 30));
  reject(() => verify(proof(now, now - 31)));
  // Earlier preparation keeps its separate lower bound satisfied, isolating
  // receipt versus presence order from receipt versus preparation order.
  verify(proof(now, now - 30, now - 30));
  reject(() => verify(proof(now, now - 31, now - 30)));
});
