// Disabled fixed-slot storage integrity only. Payload schema/current authority
// are separate; the admission core supplies its existing strict typed validator.
// The producer role is fixed here, never selected by a request or codec option.
import { createHash } from 'node:crypto';
export const OWNER_JOURNAL_FIXED_SLOTS = Object.freeze([
  ['acceptance', 4096], ['original-action', 32768], ['prepared-challenge', 32768],
  ['presence', 4096], ['receipt', 4096], ['authorization', 4096], ['release', 4096],
  ['initial-outcome', 4096], ['observation-reference', 2048], ['terminal-reference', 2048],
].map(([slot, cap], index) => Object.freeze({ slot, cap, id: index + 1 })));
const hash = bytes => createHash('sha256').update(bytes).digest();
const fail = () => { throw new Error('invalid-owner-journal-frame'); };
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const uuid4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const setBytes = Uint8Array.prototype.set;
const zeros = bytes => bytes.every(byte => byte === 0);
const maximum = BigInt(Number.MAX_SAFE_INTEGER);
function generation(value, slot) {
  if (typeof value !== 'bigint' || value < 1n || value > maximum
      || (slot !== 'observation-reference' && value !== 1n)) fail();
  return Number(value);
}
function snapshot(bytes, max) {
  if (!(bytes instanceof Uint8Array)) fail();
  const length = byteLength.call(bytes);
  if (length < 1 || length > max) fail();
  const copy = Buffer.alloc(length); setBytes.call(copy, bytes); return copy;
}
function binding(options) {
  const { slot, requestId, namespaceDigest } = options;
  const descriptor = OWNER_JOURNAL_FIXED_SLOTS.find(entry => entry.slot === slot);
  if (!descriptor || !matches(uuid4, requestId) || !matches(digest, namespaceDigest)) fail();
  return { ...descriptor, context: hash(Buffer.from(JSON.stringify({ namespaceDigest, requestId, role: 'broker', slot, v: 1 }))) };
}
function frameHash(header, payloadRegion) {
  return hash(Buffer.concat([Buffer.from('owner-journal-frame-v1\n'), header, payloadRegion]));
}
function headerFields(header, b) {
  const length = header.readUInt32BE(20), sequence = generation(header.readBigUInt64BE(24), b.slot);
  if (!header.subarray(0, 8).equals(Buffer.from('ODJSLOT1', 'ascii')) || header.readUInt16BE(8) !== 1
    || header.readUInt16BE(10) !== b.id || header.readUInt32BE(12) !== 0
    || header.readUInt32BE(16) !== b.cap || length < 1 || length > b.cap
    || !header.subarray(32, 64).equals(b.context) || !zeros(header.subarray(96))) fail();
  return { length, generation: sequence };
}
// Structural hint only: neither payload integrity nor commitment is established.
// Destination binding is fixed, even when inspecting an interrupted frame.
export function decodeOwnerJournalObservationHeader(frameBytes, options) {
  try {
    const b = binding({ ...options, slot: 'observation-reference' });
    const bytes = snapshot(frameBytes, b.cap + 256);
    if (bytes.length !== b.cap + 256) fail();
    return headerFields(bytes.subarray(0, 128), b);
  } catch { fail(); }
}

export function encodeOwnerJournalFrame(payloadBytes, options) {
  try {
    const b = binding(options); const payload = snapshot(payloadBytes, b.cap);
    const selected = options.generation === undefined ? 1 : options.generation;
    if (!Number.isSafeInteger(selected)) fail();
    const sequence = BigInt(generation(BigInt(selected), b.slot));
    const bytes = Buffer.alloc(b.cap + 256), header = bytes.subarray(0, 128);
    const body = bytes.subarray(128, 128 + b.cap), trailer = bytes.subarray(128 + b.cap);
    header.write('ODJSLOT1', 0, 'ascii'); header.writeUInt16BE(1, 8); header.writeUInt16BE(b.id, 10);
    header.writeUInt32BE(b.cap, 16); header.writeUInt32BE(payload.length, 20); header.writeBigUInt64BE(sequence, 24);
    b.context.copy(header, 32); hash(payload).copy(header, 64); payload.copy(body);
    trailer.write('ODJCOM01', 0, 'ascii'); trailer.writeUInt16BE(1, 8); trailer.writeUInt16BE(b.id, 10);
    trailer.writeBigUInt64BE(sequence, 16); trailer.writeUInt32BE(payload.length, 24);
    frameHash(header, body).copy(trailer, 32); b.context.copy(trailer, 64);
    return bytes;
  } catch { fail(); }
}

export function decodeOwnerJournalFrame(frameBytes, options) {
  try {
    const b = binding(options); const bytes = snapshot(frameBytes, b.cap + 256);
    if (bytes.length !== b.cap + 256) fail();
    if (zeros(bytes)) return { kind: 'empty', slot: b.slot };
    const header = bytes.subarray(0, 128), body = bytes.subarray(128, 128 + b.cap);
    const trailer = bytes.subarray(128 + b.cap), parsed = headerFields(header, b), { length } = parsed;
    const extra = b.slot === 'observation-reference' ? { generation: parsed.generation } : {};
    if (!zeros(body.subarray(length))
      || !header.subarray(64, 96).equals(hash(body.subarray(0, length)))) fail();
    if (zeros(trailer)) return { kind: 'uncommitted', slot: b.slot, ...extra };
    const trailerGeneration = generation(trailer.readBigUInt64BE(16), b.slot);
    if (!trailer.subarray(0, 8).equals(Buffer.from('ODJCOM01', 'ascii')) || trailer.readUInt16BE(8) !== 1
      || trailer.readUInt16BE(10) !== b.id || trailer.readUInt32BE(12) !== 0
      || trailerGeneration !== parsed.generation || trailer.readUInt32BE(24) !== length
      || trailer.readUInt32BE(28) !== 0 || !zeros(trailer.subarray(96))
      || !trailer.subarray(64, 96).equals(b.context)
      || !trailer.subarray(32, 64).equals(frameHash(header, body))) fail();
    return { kind: 'committed', slot: b.slot, payload: Buffer.from(body.subarray(0, length)), sha256: hash(bytes).toString('hex'), ...extra };
  } catch { fail(); }
}
