import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { OWNER_JOURNAL_FIXED_SLOTS as slots, encodeOwnerJournalFrame as encode, decodeOwnerJournalFrame as decode,
  decodeOwnerJournalObservationHeader as structural } from '../lib/owner-decision-journal-frame.mjs';
const base = { namespaceDigest: 'a'.repeat(64), requestId: '11111111-1111-4111-8111-111111111111' };
const invalid = fn => assert.throws(fn, { message: 'invalid-owner-journal-frame' });
const hash = bytes => createHash('sha256').update(bytes).digest();

test('fixed frame independently matches all known binary offsets, context and hashes for every slot and boundary', () => {
  for (const { slot, cap, id } of slots) for (const length of [1, cap]) {
    const payload = Buffer.alloc(length, 0x7f), options = { ...base, slot }, frame = encode(payload, options);
    assert.equal(frame.length, cap + 256);
    assert.equal(frame.subarray(0, 8).toString(), 'ODJSLOT1');
    assert.equal(frame.readUInt16BE(8), 1); assert.equal(frame.readUInt16BE(10), id);
    assert.equal(frame.readUInt32BE(16), cap); assert.equal(frame.readUInt32BE(20), length);
    assert.equal(frame.readBigUInt64BE(24), 1n);
    const context = hash(Buffer.from(`{"namespaceDigest":"${base.namespaceDigest}","requestId":"${base.requestId}","role":"broker","slot":"${slot}","v":1}`));
    assert(frame.subarray(32, 64).equals(context)); assert(frame.subarray(64, 96).equals(hash(payload)));
    assert(frame.subarray(128, 128 + length).equals(payload)); assert(frame.subarray(128 + length, cap + 128).every(x => x === 0));
    const trailer = frame.subarray(cap + 128);
    assert.equal(trailer.subarray(0, 8).toString(), 'ODJCOM01'); assert.equal(trailer.readUInt16BE(10), id);
    assert.equal(trailer.readBigUInt64BE(16), 1n); assert.equal(trailer.readUInt32BE(24), length);
    assert(trailer.subarray(32, 64).equals(hash(Buffer.concat([Buffer.from('owner-journal-frame-v1\n'), frame.subarray(0, cap + 128)]))));
    assert(trailer.subarray(64, 96).equals(context));
    assert.deepEqual(decode(frame, options), { kind: 'committed', slot, payload, sha256: hash(frame).toString('hex'),
      ...(slot === 'observation-reference' ? { generation: 1 } : {}) });
    invalid(() => encode(Buffer.alloc(cap + 1), options));
  }
});
test('every bit-corrupted byte and every strict prefix refuses instead of selecting an older/empty state', () => {
  const options = { ...base, slot: 'acceptance' }, frame = encode(Buffer.from('test'), options);
  for (let offset = 0; offset < frame.length; offset++) for (let bit = 0; bit < 8; bit++) {
    const corrupt = Buffer.from(frame); corrupt[offset] ^= 1 << bit; invalid(() => decode(corrupt, options));
  }
  for (let length = 0; length < frame.length; length++) invalid(() => decode(frame.subarray(0, length), options));
  invalid(() => decode(Buffer.concat([frame, Buffer.from([0])]), options));
});
test('initialized zeros and complete body without trailer remain distinct noncommitted states', () => {
  for (const { slot, cap } of slots) {
    const options = { ...base, slot }, initialized = Buffer.alloc(cap + 256);
    assert.deepEqual(decode(initialized, options), { kind: 'empty', slot });
    const body = encode(Buffer.from('test'), options); body.fill(0, cap + 128);
    assert.deepEqual(decode(body, options), { kind: 'uncommitted', slot,
      ...(slot === 'observation-reference' ? { generation: 1 } : {}) });
    body[0] ^= 1; invalid(() => decode(body, options));
  }
});
test('cross request/namespace/slot, suffixes and coercions fail with fixed diagnostics', () => {
  const options = { ...base, slot: 'acceptance' }, frame = encode(Buffer.from('test'), options);
  for (const change of [{ requestId: '22222222-2222-4222-8222-222222222222' }, { namespaceDigest: 'b'.repeat(64) },
    { slot: 'receipt' }, { requestId: base.requestId + '\n' }, { namespaceDigest: base.namespaceDigest + '\n' },
    { slot: 'acceptance\n' }, { slot: 'unknown' }]) invalid(() => decode(frame, { ...options, ...change }));
  for (const bad of [null, {}, 'secret-canary', new DataView(new ArrayBuffer(10))]) {
    invalid(() => decode(bad, options)); invalid(() => encode(bad, options));
  }
  invalid(() => decode(frame, { get slot() { throw new Error('secret-canary'); } }));
  invalid(() => encode(new Uint8Array(0), options));
});
test('inputs and results are independent snapshots without calling overridden typed-array accessors', () => {
  class Bytes extends Uint8Array { get byteLength() { throw new Error('secret-canary'); } }
  const payload = new Bytes([1, 2, 3]), options = { ...base, slot: 'acceptance' }, frame = encode(payload, options);
  payload.fill(0); const result = decode(new Bytes(frame), options); assert.deepEqual(result.payload, Buffer.from([1, 2, 3]));
  frame.fill(0); assert.deepEqual(result.payload, Buffer.from([1, 2, 3]));
});

// Recompute all public hashes: integrity alone must not cross producer custody.
test('broker frames reject role-free and daemon-domain frames even with correct recomputed checksums', () => {
  for (const { slot, cap } of slots) {
    const options = { ...base, slot }, original = encode(Buffer.from('test'), options);
    for (const role of [null, 'daemon']) {
      const context = hash(Buffer.from(JSON.stringify(role === null
        ? { namespaceDigest: base.namespaceDigest, requestId: base.requestId, slot, v: 1 }
        : { namespaceDigest: base.namespaceDigest, requestId: base.requestId, role, slot, v: 1 })));
      const frame = Buffer.from(original);
      context.copy(frame, 32); context.copy(frame, cap + 128 + 64);
      hash(Buffer.concat([Buffer.from('owner-journal-frame-v1\n'), frame.subarray(0, cap + 128)])).copy(frame, cap + 128 + 32);
      invalid(() => decode(frame, options));
    }
    // Extra input cannot change the codec's fixed broker producer domain.
    assert(encode(Buffer.from('test'), { ...options, role: 'daemon' }).equals(original));
  }
});
test('only broker observation supports bounded generations; header hints never prove committed content', () => {
  const options = { ...base, slot: 'observation-reference' };
  for (const generation of [1, 2, Number.MAX_SAFE_INTEGER]) {
    const frame = encode(Buffer.from('test'), { ...options, generation });
    assert.equal(decode(frame, options).generation, generation);
    assert.deepEqual(structural(frame, base), { length: 4, generation });
    const body = Buffer.from(frame); body.fill(0, 2176);
    assert.equal(decode(body, options).generation, generation); assert.equal(decode(body, options).kind, 'uncommitted');
    body[128] ^= 1; invalid(() => decode(body, options));
    assert.equal(structural(body, base).generation, generation);
  }
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '2', 2n]) invalid(() => encode(Buffer.from('test'), { ...options, generation }));
  for (const { slot } of slots.filter(row => row.slot !== options.slot)) invalid(() => encode(Buffer.from('test'), { ...base, slot, generation: 2 }));
  for (const value of [0n, 9007199254740992n, 18446744073709551615n]) for (const offset of [24, 2192]) {
    const frame = encode(Buffer.from('test'), options); frame.writeBigUInt64BE(value, offset);
    // Even correctly recomputed public checksum cannot authorize a bad sequence.
    hash(Buffer.concat([Buffer.from('owner-journal-frame-v1\n'), frame.subarray(0, 2176)])).copy(frame, 2208);
    invalid(() => decode(frame, options));
    if (offset === 24) { frame.fill(0, 2176); invalid(() => decode(frame, options)); invalid(() => structural(frame, base)); }
  }
  const mismatch = encode(Buffer.from('test'), options); mismatch.writeBigUInt64BE(2n, 2192); invalid(() => decode(mismatch, options));
  const wrongContext = encode(Buffer.from('test'), options); wrongContext[32] ^= 1; invalid(() => structural(wrongContext, base));
});
