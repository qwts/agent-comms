import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeBrokerOwnerEnrollmentRecord as decode, validateBrokerOwnerEnrollmentChain as chain } from '../lib/owner-enrollment-codec.mjs';
const vectors = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions/broker-enrollment-v1.json', import.meta.url)));
const fixture = name => Buffer.from(vectors.cases.find(v => v.name === name).canonical);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = v => v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const bytes = v => Buffer.from(canonical(v));
const triple = record => {
  const r = JSON.parse(record), recordDigest = hash(record);
  const audit = bytes({ v: 1, kind: 'broker-owner-audit', namespaceDigest: r.namespaceDigest, revision: r.revision,
    recordDigest, transactionId: r.transactionId, decisionEvidenceDigest: r.decisionEvidenceDigest });
  return { record, audit, confirmation: bytes({ v: 1, kind: 'broker-owner-confirmation', namespaceDigest: r.namespaceDigest,
    revision: r.revision, recordDigest, auditDigest: hash(audit) }) };
};
const refuse = fn => assert.throws(fn, { message: 'invalid-owner-enrollment-record' });

test('independently checked public vectors retain exact bytes and digests without authority', () => {
  for (const v of vectors.cases) {
    const input = Buffer.from(v.canonical), result = decode(input);
    assert.equal(input.length, v.bytes); assert.equal(result.sha256, v.sha256);
    assert.ok(Object.isFrozen(result.record));
  }
  const enrolled = chain([triple(fixture('enrollment'))]);
  assert.equal(enrolled.state, 'active'); assert.equal(enrolled.brokerLocalRevision, 1);
  assert.equal(enrolled.authorizationSupported, false); assert.equal(enrolled.custodyVerified, false);
  assert.equal(enrolled.durabilityVerified, false);
  const revoked = chain([triple(fixture('enrollment')), triple(fixture('revocation'))]);
  assert.equal(revoked.state, 'revoked'); assert.equal(revoked.activeRecord, null);
});

test('canonical, schema, key and finite-revision violations refuse without source text', () => {
  for (const input of [Buffer.concat([fixture('enrollment'), Buffer.from('\n')]), Buffer.alloc(4097, 32),
    Buffer.from('{"v":1,"v":1}'), Buffer.from([0xff]), Buffer.from('null')]) refuse(() => decode(input));
  for (const change of [r => { r.extra = 'CANARY'; }, r => { r.revision = 1024; }, r => { r.service.brokerUid = 0; },
    r => { r.service.brokerUid = 0x100000000; }, r => { r.receiptKey.keyId = 'a'.repeat(64); },
    r => { r.receiptKey.publicKey += '='; }, r => { r.presenceKey = r.receiptKey; },
    r => { r.previousDigest = 'a'.repeat(64); }, r => { r.transactionId += '\n'; }]) {
    const r = JSON.parse(fixture('enrollment')); change(r); refuse(() => decode(bytes(r)));
  }
});

test('complete triples bind audit, confirmation, namespace, service and exact revoked enrollment', () => {
  const first = triple(fixture('enrollment')), second = triple(fixture('revocation'));
  for (const field of ['record', 'audit', 'confirmation']) {
    const changed = { ...first }; delete changed[field]; refuse(() => chain([changed]));
  }
  for (const change of [r => { r.enrollmentDigest = 'c'.repeat(64); }, r => { r.previousDigest = 'c'.repeat(64); },
    r => { r.namespaceDigest = 'c'.repeat(64); }, r => { r.service.brokerUid++; },
    r => { r.transactionId = JSON.parse(first.record).transactionId; }]) {
    const r = JSON.parse(second.record); change(r); refuse(() => chain([first, triple(bytes(r))]));
  }
  const audit = JSON.parse(first.audit); audit.decisionEvidenceDigest = 'c'.repeat(64);
  refuse(() => chain([{ ...first, audit: bytes(audit) }]));
  refuse(() => chain([second])); refuse(() => chain([first, first])); refuse(() => chain([]));
  refuse(() => chain(Array(1025).fill(first)));
});

test('last enrollment can always be followed by terminal revocation without namespace or sequence reset', () => {
  const entries = [], enrolled = JSON.parse(fixture('enrollment')), revoked = JSON.parse(fixture('revocation'));
  let previous = null, activeDigest = null;
  for (let revision = 1; revision <= 1024; revision++) {
    const record = structuredClone(revision % 2 ? enrolled : revoked);
    record.revision = revision; record.previousDigest = previous;
    record.transactionId = `${revision.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
    if (revision % 2 === 0) record.enrollmentDigest = activeDigest;
    const entry = triple(bytes(record)); entries.push(entry); previous = hash(entry.record);
    if (revision % 2) activeDigest = previous;
  }
  const active = chain(entries.slice(0, 1023));
  assert.equal(active.state, 'active'); assert.equal(active.brokerLocalRevision, 1023);
  const terminal = chain(entries);
  assert.equal(terminal.state, 'revoked'); assert.equal(terminal.brokerLocalRevision, 1024);
  refuse(() => chain([...entries, triple(fixture('enrollment'))]));
  const wrong = JSON.parse(entries[1023].record); wrong.enrollmentDigest = 'c'.repeat(64);
  refuse(() => chain([...entries.slice(0, 1023), triple(bytes(wrong))]));
});

test('decoded records are independent snapshots and do not smuggle installation or daemon authority', () => {
  const input = fixture('enrollment'), decoded = decode(input), original = decoded.record.receiptKey.keyId;
  input.fill(0);
  assert.equal(decoded.record.receiptKey.keyId, original);
  assert.throws(() => { decoded.record.receiptKey.keyId = 'c'.repeat(64); }, TypeError);
  assert.throws(() => { decoded.record.service.brokerUid = 1; }, TypeError);
  const value = JSON.parse(fixture('enrollment')); value.daemonKey = vectors.daemonKey;
  refuse(() => decode(bytes(value)));
  // Service UID is schema data only: codec acceptance cannot establish that it
  // differs from the real owner or that the service runs in a separate account.
  value.service.brokerUid = 1; delete value.daemonKey;
  const result = chain([triple(bytes(value))]); assert.equal(result.custodyVerified, false);
});

test('chain accessors cannot shrink grow or replace the validated sequence', () => {
  for (const mutate of [entries => { entries.length = 0; }, entries => { entries.push(triple(fixture('revocation'))); },
    entries => { entries[0] = triple(fixture('revocation')); }]) {
    const entry = triple(fixture('enrollment')), entries = [entry]; let called = false;
    const original = entry.confirmation;
    Object.defineProperty(entry, 'confirmation', { enumerable: true, get() { called = true; mutate(entries); return original; } });
    refuse(() => chain(entries)); assert.equal(called, false);
  }
  const entries = [];
  Object.defineProperty(entries, '0', { get() { throw new Error('CANARY'); } });
  refuse(() => chain(entries));
});
