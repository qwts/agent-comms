import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { deriveOwnerDecisionBrokerNamespace as derive } from '../lib/owner-decision-namespace.mjs';
const source = readFileSync(new URL('./fixtures/owner-decisions/broker-namespace-v1.json', import.meta.url));
const vectors = JSON.parse(source);
test('independent synthetic namespace vectors reproduce exact raw-byte domain derivation', () => {
  assert.equal(createHash('sha256').update(source).digest('hex'), '559aff92b9dfe47a252d684a019a6b3928bc397c9e911607540289ad1ecac179');
  assert.equal(vectors.domainAscii, 'agent-comms-owner-broker-namespace-v1\n');
  for (const v of vectors.vectors) {
    const id = Buffer.from(v.namespaceIdHex, 'hex'); assert.equal(id.toString('base64url'), v.namespaceIdBase64url);
    assert.equal(derive(id), v.namespaceDigest); assert.equal(derive(new Uint8Array(id)), v.namespaceDigest);
    const padded = Buffer.concat([Buffer.from([255]), id, Buffer.from([255])]); assert.equal(derive(padded.subarray(1, 33)), v.namespaceDigest);
    for (const alternative of [id.toString('hex'), id.toString('base64url')])
      assert.notEqual(createHash('sha256').update(vectors.domainAscii).update(alternative).digest('hex'), v.namespaceDigest);
  }
});
test('namespace helper refuses alternate input types/lengths with a fixed error and no bootstrap side effects', () => {
  for (const id of [null, undefined, 'a'.repeat(32), Array(32).fill(0), new ArrayBuffer(32), new DataView(new ArrayBuffer(32)),
    new Uint8Array(0), new Uint8Array(31), new Uint8Array(33), new Uint8Array(32769)])
    assert.throws(() => derive(id), { message: 'invalid-owner-broker-namespace' });
  class Untrusted extends Uint8Array { get byteLength() { throw new Error('secret-canary'); } }
  assert.equal(derive(new Untrusted(32)), vectors.vectors[1].namespaceDigest);
  const buffer = Buffer.from(vectors.vectors[0].namespaceIdHex, 'hex'), first = derive(buffer); buffer.fill(0);
  assert.equal(first, vectors.vectors[0].namespaceDigest); assert.equal(derive(buffer), vectors.vectors[1].namespaceDigest);
});
