import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { issueOwnerDecisionReceipt as issue } from '../lib/owner-decision-issuer.mjs';
import { verifyOwnerDecisionProof } from '../lib/owner-decision-proof.mjs';
const f = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions/v1.json', import.meta.url)));
const canonical = v => v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const bytes = v => Buffer.from(canonical(v));
const hash = v => createHash('sha256').update(v).digest('hex');
const broker = generateKeyPairSync('ed25519');
const presencePublicKey = createPublicKey({ key: Buffer.from(f.keys.presenceSpkiBase64, 'base64'), format: 'der', type: 'spki' });
const reject = fn => assert.throws(fn, { message: 'invalid-owner-decision' });
function input(vector = f.positive[0]) {
  const a = JSON.parse(vector.actionJson), p = vector.receiptPayload;
  const challenge = { requestId: a.requestId, principal: a.principal, account: a.account, soul: a.soul,
    operation: a.operation, payloadDigest: vector.payloadDigest, action: vector.actionBase64url,
    nonce: p.nonce, acceptedAt: p.iat, preparedAt: p.iat, exp: p.iat + 180,
    daemonKey: 'a'.repeat(64), daemonEpoch: 1, watchId: '11111111-1111-4111-8111-111111111111' };
  const stage = a.parameters.stagingId ? { stagingId: a.parameters.stagingId,
    kind: a.operation === 'cold-wake.set' ? 'webhook' : 'package',
    contentDigest: a.parameters.packageDigest ?? a.parameters.configurationDigest, expiresAt: challenge.exp } : null;
  return { preparedBytes: bytes({ v: 1, challenge, stage }), saved: { originalActionBytes: Buffer.from(vector.actionJson),
    acceptedAt: p.iat, daemonKey: challenge.daemonKey, daemonEpoch: 1, watchId: challenge.watchId },
  presenceToken: vector.presenceToken, presencePublicKey, brokerPrivateKey: broker.privateKey, nowMilliseconds: p.iat * 1000 };
}
test('issuer composes every shared action with exact canonical d1 signature and existing joint verifier', () => {
  for (const v of f.positive) {
    const o = input(v), result = issue(o), wrapper = JSON.parse(o.preparedBytes);
    assert.equal(result.receiptDigest, hash(result.receiptToken));
    assert.equal(Buffer.from(result.receiptToken.split('.')[1], 'base64url').toString(), canonical(result.payload));
    assert.equal(result.payload.exp, Math.min(v.receiptPayload.iat + 60, v.presencePayload.exp));
    const proof = verifyOwnerDecisionProof({ ...o, receiptToken: result.receiptToken,
      brokerPublicKey: broker.publicKey, challengeBytes: bytes(wrapper.challenge), saved: { ...o.saved,
        ...(wrapper.stage ? { stageExpiresAt: wrapper.stage.expiresAt } : {}) } });
    assert.equal(proof.receiptDigest, result.receiptDigest);
    assert.deepEqual(Object.keys(result).sort(), ['payload', 'receiptDigest', 'receiptToken']);
  }
});
test('issuance floors milliseconds and respects presence expiry without verifier grace', () => {
  const o = input(), p = JSON.parse(Buffer.from(o.presenceToken.split('.')[1], 'base64url'));
  const atLast = issue({ ...o, nowMilliseconds: p.exp * 1000 - 1 });
  assert.equal(atLast.payload.iat, p.exp - 1); assert.equal(atLast.payload.exp, p.exp);
  reject(() => issue({ ...o, nowMilliseconds: p.exp * 1000 }));
  for (const nowMilliseconds of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) reject(() => issue({ ...o, nowMilliseconds }));
});
test('short saved preparation and authenticated stage deadlines cap receipt independently', () => {
  for (const v of [f.positive[0], f.positive.find(v => JSON.parse(v.actionJson).parameters.stagingId)]) {
    const o = input(v), w = JSON.parse(o.preparedBytes), now = o.nowMilliseconds / 1000;
    if (w.stage) { w.stage.expiresAt = now + 7; w.challenge.exp = now + 7; }
    else { w.challenge.acceptedAt = now - 173; o.saved.acceptedAt = now - 173; w.challenge.exp = now + 7; }
    assert.equal(issue({ ...o, preparedBytes: bytes(w) }).payload.exp, now + 7);
    reject(() => issue({ ...o, preparedBytes: bytes(w), nowMilliseconds: (now + 7) * 1000 }));
  }
});
test('issuer refuses wrong presence action nonce audience signature and stale preparation before signing', () => {
  const o = input(), pair = generateKeyPairSync('ed25519');
  const p = JSON.parse(Buffer.from(o.presenceToken.split('.')[1], 'base64url'));
  for (const change of [{ action: 'b'.repeat(64) }, { nonce: 'wrong' }, { aud: 'geniusbar-native-enrollment-v1' },
    { iat: p.iat - 31 }, { exp: p.iat }]) {
    const segment = bytes({ ...p, ...change }).toString('base64url');
    const presenceToken = `p1.${segment}.${sign(null, Buffer.from(segment), pair.privateKey).toString('base64url')}`;
    reject(() => issue({ ...o, presenceToken, presencePublicKey: pair.publicKey }));
  }
  reject(() => issue({ ...o, presenceToken: o.presenceToken.slice(0, -5) }));
  reject(() => issue({ ...o, saved: { ...o.saved, daemonEpoch: 2 } }));
  reject(() => issue({ ...o, saved: { ...o.saved, watchId: '22222222-2222-4222-8222-222222222222' } }));
});
test('receipt presence and daemon keys remain separate and key types are strict', () => {
  const o = input();
  reject(() => issue({ ...o, presencePublicKey: broker.publicKey }));
  for (const key of [broker.publicKey, 'not-a-key', null]) reject(() => issue({ ...o, brokerPrivateKey: key }));
  reject(() => issue({ ...o, presencePublicKey: broker.privateKey }));
  for (const key of [broker.publicKey, presencePublicKey]) {
    const daemonKey = hash(key.export({ type: 'spki', format: 'der' })), w = JSON.parse(o.preparedBytes);
    w.challenge.daemonKey = daemonKey;
    reject(() => issue({ ...o, preparedBytes: bytes(w), saved: { ...o.saved, daemonKey } }));
  }
});
test('malformed options and hostile getters are sanitized and saved context is read only once', () => {
  reject(() => issue(null)); const o = input();
  for (const field of Object.keys(o)) {
    const bad = { ...o }; Object.defineProperty(bad, field, { get() { throw new Error('secret-canary'); } });
    reject(() => issue(bad));
  }
  const saved = {}; const reads = {};
  for (const [field, value] of Object.entries(o.saved)) Object.defineProperty(saved, field, {
    get() { reads[field] = (reads[field] ?? 0) + 1; if (reads[field] > 1) throw new Error('reread'); return value; }
  });
  issue({ ...o, saved }); assert(Object.values(reads).every(count => count === 1));
});

test('published synthetic issuer vectors reproduce exact d1 bytes for daemon conformance', async () => {
  const { createPrivateKey } = await import('node:crypto');
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions/issuer-v1.json', import.meta.url)));
  assert.equal(vectors.sourceSha256, hash(readFileSync(new URL('./fixtures/owner-decisions/v1.json', import.meta.url))));
  assert.equal(vectors.cases.length, f.positive.length);
  const brokerPrivateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(vectors.brokerSeedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  assert.equal(createPublicKey(brokerPrivateKey).export({ type: 'spki', format: 'der' }).toString('base64'), vectors.brokerSpkiBase64);
  for (const [index, v] of vectors.cases.entries()) {
    assert.equal(v.sourceIndex, index);
    const result = issue({ ...input(f.positive[index]), brokerPrivateKey,
      preparedBytes: Buffer.from(v.preparedJson), nowMilliseconds: v.nowMilliseconds });
    assert.equal(result.receiptToken, v.receiptToken);
    assert.equal(result.receiptDigest, v.receiptDigest); assert.deepEqual(result.payload, v.payload);
  }
});
