// Fixed immutable enrollment slots. Integrity/canonical structure only: no
// owner authority, native custody, allocation or physical flush assertion.
import { createHash } from 'node:crypto';
import { snapshotOwnerDecisionBytes } from './owner-decision-canonical.mjs';
import { decodeBrokerOwnerEnrollmentRecord } from './owner-enrollment-codec.mjs';
export const BROKER_ENROLLMENT_SLOTS = Object.freeze([
  ['record', 'records', 4096], ['audit', 'audits', 512], ['confirmation', 'confirmations', 512],
].map(([kind, directory, cap], i) => Object.freeze({ kind, directory, cap, id: i + 1 })));
const hash = bytes => createHash('sha256').update(bytes).digest();
const invalid = () => { throw new Error('invalid-owner-enrollment-frame'); };
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const zero = bytes => bytes.every(b => b === 0);
function context(options) {
  const { kind, revision, namespaceDigest } = options;
  const slot = BROKER_ENROLLMENT_SLOTS.find(s => s.kind === kind);
  if (!slot || !Number.isSafeInteger(revision) || revision < 1 || revision > 1024
      || !matches(/^[a-f0-9]{64}$/, namespaceDigest)) invalid();
  const suffix = Buffer.alloc(7); suffix.writeUInt16BE(revision); suffix[2] = slot.id; suffix.writeUInt32BE(slot.cap, 3);
  return { ...slot, revision, namespace: Buffer.from(namespaceDigest, 'hex'), namespaceDigest,
    digest: hash(Buffer.concat([Buffer.from('agent-comms-broker-owner-enrollment-frame-v1\n', 'ascii'),
      Buffer.from(namespaceDigest, 'hex'), suffix])) };
}
function payload(bytes, binding) {
  const decoded = decodeBrokerOwnerEnrollmentRecord(bytes), r = decoded.record;
  if (r.namespaceDigest !== binding.namespaceDigest || r.revision !== binding.revision
      || !(binding.kind === 'record' ? ['broker-owner-enrollment', 'broker-owner-revocation'].includes(r.kind)
        : r.kind === `broker-owner-${binding.kind}`)) invalid();
  return decoded;
}
export function encodeBrokerOwnerEnrollmentFrame(input, options) {
  try {
    const b = context(options), bytes = Buffer.from(snapshotOwnerDecisionBytes(input));
    if (bytes.length < 1 || bytes.length > b.cap) invalid();
    payload(bytes, b);
    const frame = Buffer.alloc(b.cap + 256), header = frame.subarray(0, 128);
    const body = frame.subarray(128, 128 + b.cap), trailer = frame.subarray(128 + b.cap);
    const digest = hash(bytes);
    header.write('BOENFR01', 0, 'ascii'); header[8] = 1; header[9] = b.id;
    header.writeUInt16BE(b.revision, 10); header.writeUInt32BE(bytes.length, 12);
    b.namespace.copy(header, 16); digest.copy(header, 48); b.digest.copy(header, 80); bytes.copy(body);
    trailer.write('BOENCM01', 0, 'ascii'); trailer[8] = 1; trailer[9] = b.id;
    trailer.writeUInt16BE(b.revision, 10); trailer.writeUInt32BE(bytes.length, 12);
    hash(frame.subarray(0, 128 + b.cap)).copy(trailer, 16);
    b.digest.copy(trailer, 48); digest.copy(trailer, 80);
    return frame;
  } catch { invalid(); }
}
export function decodeBrokerOwnerEnrollmentFrame(input, options) {
  try {
    const b = context(options), frame = Buffer.from(snapshotOwnerDecisionBytes(input));
    if (frame.length !== b.cap + 256) invalid();
    if (zero(frame)) return Object.freeze({ state: 'empty' });
    const header = frame.subarray(0, 128), body = frame.subarray(128, 128 + b.cap), trailer = frame.subarray(128 + b.cap);
    const length = header.readUInt32BE(12);
    if (!header.subarray(0, 8).equals(Buffer.from('BOENFR01', 'ascii')) || header[8] !== 1 || header[9] !== b.id
        || header.readUInt16BE(10) !== b.revision || length < 1 || length > b.cap
        || !header.subarray(16, 48).equals(b.namespace) || !header.subarray(80, 112).equals(b.digest)
        || !zero(header.subarray(112)) || !zero(body.subarray(length))) invalid();
    const bytes = body.subarray(0, length), digest = hash(bytes);
    if (!header.subarray(48, 80).equals(digest)
        || !trailer.subarray(0, 8).equals(Buffer.from('BOENCM01', 'ascii')) || trailer[8] !== 1 || trailer[9] !== b.id
        || trailer.readUInt16BE(10) !== b.revision || trailer.readUInt32BE(12) !== length
        || !trailer.subarray(16, 48).equals(hash(frame.subarray(0, 128 + b.cap)))
        || !trailer.subarray(48, 80).equals(b.digest) || !trailer.subarray(80, 112).equals(digest)
        || !zero(trailer.subarray(112))) invalid();
    const decoded = payload(bytes, b);
    return Object.freeze({ state: 'committed', payload: Buffer.from(bytes), record: decoded.record,
      payloadDigest: decoded.sha256, frameDigest: hash(frame).toString('hex') });
  } catch { invalid(); }
}
