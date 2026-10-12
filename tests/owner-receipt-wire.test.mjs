import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeOwnerReceiptNativeCommand as encode, decodeOwnerReceiptNativeResponse as decode } from '../lib/platform/owner-receipt-wire.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions/protected-signing-v1.json', import.meta.url)));
const vectors = fixture.cases;
const canonical = value => Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0))));
const command = () => JSON.parse(vectors[0].commandJson);
const expected = c => ({ requestId: JSON.parse(Buffer.from(c.originalAction, 'base64url')).requestId,
  brokerEnrollmentHeadDigest: c.brokerEnrollmentHeadDigest });
const response = (c, signature = vectors[0].signature) => ({ v: 1, kind: 'owner-decision-receipt-signature', ...expected(c), signature });
const refuses = fn => assert.throws(fn, error => error.message === 'owner-receipt-unavailable');

test('native command preserves eleven frozen canonical commands and exact raw64 responses', () => {
  assert.equal(vectors.length, 11);
  for (const vector of vectors) {
    const c = JSON.parse(vector.commandJson);
    assert.equal(encode(c).toString(), vector.commandJson);
    assert.deepEqual(decode(canonical(response(c, vector.signature)), expected(c)).signature,
      Buffer.from(vector.signature, 'base64url'));
  }
  const alias = { ...command(), presence: command().presence + '\n' };
  assert.equal(JSON.parse(encode(alias)).presence, alias.presence, 'framing preserves existing p1 ASCII decoding semantics');
});

test('native command refuses unknown selectors, accessors and bounded primitive/encoding failures', () => {
  for (const change of [
    { path: '/untrusted' }, { privateKey: 'secret' }, { op: 'sign' }, { brokerLocalRevision: 0 }, { brokerLocalRevision: 1024 },
    { namespaceDigest: 'c'.repeat(64) + '\n' }, { observationDigest: null }, { iat: -0 }, { iat: -1 },
    { exp: command().iat }, { exp: command().iat + 61 }, { prepared: 'e30=' }, { prepared: Buffer.from(' { }').toString('base64url') },
    { originalAction: 'A'.repeat(43692) }, { presence: 'p1.' + 'x'.repeat(4094) }, { presence: 'p1.é' },
  ]) refuses(() => encode({ ...command(), ...change }));
  let called = false;
  const getter = command(); Object.defineProperty(getter, 'prepared', { enumerable: true, get() { called = true; throw new Error('private'); } });
  refuses(() => encode(getter)); assert.equal(called, false);
  const symbol = command(); symbol[Symbol('selector')] = true; refuses(() => encode(symbol));
});

test('native response refuses mismatched identity, alternate signature encoding and noncanonical framing', () => {
  const c = command(), body = response(c), wanted = expected(c);
  for (const change of [{ requestId: '11111111-1111-4111-8111-111111111111' }, { brokerEnrollmentHeadDigest: '0'.repeat(64) },
    { signature: body.signature + '=' }, { signature: Buffer.alloc(63).toString('base64url') },
    { signature: Buffer.alloc(65).toString('base64url') }, { key: 'alternate' }, { v: 2 }])
    refuses(() => decode(canonical({ ...body, ...change }), wanted));
  refuses(() => decode(Buffer.concat([canonical(body), Buffer.from('\n')]), wanted));
  refuses(() => decode(Buffer.from('{"v":1,"v":1}'), wanted));
  refuses(() => decode(Buffer.alloc(1025), wanted));
  refuses(() => decode(canonical(body).toString(), wanted));
  const alias = body.signature.slice(0, -1) + String.fromCharCode(body.signature.charCodeAt(body.signature.length - 1) + 1);
  assert.deepEqual(Buffer.from(alias, 'base64url'), Buffer.from(body.signature, 'base64url'));
  refuses(() => decode(canonical({ ...body, signature: alias }), wanted));
});
