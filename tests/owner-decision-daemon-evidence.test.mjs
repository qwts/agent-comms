import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createOwnerDecisionDaemonEvidenceContext } from '../lib/owner-decision-daemon-evidence.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/owner-decisions/${name}`, import.meta.url)));
const vectors = fixture('effect-evidence-v2.json'), actions = fixture('v1.json').positive;
const companion = fixture('daemon-admission-v2.json');
const sha = v => createHash('sha256').update(v).digest('hex');
const canonical = v => v && typeof v === 'object' ? Array.isArray(v) ? `[${v.map(canonical)}]`
  : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const bytes = v => Buffer.from(canonical(v));
const row = id => vectors.records.find(v => v.id === id);
const wire = id => Buffer.from(row(id).canonicalJson);
const namespaceDigest = '07'.repeat(32);
function context(p = row('approve-preparation').record) {
  const original = actions.find(v => JSON.parse(v.actionJson).requestId === p.requestId);
  assert.ok(original, 'independently pinned original action must exist');
  const acceptance = Object.fromEntries(['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'acceptedAt', 'daemonKey', 'daemonEpoch', 'watchId'].map(k => [k, p[k]]));
  return createOwnerDecisionDaemonEvidenceContext({ originalActionBytes: Buffer.from(original.actionJson),
    acceptanceBytes: bytes({ ...acceptance, v: 1, kind: 'acceptance', namespaceDigest, reservationBytes: 262144 }), namespaceDigest });
}
function graph(phase, source) {
  return { phase, enteredBytes: phase === 'entered' ? source : null, completedBytes: null, refusedBytes: phase === 'refused' ? source : null };
}

test('pinned preparation v2 records bind existing action/challenge codecs and explicit trust version', () => {
  for (const vector of [...vectors.records.filter(v => v.record.kind === 'preparation'), ...vectors.boundaryPreparations]) {
    const c = context(vector.record), token = c.decodePreparation(Buffer.from(vector.canonicalJson));
    assert.equal(token.digest, vector.sha256);
    assert.equal(c.checkPreparationTrustVersion(token, { currentTrustVersion: vector.record.trustVersion }), true);
    assert.throws(() => c.checkPreparationTrustVersion(token, { currentTrustVersion: 2 }));
    assert.throws(() => c.checkPreparationTrustVersion(token, { currentTrustVersion: vector.record.trustVersion === 1 ? 3 : 1 }));
    const inspected = c.inspect(token); inspected.bytes.fill(0); inspected.record.trustVersion = 2;
    assert.equal(c.inspect(token).digest, vector.sha256);
  }
});

test('canonicality, bounds, wrong bindings and foreign preparation tokens refuse', () => {
  const c = context(), input = wire('approve-preparation');
  for (const negative of vectors.negatives) assert.throws(() => c.decodePreparation(Buffer.from(negative.canonicalJson)));
  for (const source of [Buffer.concat([input, Buffer.from('\n')]), Buffer.concat([Buffer.from([239, 187, 191]), input]), Buffer.from([255]), Buffer.alloc(4097, 32)]) assert.throws(() => c.decodePreparation(source));
  for (const [key, value] of [['actionDigest', '00'.repeat(32)], ['payloadDigest', '00'.repeat(32)], ['daemonEpoch', 2], ['nonce', 'x'], ['exp', 2000000181]]) {
    assert.throws(() => c.decodePreparation(bytes({ ...row('approve-preparation').record, [key]: value })));
  }
  const other = context(), token = other.decodePreparation(input);
  assert.throws(() => c.checkPreparationTrustVersion(token, { currentTrustVersion: 1 }));
  assert.throws(() => c.decodePreparation(bytes({ v: 1, challenge: {}, stage: null })));
  class HostileBytes extends Uint8Array { get byteLength() { throw new Error('caller getter'); } }
  assert.equal(c.decodePreparation(new HostileBytes(input)).digest, row('approve-preparation').sha256);
  assert.throws(() => c.decodePreparation(new HostileBytes(4097)));
});

test('pinned entered and refused effects require explicit retained graph assertions', () => {
  for (const vector of vectors.records.filter(v => v.record.kind === 'effect' && v.record.phase !== 'completed')) {
    const p = vectors.records.find(v => v.record.kind === 'preparation' && v.record.requestId === vector.record.requestId);
    const c = context(p.record), preparation = c.decodePreparation(Buffer.from(p.canonicalJson)), source = Buffer.from(vector.canonicalJson);
    const options = { preparation, receiptDigest: vector.record.receiptDigest, retainedGraph: graph(vector.record.phase, source) };
    assert.equal(c.decodeEffect(source, options).digest, vector.sha256);
    assert.throws(() => c.decodeEffect(source, { ...options, retainedGraph: undefined }));
    assert.throws(() => c.decodeEffect(source, { ...options, retainedGraph: { ...options.retainedGraph, phase: 'completed' } }));
    if (vector.record.phase === 'refused') assert.throws(() => c.decodeEffect(source, { ...options,
      retainedGraph: { ...options.retainedGraph, enteredBytes: wire('approve-entered') } }));
    assert.throws(() => c.decodeEffect(bytes({ ...vector.record, preparationDigest: '00'.repeat(32) }), options));
  }
});

test('completed specification summaries cannot substitute for retained linked writer bytes', () => {
  const c = context(), preparation = c.decodePreparation(wire('approve-preparation'));
  const enteredBytes = wire('approve-entered'), receiptDigest = row('approve-entered').record.receiptDigest;
  const entered = c.decodeEffect(enteredBytes, { preparation, receiptDigest, retainedGraph: graph('entered', enteredBytes) });
  const completedBytes = wire('approve-completed');
  assert.throws(() => c.decodeEffect(completedBytes, { preparation, receiptDigest, entered,
    retainedGraph: { phase: 'completed', enteredBytes, completedBytes, refusedBytes: null } }));
});

function composed(sample) {
  const c = context(row(sample.preparationId).record), preparation = c.decodePreparation(wire(sample.preparationId));
  const enteredBytes = wire(sample.enteredId), receiptDigest = row(sample.enteredId).record.receiptDigest;
  const entered = c.decodeEffect(enteredBytes, { preparation, receiptDigest, retainedGraph: graph('entered', enteredBytes) });
  const completedBytes = Buffer.from(sample.completed.canonicalJson), linked = sample.linkedEventJson === null ? null : Buffer.from(sample.linkedEventJson);
  const options = { preparation, receiptDigest, entered,
    retainedGraph: { phase: 'completed', enteredBytes, completedBytes, refusedBytes: null },
    linkedEventBytes: linked, retainedLinkedEventBytes: linked,
    retainedLinkedEventSequence: linked === null ? null : sample.completed.record.detail.journalSeq };
  return { c, preparation, entered, options, completedBytes };
}
function ceremony(pair, retainedPhase) {
  return { requestId: pair.record.requestId, namespaceDigest, reportingDaemonKey: pair.record.reportingDaemonKey,
    reportingDaemonEpoch: pair.record.reportingDaemonEpoch, finding: pair.record.finding, retainedPhase,
    entered: ['entered', 'completed'].includes(retainedPhase), matchingState: true, ownerLocalCeremony: true };
}

test('independent Python companions pin inputs and original writer framing', () => {
  assert.equal(companion.status, 'synthetic-conformance-only-not-daemon-v2-output');
  for (const [file, expected] of [['effect-evidence-v2.json', companion.sourceSha256], ['v1.json', companion.actionSourceSha256]]) {
    assert.equal(sha(readFileSync(new URL(`./fixtures/owner-decisions/${file}`, import.meta.url))), expected);
  }
  assert.equal(companion.linkedWriterCommit, '13ab9a7878d4a0826162400986c21ccb7ca88d0c');
  assert.equal(companion.pairContractCommit, '36a6ecde5a8a49d80d32895a120fb272e412ab2f');
  for (const sample of companion.cases) {
    if (sample.linkedEventJson !== null) {
      assert.ok(sample.linkedEventJson.startsWith('{"schemaVersion":1,"kind":'));
      assert.ok(sample.linkedEventJson.endsWith('\n'));
      assert.notEqual(sample.linkedEventJson, `${canonical(JSON.parse(sample.linkedEventJson))}\n`);
      assert.equal(sha(sample.linkedEventJson), sample.completed.record.detail.journalRecordDigest);
    }
  }
});

test('all operation companions admit full revision/cold completions and three findings', () => {
  for (const sample of companion.cases) {
    const { c, preparation, options, completedBytes } = composed(sample);
    const completed = c.decodeEffect(completedBytes, options);
    assert.equal(completed.digest, sample.completed.sha256);
    const refusedBytes = Buffer.from(sample.refused.canonicalJson);
    const refused = c.decodeEffect(refusedBytes, { preparation, receiptDigest: sample.refused.record.receiptDigest,
      retainedGraph: graph('refused', refusedBytes) });
    for (const entry of sample.pairs) {
      const pair = entry.record, finding = pair.record.finding, retainedPhase = finding === 'applied' ? 'completed' : finding === 'refused' ? 'refused' : 'entered';
      const token = c.decodeReconciliationPair(Buffer.from(entry.canonicalJson), { preparation,
        basis: finding === 'applied' ? completed : finding === 'refused' ? refused : null, ceremony: ceremony(pair, retainedPhase) });
      assert.equal(token.digest, entry.sha256);
    }
    const absent = sample.noPreparation;
    assert.equal(c.decodeReconciliationPair(Buffer.from(absent.canonicalJson), {
      ceremony: ceremony(absent.record, 'absent') }).digest, absent.sha256);
    for (const retainedPhase of ['entered', 'uncertain']) {
      assert.throws(() => c.decodeReconciliationPair(Buffer.from(absent.canonicalJson), {
        ceremony: { ...ceremony(absent.record, retainedPhase), entered: true } }));
    }
    assert.equal(c.decodeReconciliationPair(Buffer.from(absent.canonicalJson), {
      ceremony: ceremony(absent.record, 'uncertain') }).digest, absent.sha256);
    const indeterminate = sample.pairs.find(v => v.finding === 'indeterminate');
    for (const phase of ['prepared', 'uncertain']) {
      assert.equal(c.decodeReconciliationPair(Buffer.from(indeterminate.canonicalJson), { preparation,
        ceremony: ceremony(indeterminate.record, phase) }).digest, indeterminate.sha256);
    }
  }
});

test('linked completion refuses missing/mismatched authorization, exact bytes, sequence and phase', () => {
  const sample = companion.cases.find(v => v.id === 'approve'), { c, options, completedBytes } = composed(sample);
  assert.throws(() => c.decodeEffect(completedBytes, { ...options, retainedLinkedEventSequence: 12 }));
  assert.throws(() => c.decodeEffect(completedBytes, { ...options, retainedLinkedEventBytes: Buffer.from('{}\n') }));
  for (const authorization of [undefined, { method: 'consent' }, { method: 'owner-decision', extra: true }]) {
    const event = JSON.parse(sample.linkedEventJson);
    if (authorization === undefined) delete event.authorization; else event.authorization = authorization;
    const linked = Buffer.from(`${JSON.stringify(event)}\n`), changed = structuredClone(sample.completed.record);
    changed.detail.journalRecordDigest = sha(linked);
    const source = bytes(changed);
    assert.throws(() => c.decodeEffect(source, { ...options, linkedEventBytes: linked, retainedLinkedEventBytes: linked,
      retainedGraph: { ...options.retainedGraph, completedBytes: source } }));
  }
  assert.throws(() => c.decodeEffect(completedBytes, { ...options,
    retainedGraph: { ...options.retainedGraph, enteredBytes: null } }));
});

test('reconciliation refuses wrong basis/union/digest/reporter, missing ceremony and false graph claims', () => {
  const sample = companion.cases.find(v => v.id === 'approve'), { c, preparation, options, completedBytes } = composed(sample);
  const completed = c.decodeEffect(completedBytes, options), applied = sample.pairs.find(v => v.finding === 'applied');
  const pair = applied.record, source = Buffer.from(applied.canonicalJson);
  const good = { preparation, basis: completed, ceremony: ceremony(pair, 'completed') };
  for (const override of [{ ceremony: undefined }, { basis: null }, { preparation: null },
    { ceremony: { ...good.ceremony, matchingState: false } }, { ceremony: { ...good.ceremony, ownerLocalCeremony: false } },
    { ceremony: { ...good.ceremony, entered: false } }, { ceremony: { ...good.ceremony, retainedPhase: 'entered' } },
    { ceremony: { ...good.ceremony, reportingDaemonEpoch: 99 } }]) assert.throws(() => c.decodeReconciliationPair(source, { ...good, ...override }));
  for (const [key, value] of [['basisDigest', '00'.repeat(32)], ['observedDigest', '00'.repeat(32)], ['effectId', null], ['originalDaemonEpoch', 2], ['extra', 0]]) {
    const changed = structuredClone(pair); changed.record[key] = value;
    assert.throws(() => c.decodeReconciliationPair(bytes(changed), good));
  }
  const coldPreimage = { v: 1, setting: { mode: 'on' }, webhookDigest: null, resume: null };
  const wrongUnion = structuredClone(pair); wrongUnion.preimage = coldPreimage; wrongUnion.record.observedDigest = sha(bytes(coldPreimage));
  assert.throws(() => c.decodeReconciliationPair(bytes(wrongUnion), good));
  const largeComponent = structuredClone(pair); largeComponent.preimage.head.revision = `sha256:${'a'.repeat(2100)}`;
  assert.ok(bytes(largeComponent).length < 4352);
  assert.throws(() => c.decodeReconciliationPair(bytes(largeComponent), good));
  assert.throws(() => c.decodeReconciliationPair(Buffer.alloc(4353, 32), good));
  assert.throws(() => c.decodeReconciliationPair(Buffer.concat([source, Buffer.from('\n')]), good));
  const refusedEntry = sample.pairs.find(v => v.finding === 'refused'), refusedBytes = Buffer.from(sample.refused.canonicalJson);
  const refused = c.decodeEffect(refusedBytes, { preparation, receiptDigest: sample.refused.record.receiptDigest, retainedGraph: graph('refused', refusedBytes) });
  assert.throws(() => c.decodeReconciliationPair(Buffer.from(refusedEntry.canonicalJson), { preparation, basis: refused,
    ceremony: { ...ceremony(refusedEntry.record, 'refused'), entered: true } }));
});
