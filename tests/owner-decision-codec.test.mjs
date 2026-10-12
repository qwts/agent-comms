import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import { decodeOwnerDecisionAction as action, verifySignedOwnerDecisionReceipt as receipt } from '../lib/owner-decision-codec.mjs';

const f = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions/v1.json', import.meta.url)));
const publicKey = createPublicKey({ key: Buffer.from(f.keys.brokerSpkiBase64, 'base64'), type: 'spki', format: 'der' });
const canonical = v => v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(canonical)}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const bytes = value => Buffer.from(canonical(value));
const reject = run => assert.throws(run, { message: 'invalid-owner-decision' });
const keyPair = generateKeyPairSync('ed25519');
const keyId = createHash('sha256').update(keyPair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
function signed(overrides = {}, encoded) {
  const payload = { ...f.positive[0].receiptPayload, brokerKey: keyId, ...overrides };
  const segment = (encoded ?? bytes(payload)).toString('base64url');
  return `d1.${segment}.${sign(null, Buffer.from(segment), keyPair.privateKey).toString('base64url')}`;
}
const verify = (token, now = 2000000000000) => receipt(token, { brokerPublicKey: keyPair.publicKey, nowMilliseconds: now });

test('all shared actions reproduce exact digest, summary and native action text', () => {
  for (const vector of f.positive) {
    const result = action(Buffer.from(vector.actionJson));
    assert.equal(result.payloadDigest, vector.payloadDigest, vector.id);
    assert.equal(result.summary, vector.summary, vector.id);
    assert.equal(result.actionText, vector.actionText, vector.id);
  }
  for (const vector of f.negativeActionBytes) reject(() => action(Buffer.from(vector.bytesBase64url, 'base64url')));
  for (const vector of f.displayBoundaries) {
    if (vector.expectedPreparation === 'refuse-display') reject(() => action(Buffer.from(vector.actionJson)));
    else assert.equal(action(Buffer.from(vector.actionJson)).actionText, vector.actionText);
  }
});

test('action exact fields, operation-specific types and identity grammar refuse ambiguity', () => {
  const baseline = JSON.parse(f.positive[0].actionJson);
  for (const change of [
    { v: 2 }, { extra: true }, { operation: 'unknown' }, { requestId: baseline.requestId + '\n' },
    { principal: baseline.principal.toUpperCase() }, { account: 'a/b' },
    { soul: baseline.soul.replace('-4000-', '-0000-') },
    { parameters: { ...baseline.parameters, reason: ' \t ' } },
    { parameters: { ...baseline.parameters, reason: 'bad\nreason' } },
    { parameters: { ...baseline.parameters, reason: 'x'.repeat(501) } },
    { parameters: { ...baseline.parameters, apply: false } },
    { parameters: { ...baseline.parameters, expectedRevision: null } },
  ]) reject(() => action(bytes({ ...baseline, ...change })));
  for (const field of Object.keys(baseline)) {
    const altered = { ...baseline }; delete altered[field];
    reject(() => action(bytes(altered)));
  }
  for (const version of ['1', '8']) {
    action(bytes({ ...baseline, soul: baseline.soul.replace('-4000-', `-${version}000-`) }));
  }
  action(bytes({ ...baseline, principal: 'principal_00000000-0000-0000-0000-000000000000' }));
});

test('webhook host grammar is canonical including IPv6, without accepting extra URL components', () => {
  const baseline = JSON.parse(f.positive.find(v => JSON.parse(v.actionJson).parameters.mode === 'webhook').actionJson);
  for (const host of ['example.test', 'example.test:8443', '[::1]', '[::1]:8443']) {
    action(bytes({ ...baseline, parameters: { ...baseline.parameters, host } }));
  }
  for (const host of ['', 'EXAMPLE.test', 'example.test:443', 'example.test:08443', 'u@example.test', 'example.test/path',
    'example.test?x', 'example.test#x', '[0:0:0:0:0:0:0:1]', 'é.test', 'example.test\n']) {
    reject(() => action(bytes({ ...baseline, parameters: { ...baseline.parameters, host } })));
  }
});

test('shared receipt signatures and whole-token digests validate using an external enrolled key', () => {
  for (const vector of f.positive) {
    const result = receipt(vector.receiptToken, { brokerPublicKey: publicKey, nowMilliseconds: vector.receiptPayload.iat * 1000 });
    assert.deepEqual(result.payload, vector.receiptPayload);
    assert.equal(result.receiptDigest, vector.receiptDigest);
  }
  reject(() => verify(f.positive[0].receiptToken));
  reject(() => receipt(signed(), { brokerPublicKey: keyPair.privateKey, nowMilliseconds: 2000000000000 }));
  reject(() => receipt(signed(), null));
  for (const field of ['brokerPublicKey', 'nowMilliseconds']) {
    const options = { brokerPublicKey: keyPair.publicKey, nowMilliseconds: 2000000000000 };
    Object.defineProperty(options, field, { get() { throw new Error('options-secret-canary'); } });
    reject(() => receipt(signed(), options));
  }
});

test('signed invalid receipt schemas, audience, encoding and token boundaries refuse', () => {
  for (const change of [ { v: 2 }, { aud: 'other' }, { unknown: true }, { brokerKey: '0'.repeat(64) },
    { payloadDigest: 'A'.repeat(64) }, { presenceKey: '0'.repeat(64) + '\n' }, { nonce: 'A'.repeat(42) },
    { nonce: 'A'.repeat(42) + 'B' }, { requestId: f.positive[0].receiptPayload.requestId + '\n' },
    { operation: 'unknown' }, { iat: -1 }, { exp: 1.5 } ]) reject(() => verify(signed(change)));
  const token = signed();
  for (const bad of [token + '=', token + '.extra', token.replace('d1.', 'p1.'), 'x'.repeat(4097), token.slice(0, -5),
    token.replace(/.$/, token.endsWith('A') ? 'B' : 'A')]) reject(() => verify(bad));
  reject(() => verify(signed({}, Buffer.from(' ' + canonical({ ...f.positive[0].receiptPayload, brokerKey: keyId })))));
  const parts = token.split('.');
  reject(() => verify(`${parts[0]}.${parts[1]}=.${parts[2]}`));
});

test('receipt clock equality, millisecond flooring and lifetime limits are strict', () => {
  verify(signed({ iat: 2000000030, exp: 2000000060 }));
  reject(() => verify(signed({ iat: 2000000031, exp: 2000000060 })));
  verify(signed({ iat: 2000000000, exp: 2000000060 }), 2000000059999);
  reject(() => verify(signed({ iat: 2000000000, exp: 2000000060 }), 2000000060000));
  reject(() => verify(signed({ exp: 2000000000 })));
  reject(() => verify(signed({ exp: 2000000061 })));
  for (const now of [-1, NaN, Infinity, 1.5, '2000000000000']) reject(() => verify(signed(), now));
});


test('action digest stays bound to its private snapshot during concurrent source writes', { timeout: 5000 }, async (t) => {
  const original = Buffer.from(f.positive[0].actionJson);
  const shared = new SharedArrayBuffer(original.length);
  const input = new Uint8Array(shared);
  input.set(original);
  const offset = original.indexOf('Reviewed');
  assert.notEqual(offset, -1);
  // Change only printable reason bytes, so every captured document remains
  // valid. The oracle hashes the returned action, not a second live-source read.
  const workerSource = `
    import { parentPort, workerData } from 'node:worker_threads';
    const bytes = new Uint8Array(workerData.shared);
    parentPort.postMessage('ready');
    for (;;) {
      for (let value = 65; value <= 90; value++) {
        bytes.fill(value, workerData.offset, workerData.offset + 8);
      }
    }
  `;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(workerSource)), {
    execArgv: [], workerData: { shared, offset },
  });
  try {
    await once(worker, 'message', { signal: t.signal });
    for (let attempt = 0; attempt < 2000; attempt++) {
      const result = action(input);
      const expected = createHash('sha256').update(canonical(result.action)).digest('hex');
      assert.equal(result.payloadDigest, expected, `snapshot digest at attempt ${attempt}`);
    }
  } finally {
    await worker.terminate();
  }
});
