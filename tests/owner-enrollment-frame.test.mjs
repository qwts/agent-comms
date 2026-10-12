import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { encodeBrokerOwnerEnrollmentFrame as encode, decodeBrokerOwnerEnrollmentFrame as decode,
  BROKER_ENROLLMENT_SLOTS as slots } from '../lib/owner-enrollment-frame.mjs';
import { encodeOwnerJournalFrame } from '../lib/owner-decision-journal-frame.mjs';
const vectors = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions/broker-enrollment-v1.json', import.meta.url))).cases;
const bytes = name => Buffer.from(vectors.find(v => v.name === name).canonical);
const binding = kind => ({ kind, revision: 1, namespaceDigest: JSON.parse(bytes('enrollment')).namespaceDigest });
const refuse = fn => assert.throws(fn, { message: 'invalid-owner-enrollment-frame' });
const hash = value => createHash('sha256').update(value).digest();

test('enrollment frames bind exact canonical216 payloads and approved offsets without changing that codec', () => {
  for (const { kind, cap, id } of slots) {
    const value = bytes(kind === 'record' ? 'enrollment' : kind), b = binding(kind), frame = encode(value, b);
    assert.equal(frame.length, cap + 256); assert.equal(frame.subarray(0, 8).toString(), 'BOENFR01');
    assert.equal(frame[8], 1); assert.equal(frame[9], id); assert.equal(frame.readUInt16BE(10), 1);
    assert.equal(frame.readUInt32BE(12), value.length);
    assert.equal(frame.subarray(16, 48).toString('hex'), b.namespaceDigest);
    assert.deepEqual(frame.subarray(48, 80), hash(value));
    const suffix = Buffer.alloc(7); suffix.writeUInt16BE(1); suffix[2] = id; suffix.writeUInt32BE(cap, 3);
    const context = hash(Buffer.concat([Buffer.from('agent-comms-broker-owner-enrollment-frame-v1\n'),
      Buffer.from(b.namespaceDigest, 'hex'), suffix]));
    assert.deepEqual(frame.subarray(80, 112), context);
    assert.equal(frame.subarray(112, 128).every(b => b === 0), true);
    assert.equal(frame.subarray(128 + value.length, 128 + cap).every(b => b === 0), true);
    assert.deepEqual(frame.subarray(128 + cap + 16, 128 + cap + 48), hash(frame.subarray(0, 128 + cap)));
    const result = decode(frame, b); assert.equal(result.state, 'committed'); assert.deepEqual(result.payload, value);
    frame.fill(0); value.fill(0); assert.ok(result.payload.length > 0);
  }
});
test('only exact full zero slots are unused; every truncation and any single-bit mutation refuses', () => {
  for (const { kind, cap } of slots) {
    const b = binding(kind), frame = encode(bytes(kind === 'record' ? 'enrollment' : kind), b);
    assert.equal(decode(Buffer.alloc(cap + 256), b).state, 'empty');
    for (let length = 0; length < frame.length; length++) refuse(() => decode(frame.subarray(0, length), b));
    for (let offset = 0; offset < frame.length; offset++) {
      const changed = Buffer.from(frame); changed[offset] ^= 1; refuse(() => decode(changed, b));
    }
    refuse(() => decode(Buffer.concat([frame, Buffer.from([0])]), b));
    refuse(() => decode(Buffer.alloc(cap + 255), b));
  }
});
test('namespace revision kind/cap and broker-journal cross-domain substitutions refuse', () => {
  const frame = encode(bytes('enrollment'), binding('record'));
  for (const b of [{ ...binding('record'), namespaceDigest: 'f'.repeat(64) },
    { ...binding('record'), revision: 2 }, binding('audit'), binding('confirmation'),
    { ...binding('record'), revision: 0 }, { ...binding('record'), revision: 1025 }]) refuse(() => decode(frame, b));
  for (const kind of ['audit', 'confirmation']) refuse(() => encode(bytes('enrollment'), binding(kind)));
  const journal = encodeOwnerJournalFrame(bytes('enrollment'), { namespaceDigest: binding('record').namespaceDigest,
    requestId: '11111111-1111-4111-8111-111111111111', slot: 'acceptance' });
  refuse(() => decode(journal, binding('record')));
});
test('even recomputed integrity hashes cannot substitute malformed canonical payloads or typed contexts', () => {
  const b = binding('record'), frame = encode(bytes('enrollment'), b), value = JSON.parse(bytes('enrollment'));
  value.revision = 2;
  const changed = Buffer.from(frame), body = Buffer.from(JSON.stringify(value));
  body.copy(changed, 128); changed.writeUInt32BE(body.length, 12); changed.fill(0, 128 + body.length, 4224);
  hash(body).copy(changed, 48); changed.writeUInt32BE(body.length, 4236);
  hash(changed.subarray(0, 4224)).copy(changed, 4240); hash(body).copy(changed, 4304);
  refuse(() => decode(changed, b));
  refuse(() => encode(Buffer.from('{}'), b));
  refuse(() => encode(Buffer.alloc(4097), b));
});
