// Test-only frozen cross-producer vectors. This does not ship a daemon codec.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OWNER_JOURNAL_FIXED_SLOTS, encodeOwnerJournalFrame, decodeOwnerJournalFrame } from '../../lib/owner-decision-journal-frame.mjs';

const FIXTURE = new URL('../../tests/fixtures/owner-decisions/fixed-frames-v1/vectors.json', import.meta.url);
const FIXTURE_SHA256 = '9c9e9812291b876dd74fca43680393c2def510c0bc953a949dc1ca028f4d80ba';
const DAEMON_SLOTS = [
  ['acceptance-context', 4096], ['original-action', 32768], ['prepared-challenge', 32768],
  ['presence', 4096], ['receipt', 4096], ['preparation', 4096], ['successful-check', 4096],
  ['pre-effect-refused', 4096], ['entered', 4096], ['completed', 4096],
  ['observation-pair', 4352], ['terminal-pair', 4352], ['linked-authoritative-event', 16384],
  ['local-lifecycle-outcome', 4096],
].map(([slot, cap], i) => ({ slot, cap, id: i + 1 }));
const sha = bytes => createHash('sha256').update(bytes).digest();

export function checkOwnerDecisionFrameVectors() {
  const bytes = readFileSync(FIXTURE);
  assert.equal(bytes.length, 51213);
  assert.equal(sha(bytes).toString('hex'), FIXTURE_SHA256);
  const fixture = JSON.parse(bytes);
  assert.equal(fixture.version, 1);
  assert.equal(fixture.contractCommit, '6b90f825b5651a50718046379e5adbea193cbabf');
  assert.equal(fixture.vectors.length, 48);
  const expectedIds = new Set();
  for (const [role, slots] of [['broker', OWNER_JOURNAL_FIXED_SLOTS], ['daemon', DAEMON_SLOTS]]) {
    for (const { slot } of slots) for (const kind of ['one-byte', 'maximum']) expectedIds.add(`${role}:${slot}:${kind}`);
  }
  let brokerPositive = 0, brokerRejectedDaemon = 0, allFrameHashes = 0;
  for (const v of fixture.vectors) {
    assert.ok(expectedIds.delete(v.id), `unexpected or duplicate vector ${v.id}`);
    const descriptor = (v.role === 'broker' ? OWNER_JOURNAL_FIXED_SLOTS : DAEMON_SLOTS).find(s => s.slot === v.slot);
    assert.ok(descriptor); assert.equal(v.slotId, descriptor.id); assert.equal(v.payloadCap, descriptor.cap);
    const maximum = v.id.endsWith(':maximum');
    assert.equal(v.payload.count, maximum ? descriptor.cap : 1);
    assert.equal(v.payload.repeatByte, maximum ? 97 : 48);
    const payload = Buffer.alloc(v.payload.count, v.payload.repeatByte);
    const header = Buffer.from(v.headerHex, 'hex'), trailer = Buffer.from(v.trailerHex, 'hex');
    assert.equal(header.length, 128); assert.equal(trailer.length, 128);
    const padded = Buffer.alloc(descriptor.cap); payload.copy(padded);
    const frame = Buffer.concat([header, padded, trailer]);
    assert.equal(frame.length, v.frameBytes); assert.equal(frame.length, descriptor.cap + 256);
    assert.equal(sha(frame).toString('hex'), v.frameSha256); allFrameHashes++;
    const context = sha(Buffer.from(JSON.stringify({ namespaceDigest: v.namespaceDigest, requestId: v.requestId,
      role: v.role, slot: v.slot, v: 1 })));
    assert.deepEqual(header.subarray(32, 64), context); assert.deepEqual(trailer.subarray(64, 96), context);
    assert.deepEqual(header.subarray(64, 96), sha(payload));
    assert.deepEqual(trailer.subarray(32, 64), sha(Buffer.concat([Buffer.from('owner-journal-frame-v1\n'), header, padded])));
    const options = { slot: v.slot, requestId: v.requestId, namespaceDigest: v.namespaceDigest };
    if (v.role === 'broker') {
      assert.deepEqual(encodeOwnerJournalFrame(payload, options), frame);
      assert.deepEqual(decodeOwnerJournalFrame(frame, options), { kind: 'committed', slot: v.slot,
        payload, sha256: v.frameSha256 }); brokerPositive++;
    } else {
      // Every broker slot is tried: shared names/IDs/caps cannot cross roles.
      for (const { slot } of OWNER_JOURNAL_FIXED_SLOTS) {
        assert.throws(() => decodeOwnerJournalFrame(frame, { ...options, slot }), { message: 'invalid-owner-journal-frame' });
        brokerRejectedDaemon++;
      }
    }
  }
  assert.equal(expectedIds.size, 0);
  return { vectors: 48, brokerPositive, brokerRejectedDaemon, allFrameHashes, fixtureSha256: FIXTURE_SHA256 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(checkOwnerDecisionFrameVectors()));
