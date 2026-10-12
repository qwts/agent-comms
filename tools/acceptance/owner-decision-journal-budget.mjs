// Proposed storage specification consistency only. This does not import or test
// a production parser, journal, filesystem allocator, authority or recovery path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(new URL('../../tests/fixtures/owner-decisions/journal-budget-v1.json', import.meta.url)));
const canonical = v => v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(canonical)}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const exact = (v, names) => assert.deepEqual(Object.keys(v).sort(), names.split(' ').sort());
const match = (v, re) => assert.equal(typeof v === 'string' && re.exec(v)?.[0] === v, true);
const hash = v => match(v, /^[a-f0-9]{64}$/);
const uuid = v => match(v, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const number = v => assert(Number.isSafeInteger(v) && v >= 0);
const epoch = v => { number(v); assert(v > 0); };
const nullable = (v, check) => { if (v !== null) check(v); };
const operations = ['cold-wake.set', 'revision.adopt', 'revision.approve', 'revision.edit', 'revision.reject'];
const codes = { applied: ['applied'], refused: ['validation-refused', 'authority-refused', 'deadline-expired'], cancelled: ['cancelled'], expired: ['deadline-expired'], indeterminate: ['effect-uncertain'] };
function inspect(r) {
  assert.equal(r.v, 1); uuid(r.requestId); hash(r.payloadDigest);
  if (r.kind === 'acceptance') {
    exact(r, 'v kind requestId principal account soul operation payloadDigest namespaceDigest acceptedAt daemonKey daemonEpoch watchId reservationBytes');
    match(r.principal, /^principal_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    match(r.soul, /^agent_[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    match(r.account, /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/);
    assert(operations.includes(r.operation)); hash(r.namespaceDigest); number(r.acceptedAt);
    hash(r.daemonKey); epoch(r.daemonEpoch); uuid(r.watchId);
    assert([262144, 524288].includes(r.reservationBytes));
  } else if (r.kind === 'authorization') {
    exact(r, 'v kind requestId payloadDigest nonce actionDigest challengeDigest presenceDigest receiptDigest exp daemonKey daemonEpoch watchId');
    match(r.nonce, /^[A-Za-z0-9_-]{43}$/);
    const nonce = Buffer.from(r.nonce, 'base64url'); assert.equal(nonce.length, 32); assert.equal(nonce.toString('base64url'), r.nonce);
    for (const k of ['actionDigest', 'challengeDigest', 'presenceDigest', 'receiptDigest', 'daemonKey']) hash(r[k]);
    number(r.exp); epoch(r.daemonEpoch); uuid(r.watchId);
  } else if (r.kind === 'outcome') {
    exact(r, 'v kind requestId payloadDigest state receiptDigest outcome source reportingDaemonKey reportingDaemonEpoch at');
    assert(Object.hasOwn(codes, r.state)); nullable(r.receiptDigest, hash); exact(r.outcome, 'code effectDigest');
    assert(codes[r.state].includes(r.outcome.code)); nullable(r.outcome.effectDigest, hash); number(r.at);
    assert(['broker', 'daemon'].includes(r.source));
    if (r.source === 'broker') {
      assert.equal(r.reportingDaemonKey, null); assert.equal(r.reportingDaemonEpoch, null);
      assert.notEqual(r.state, 'applied'); assert.equal(r.outcome.effectDigest, null);
    } else { hash(r.reportingDaemonKey); epoch(r.reportingDaemonEpoch); }
    if (r.state === 'applied') assert.notEqual(r.outcome.effectDigest, null);
  } else {
    assert.equal(r.kind, 'reconciliation-reference');
    exact(r, 'v kind requestId payloadDigest originalDaemonKey originalDaemonEpoch reportingDaemonKey reportingDaemonEpoch at finding auditId evidenceDigest');
    for (const k of ['originalDaemonKey', 'reportingDaemonKey', 'evidenceDigest']) hash(r[k]);
    epoch(r.originalDaemonEpoch); epoch(r.reportingDaemonEpoch); number(r.at); uuid(r.auditId);
    assert(['applied', 'refused', 'indeterminate'].includes(r.finding));
  }
}
assert.equal(data.version, 1);
assert.deepEqual(data.limits, { acceptedIds: 4096, framingBytes: 256, scratchPayloadBytes: 32768, namedFileEntries: 24, namedDirectories: 8, entryCharge: 4096, componentBytes: 64, globalReservationBytes: 1048576, globalNamedFileEntries: 16, globalNamedDirectories: 8, globalPayloadBytes: 131072 });
// These independently specified tables must agree with the checked-in fixtures.
const slots = {
  broker: [['acceptance',4096],['original-action',32768],['prepared-challenge',32768],['presence',4096],['receipt',4096],['authorization',4096],['release',4096],['initial-outcome',4096],['observation-reference',2048],['terminal-reference',2048]],
  daemon: [['acceptance-context',4096],['original-action',32768],['prepared-challenge',32768],['presence',4096],['receipt',4096],['preparation',4096],['successful-check',4096],['pre-effect-refused',4096],['entered',4096],['completed',4096],['observation-reconciliation',2048],['terminal-reconciliation',2048],['observation-preimage',2048],['resolution-preimage',2048],['linked-authoritative-event',16384],['local-lifecycle-outcome',4096]],
};
const l = data.limits;
for (const [name, pairs] of Object.entries(slots)) {
  const s = data.stores[name]; assert.deepEqual(s.slots, pairs.map(([name, payloadCap]) => ({ name, payloadCap })));
  assert.equal(s.reservationBytes, name === 'broker' ? 262144 : 524288);
  const payloadBytes = pairs.reduce((n, [, cap]) => n + cap, 0);
  const slotFramingBytes = pairs.length * l.framingBytes;
  const scratchBytes = l.scratchPayloadBytes + l.framingBytes;
  // Count names, even when two entries hard-link one inode.
  const metadataBytes = (l.namedFileEntries + l.namedDirectories) * l.entryCharge;
  const requiredBytes = payloadBytes + slotFramingBytes + scratchBytes + metadataBytes;
  const globalRequiredBytes = l.globalPayloadBytes + l.globalNamedFileEntries * l.framingBytes + (l.globalNamedFileEntries + l.globalNamedDirectories) * l.entryCharge;
  const installationRequestBytes = l.acceptedIds * s.reservationBytes;
  assert.deepEqual(s.expected, { payloadBytes, slotFramingBytes, scratchBytes, metadataBytes, requiredBytes, installationRequestBytes, globalRequiredBytes, installationReservedBytes: installationRequestBytes + l.globalReservationBytes });
  assert(requiredBytes <= s.reservationBytes); assert(globalRequiredBytes <= l.globalReservationBytes);
}
const ids = new Set(); const maximum = {}; const covered = new Set();
for (const v of data.administrativeRecords) {
  assert(!ids.has(v.id)); ids.add(v.id); inspect(v.record); covered.add(v.record.kind);
  const text = canonical(v.record); assert.equal(text, v.canonicalJson);
  assert.equal(createHash('sha256').update(text).digest('hex'), v.sha256);
  assert.equal(Buffer.byteLength(text), v.utf8Bytes);
  assert.equal(v.slot, v.record.kind); assert.equal(v.cap, v.record.kind === 'reconciliation-reference' ? 2048 : 4096);
  assert(v.utf8Bytes <= v.cap); maximum[v.record.kind] = Math.max(maximum[v.record.kind] ?? 0, v.utf8Bytes);
}
assert.deepEqual([...covered].sort(), ['acceptance', 'authorization', 'outcome', 'reconciliation-reference']);
assert.equal(data.administrativeRecords.find(v => v.id === 'acceptance-broker').record.reservationBytes, 262144);
assert.equal(data.administrativeRecords.find(v => v.id === 'acceptance-daemon').record.reservationBytes, 524288);
for (const [state, values] of Object.entries(codes)) for (const code of values) assert(data.administrativeRecords.some(v => v.record.state === state && v.record.outcome.code === code));
for (const finding of ['applied', 'refused', 'indeterminate']) assert(data.administrativeRecords.some(v => v.record.finding === finding));
assert.deepEqual(maximum, { acceptance: 682, authorization: 734, outcome: 553, 'reconciliation-reference': 610 });
console.log(JSON.stringify({ specificationOnly: true, stores: Object.fromEntries(Object.entries(data.stores).map(([k, v]) => [k, v.expected])), administrativeRecords: ids.size, maximum }, null, 2));
