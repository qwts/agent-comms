// Self-check the proposed shared artifact, not an owner-decision implementation.
// No production codec, issuer, broker route or native helper is imported here.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const fixtureUrl = new URL('../../tests/fixtures/owner-decisions/v1.json', import.meta.url);
const vectors = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const publicKey = (base64) => createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
const brokerKey = publicKey(vectors.keys.brokerSpkiBase64);
const presenceKey = publicKey(vectors.keys.presenceSpkiBase64);
assert.equal(sha256(Buffer.from(vectors.keys.brokerSpkiBase64, 'base64')), vectors.keys.brokerKey);
assert.equal(sha256(Buffer.from(vectors.keys.presenceSpkiBase64, 'base64')), vectors.keys.presenceKey);
assert.equal(Buffer.from(vectors.keys.presenceSpkiBase64, 'base64').subarray(-32).toString('base64'), vectors.keys.presenceRawBase64);

function inspectSignedFixture(token, prefix, key, expected) {
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], prefix);
  for (const part of parts.slice(1)) {
    assert.match(part, /^[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(part, 'base64url').toString('base64url'), part);
  }
  const bytes = Buffer.from(parts[1], 'base64url');
  const signature = Buffer.from(parts[2], 'base64url');
  assert.equal(signature.length, 64);
  assert(verify(null, Buffer.from(parts[1], 'ascii'), key, signature));
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), expected);
  // Signature coverage is the encoded ASCII segment, not decoded JSON bytes.
  assert(!verify(null, bytes, key, signature));
  assert(!verify(null, Buffer.from(`${parts[1]}A`, 'ascii'), key, signature));
}

const ids = new Set();
for (const vector of [...vectors.positive, ...vectors.displayBoundaries]) {
  assert(!ids.has(vector.id), `duplicate fixture ${vector.id}`);
  ids.add(vector.id);
  const bytes = Buffer.from(vector.actionJson, 'utf8');
  assert.equal(bytes.toString('base64url'), vector.actionBase64url);
  assert.equal(sha256(bytes), vector.payloadDigest);
  const action = JSON.parse(vector.actionJson);
  const text = `Owner decision ${action.operation} for ${action.account}/${action.soul}: ${vector.summary}; request ${action.requestId}; payload sha256:${vector.payloadDigest}`;
  assert.equal(text, vector.actionText);
  assert.equal([...text].length, vector.actionScalars);
  assert.equal(Buffer.byteLength(text, 'utf8'), vector.actionUtf8Bytes);
  assert(!/[\u0000-\u001f\u007f-\u009f]/u.test(text));
  const fits = vector.actionScalars <= 400 && vector.actionUtf8Bytes <= 500;
  assert.equal(fits, vector.expectedPreparation === undefined || vector.expectedPreparation === 'accept', vector.id);
  assert.equal(vector.presencePayload.action, sha256(Buffer.from(text, 'utf8')));
  assert.equal(vector.receiptPayload.payloadDigest, vector.payloadDigest);
  assert.equal(vector.receiptPayload.nonce, vector.presencePayload.nonce);
  assert.equal(Buffer.from(vector.presencePayload.nonce, 'base64url').length, 32);
  assert.equal(vector.receiptPayload.presenceDigest, sha256(Buffer.from(vector.presenceToken, 'ascii')));
  assert.equal(vector.receiptPayload.brokerKey, vectors.keys.brokerKey);
  assert.equal(vector.receiptPayload.presenceKey, vectors.keys.presenceKey);
  for (const field of ['requestId', 'principal', 'account', 'soul', 'operation']) {
    assert.equal(vector.receiptPayload[field], action[field]);
  }
  assert.equal(vector.receiptDigest, sha256(Buffer.from(vector.receiptToken, 'ascii')));
  assert(vector.receiptPayload.exp <= vector.presencePayload.exp);
  inspectSignedFixture(vector.presenceToken, 'p1', presenceKey, vector.presencePayload);
  inspectSignedFixture(vector.receiptToken, 'd1', brokerKey, vector.receiptPayload);
}

for (const vector of vectors.serialization) {
  const bytes = Buffer.from(vector.canonicalJson, 'utf8');
  assert.equal(bytes.toString('hex'), vector.utf8Hex);
  assert.equal(sha256(bytes), vector.sha256);
  assert.deepEqual(JSON.parse(vector.canonicalJson), vector.value);
}
// These equations make clock examples executable; they are not a verifier API.
for (const { id, iat, exp, now, expected } of vectors.receiptClockCases) {
  const accepts = Number.isSafeInteger(iat) && Number.isSafeInteger(exp)
    && iat >= 0 && exp >= 0 && exp > iat && exp - iat <= 60
    && iat <= now + 30 && now < exp;
  assert.equal(accepts, expected, id);
}
for (const { id, iat, exp, now, expected } of vectors.nativePresenceClockCases) {
  assert.equal(exp > iat && exp - iat <= 120 && iat <= now + 30 && now <= exp + 30, expected, id);
}
for (const { id, acceptedAt, preparedAt, exp, now, stageExp, expected } of vectors.preparationClockCases) {
  const times = [acceptedAt, preparedAt, exp, now, ...(stageExp === null ? [] : [stageExp])];
  const deadline = Math.min(preparedAt + 180, acceptedAt + 180, stageExp ?? Infinity);
  const accepts = times.every((time) => Number.isSafeInteger(time) && time >= 0)
    && preparedAt >= Math.max(0, acceptedAt - 30) && preparedAt <= now + 30
    && exp === deadline && now < deadline;
  assert.equal(accepts, expected, id);
}
for (const vector of vectors.negativeActionBytes) {
  assert.equal(vector.expected, 'refuse');
  assert.equal(Buffer.from(vector.bytesBase64url, 'base64url').toString('base64url'), vector.bytesBase64url);
}
process.stdout.write(`Static proposal fixture consistency passed: ${vectors.positive.length} signed examples, ${vectors.displayBoundaries.length} display boundaries, ${vectors.serialization.length} serialization byte examples, ${vectors.receiptClockCases.length + vectors.nativePresenceClockCases.length + vectors.preparationClockCases.length} clock examples.\n`);
process.stdout.write(`${vectors.negativeActionBytes.length} malformed-byte expectations are specified but not executed against a production codec. Runtime/native conformance remains unimplemented.\n`);
