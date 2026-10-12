// Specification consistency only: no production parser, effect adapter, journal
// or authority is imported. Malformed runtime coverage remains a separate gate.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(new URL('../../tests/fixtures/owner-decisions/effect-evidence-v2.json', import.meta.url)));
const canonical = v => v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(canonical)}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const digest = v => createHash('sha256').update(v).digest('hex');
const exact = (v, names) => assert.deepEqual(Object.keys(v).sort(), names.split(' ').sort());
const match = (v, pattern) => assert.equal(typeof v === 'string' && pattern.exec(v)?.[0] === v, true);
const hash = v => match(v, /^[a-f0-9]{64}$/);
const uuid = v => match(v, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const number = (v, max = Number.MAX_SAFE_INTEGER) => assert(Number.isSafeInteger(v) && v >= 0 && v <= max);
const revision = v => match(v, /^sha256:[a-f0-9]{64}$/);
const nullable = (v, check) => { if (v !== null) check(v); };
const seq = v => number(v, 9_999_999_999);
const setting = v => {
  if (v.mode === 'resume') { exact(v, 'mode policy'); assert(['read-only', 'workspace'].includes(v.policy)); }
  else { exact(v, 'mode'); assert(['on', 'off', 'webhook'].includes(v.mode)); }
};
function inspect(record) {
  assert.equal(record.v, record.kind === 'preparation' ? 2 : 1); uuid(record.requestId); hash(record.payloadDigest);
  if (record.kind === 'preparation') {
    exact(record, 'v kind requestId principal account soul operation payloadDigest effectId actionDigest nonce acceptedAt preparedAt exp daemonKey daemonEpoch watchId stage expected trustVersion');
    assert(Number.isSafeInteger(record.trustVersion) && record.trustVersion >= 1 && record.trustVersion <= 1023 && record.trustVersion % 2 === 1);
    match(record.principal, /^principal_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    match(record.soul, /^agent_[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    uuid(record.effectId); match(record.account, /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/); hash(record.actionDigest); hash(record.daemonKey); uuid(record.watchId);
    number(record.daemonEpoch); assert(record.daemonEpoch > 0);
    for (const key of ['acceptedAt', 'preparedAt', 'exp']) number(record[key]);
    const nonce = Buffer.from(record.nonce, 'base64url'); assert.equal(nonce.length, 32); assert.equal(nonce.toString('base64url'), record.nonce);
    nullable(record.stage, s => { exact(s, 'stagingId kind contentDigest expiresAt'); uuid(s.stagingId); hash(s.contentDigest); number(s.expiresAt); assert(['package', 'webhook'].includes(s.kind)); });
    const e = record.expected;
    if (record.operation.startsWith('revision.')) {
      assert(['revision.approve', 'revision.reject', 'revision.adopt', 'revision.edit'].includes(record.operation));
      exact(e, 'kind head proposal destination'); assert.equal(e.kind, 'revision');
      nullable(e.head, h => { exact(h, 'seq revision'); seq(h.seq); revision(h.revision); });
      assert.equal(e.head === null, record.operation === 'revision.adopt');
      nullable(e.proposal, p => { exact(p, 'proposalId seq revision parentRevision'); uuid(p.proposalId); seq(p.seq); revision(p.revision); revision(p.parentRevision); assert.equal(p.parentRevision, e.head.revision); });
      assert.equal(e.proposal !== null, ['revision.approve', 'revision.reject'].includes(record.operation));
      nullable(e.destination, d => { exact(d, 'rootDigest beforeInventoryDigest'); hash(d.rootDigest); hash(d.beforeInventoryDigest); assert.equal(record.operation, 'revision.edit'); });
    } else {
      assert.equal(record.operation, 'cold-wake.set'); exact(e, 'kind setting webhookDigest resume'); assert.equal(e.kind, 'cold-wake'); setting(e.setting); nullable(e.webhookDigest, hash);
      nullable(e.resume, r => { exact(r, 'harness sessionDigest toolHomeDigest destinationDigest'); assert(['codex', 'opencode', 'devin', 'grok'].includes(r.harness)); nullable(r.sessionDigest, hash); hash(r.toolHomeDigest); hash(r.destinationDigest); });
    }
  } else if (record.kind === 'effect') {
    exact(record, 'v kind requestId payloadDigest preparationDigest receiptDigest effectId phase at detail');
    hash(record.preparationDigest); nullable(record.receiptDigest, hash); uuid(record.effectId); number(record.at);
    const d = record.detail;
    if (record.phase === 'refused') { exact(d, 'code'); assert(['expired', 'expected-state-changed', 'proposal-not-pending', 'stage-invalid', 'target-unavailable', 'validation-failed', 'storage-unavailable', 'trust-unavailable'].includes(d.code)); }
    else {
      assert(['entered', 'completed'].includes(record.phase)); assert.notEqual(record.receiptDigest, null);
      if (d.kind === 'revision') {
        exact(d, record.phase === 'entered' ? 'kind beforeRevision afterRevision proposalId apply' : 'kind journalSeq journalRecordDigest beforeRevision afterRevision proposalId working');
        nullable(d.beforeRevision, revision); revision(d.afterRevision); nullable(d.proposalId, uuid);
        if (record.phase === 'entered') assert.equal(typeof d.apply, 'boolean');
        else { seq(d.journalSeq); hash(d.journalRecordDigest); nullable(d.working, w => { exact(w, 'rootDigest inventoryDigest'); hash(w.rootDigest); hash(w.inventoryDigest); }); }
      } else {
        assert.equal(d.kind, 'cold-wake'); exact(d, record.phase === 'entered' ? 'kind beforeDigest afterDigest' : 'kind beforeDigest afterDigest settingsDigest webhookDigest');
        hash(d.beforeDigest); hash(d.afterDigest);
        if (record.phase === 'completed') { hash(d.settingsDigest); nullable(d.webhookDigest, hash); }
      }
    }
  } else {
    assert.equal(record.kind, 'reconciliation'); exact(record, 'v kind requestId payloadDigest effectId auditId originalDaemonKey originalDaemonEpoch reportingDaemonKey reportingDaemonEpoch at finding basisDigest observedDigest');
    nullable(record.effectId, uuid); uuid(record.auditId); hash(record.originalDaemonKey); hash(record.reportingDaemonKey);
    for (const key of ['originalDaemonEpoch', 'reportingDaemonEpoch']) { number(record[key]); assert(record[key] > 0); }
    number(record.at); assert(['applied', 'refused', 'indeterminate'].includes(record.finding)); nullable(record.basisDigest, hash); hash(record.observedDigest);
    if (record.finding !== 'indeterminate') { assert.notEqual(record.basisDigest, null); assert.notEqual(record.effectId, null); }
  }
}
assert.equal(data.version, 2); assert.equal(data.status, 'disabled-producer-contract');
assert.equal(data.sourceSha256, digest(readFileSync(new URL('../../tests/fixtures/owner-decisions/effect-evidence-v1.json', import.meta.url))));
assert.equal(data.outcomeSourceSha256, digest(readFileSync(new URL('../../tests/fixtures/owner-decisions/effect-outcomes-v1.json', import.meta.url))));
assert.equal(data.boundaryPreparations.length, 1);
assert.equal(data.boundaryPreparations[0].record.kind, 'preparation');
assert.equal(data.boundaryPreparations[0].record.trustVersion, 1023);
function framing(v) {
  exact(v, 'id record canonicalJson sha256 utf8Bytes cap');
  const text = canonical(v.record); assert.equal(text, v.canonicalJson);
  assert.equal(digest(text), v.sha256); assert.equal(Buffer.byteLength(text), v.utf8Bytes);
  assert.equal(v.cap, v.record.kind === 'reconciliation' ? 2048 : 4096); assert(v.utf8Bytes <= v.cap);
}
const ids = new Set();
for (const v of [...data.records, ...data.boundaryPreparations]) {
  assert(!ids.has(v.id)); ids.add(v.id); inspect(v.record); framing(v);
}
const preparations = new Map(data.records.filter(v => v.record.kind === 'preparation').map(v => [v.record.requestId, v]));
const effects = new Map(data.records.filter(v => v.record.kind === 'effect').map(v => [v.sha256, v]));
for (const v of effects.values()) {
  const prep = preparations.get(v.record.requestId); assert(prep);
  assert.equal(v.record.preparationDigest, prep.sha256);
  assert.equal(v.record.payloadDigest, prep.record.payloadDigest); assert.equal(v.record.effectId, prep.record.effectId);
}
for (const v of data.records.filter(v => v.record.kind === 'reconciliation' && v.record.finding !== 'indeterminate')) {
  const basis = effects.get(v.record.basisDigest); assert(basis);
  assert.equal(basis.record.phase, v.record.finding === 'applied' ? 'completed' : 'refused');
  for (const key of ['requestId','payloadDigest','effectId']) assert.equal(v.record[key], basis.record[key]);
}
assert.deepEqual(data.negatives.map(v => v.id), ['missing','even','zero','above-bound','noninteger','extra-key']);
for (const v of data.negatives) {
  const {expected, ...encoded} = v; assert.equal(expected, 'refused'); framing(encoded);
  assert.throws(() => inspect(v.record));
}
for (const v of data.entryCases) {
  exact(v, 'id preparationId currentTrustVersion expected');
  const prep = data.records.find(p => p.id === v.preparationId); assert(prep); inspect(prep.record);
  const accepted = Number.isSafeInteger(v.currentTrustVersion) && v.currentTrustVersion >= 1
    && v.currentTrustVersion <= 1023 && v.currentTrustVersion % 2 === 1
    && v.currentTrustVersion === prep.record.trustVersion;
  assert.equal(v.expected, accepted ? 'accepted' : 'refused');
}
assert.equal(data.entryCases.length, 2);
console.log(JSON.stringify({status:'specification-consistency-only',records:data.records.length,boundaryTrustVersion:data.boundaryPreparations[0].record.trustVersion,negativePreparations:data.negatives.length,entryCases:data.entryCases.length}));
