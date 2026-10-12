// Private, disabled evidence admission. No transport, storage, signature checks,
// credential lookup or mutation authority. Daemon preparation is v2; neither
// the broker prepared wrapper nor native brokerLocalRevision is this version.
import { createHash } from 'node:crypto';
import { decodeOwnerDecisionCanonical, snapshotOwnerDecisionBytes } from './owner-decision-canonical.mjs';
import { validateOwnerDecisionAdmission } from './owner-decision-admission.mjs';
import { decodeOwnerDecisionAction } from './owner-decision-codec.mjs';
import { decodeOwnerDecisionPrepared } from './owner-decision-prepared.mjs';

const fail = () => { throw new Error('invalid-owner-daemon-evidence'); };
const requireValue = value => { if (!value) fail(); };
const exact = (v, fields) => requireValue(v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k)));
const match = (v, re) => requireValue(typeof v === 'string' && re.exec(v)?.[0] === v);
const digest = v => match(v, /^[a-f0-9]{64}$/);
const uuid = v => match(v, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const revision = v => match(v, /^sha256:[a-f0-9]{64}$/);
const integer = (v, max = Number.MAX_SAFE_INTEGER) => requireValue(Number.isSafeInteger(v) && v >= 0 && v <= max);
const nullable = (v, check) => { if (v !== null) check(v); };
const hash = v => createHash('sha256').update(v).digest('hex');
const trustVersion = v => { integer(v, 1023); requireValue(v > 0 && v % 2 === 1); };
// Only internal, already decoded/schema-checked plain values reach this encoder.
const canonical = v => v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(canonical)}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const encoded = v => Buffer.from(canonical(v));
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
function snapshot(source, cap) {
  requireValue(source instanceof Uint8Array && byteLength.call(source) > 0 && byteLength.call(source) <= cap);
  const bytes = Buffer.from(snapshotOwnerDecisionBytes(source));
  requireValue(bytes.length <= cap);
  return bytes;
}
function read(source, cap) { const bytes = snapshot(source, cap); return { bytes, record: decodeOwnerDecisionCanonical(bytes) }; }
const guarded = fn => (...args) => { try { return fn(...args); } catch { fail(); } };
function head(v) { exact(v, ['seq', 'revision']); integer(v.seq, 9_999_999_999); revision(v.revision); }
function proposal(v) {
  exact(v, ['proposalId', 'seq', 'revision', 'parentRevision']); uuid(v.proposalId);
  integer(v.seq, 9_999_999_999); revision(v.revision); revision(v.parentRevision);
}
function working(v) { exact(v, ['rootDigest', 'inventoryDigest']); digest(v.rootDigest); digest(v.inventoryDigest); }
function setting(v) {
  if (v?.mode === 'resume') { exact(v, ['mode', 'policy']); requireValue(['read-only', 'workspace'].includes(v.policy)); }
  else { exact(v, ['mode']); requireValue(['on', 'off', 'webhook'].includes(v.mode)); }
}
function resume(v) {
  exact(v, ['harness', 'sessionDigest', 'toolHomeDigest', 'destinationDigest']);
  requireValue(['codex', 'opencode', 'devin', 'grok'].includes(v.harness));
  nullable(v.sessionDigest, digest); digest(v.toolHomeDigest); digest(v.destinationDigest);
}
function cold(v, observation = false) {
  exact(v, [...(observation ? ['v'] : ['kind']), 'setting', 'webhookDigest', 'resume']);
  requireValue(observation ? v.v === 1 : v.kind === 'cold-wake');
  setting(v.setting); nullable(v.webhookDigest, digest); nullable(v.resume, resume);
}
function expected(v, operation) {
  if (operation === 'cold-wake.set') { cold(v); return; }
  exact(v, ['kind', 'head', 'proposal', 'destination']); requireValue(v.kind === 'revision');
  nullable(v.head, head); nullable(v.proposal, proposal);
  requireValue((v.head === null) === (operation === 'revision.adopt'));
  requireValue((v.proposal !== null) === ['revision.approve', 'revision.reject'].includes(operation));
  if (v.proposal) requireValue(v.proposal.parentRevision === v.head.revision);
  nullable(v.destination, d => {
    exact(d, ['rootDigest', 'beforeInventoryDigest']); digest(d.rootDigest); digest(d.beforeInventoryDigest);
    requireValue(operation === 'revision.edit');
  });
}
const desiredSetting = p => p.mode === 'resume' ? { mode: p.mode, policy: p.policy } : { mode: p.mode };
const coldDigest = v => hash(encoded({ v: 1, setting: v.setting, webhookDigest: v.webhookDigest, resume: v.resume }));

// The supplied bytes must come from the caller's independently custody-checked
// retained journal. Validity establishes causal consistency, never authority.
export const createOwnerDecisionDaemonEvidenceContext = guarded(({ originalActionBytes, acceptanceBytes, namespaceDigest }) => {
  const admission = validateOwnerDecisionAdmission(originalActionBytes, acceptanceBytes, namespaceDigest);
  const original = Buffer.from(admission.action), a = admission.record;
  const { action, actionText } = decodeOwnerDecisionAction(original), parameters = action.parameters;
  const tokens = new WeakMap();
  function token(item, type) {
    const result = Object.freeze({ type, digest: hash(item.bytes) });
    tokens.set(result, item); return result;
  }
  function owned(value, type) {
    requireValue(value?.type === type && tokens.has(value)); return tokens.get(value);
  }
  const decodePreparation = guarded(source => {
    const item = read(source, 4096), p = item.record;
    exact(p, ['v', 'kind', 'requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'effectId', 'actionDigest',
      'nonce', 'acceptedAt', 'preparedAt', 'exp', 'daemonKey', 'daemonEpoch', 'watchId', 'stage', 'expected', 'trustVersion']);
    requireValue(p.v === 2 && p.kind === 'preparation'); trustVersion(p.trustVersion); uuid(p.effectId);
    for (const k of ['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'acceptedAt', 'daemonKey', 'daemonEpoch', 'watchId']) requireValue(p[k] === a[k]);
    requireValue(p.actionDigest === hash(actionText));
    expected(p.expected, p.operation);
    const e = p.expected;
    if (['revision.approve', 'revision.reject'].includes(p.operation)) requireValue(e.proposal.proposalId === parameters.proposalId && e.head.revision === parameters.expectedRevision);
    else if (p.operation === 'revision.edit') requireValue(e.head.revision === parameters.expectedRevision && (e.destination !== null) === parameters.apply);
    else if (p.operation === 'cold-wake.set') requireValue((e.resume !== null) === (parameters.mode === 'resume' || e.setting.mode === 'resume'));
    // Reuse the public challenge/stage binding and historical deadline rules.
    const challenge = Object.fromEntries(['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'nonce',
      'acceptedAt', 'preparedAt', 'exp', 'daemonKey', 'daemonEpoch', 'watchId'].map(k => [k, p[k]]));
    challenge.action = original.toString('base64url');
    decodeOwnerDecisionPrepared(encoded({ v: 1, challenge, stage: p.stage }), { originalActionBytes: original,
      acceptedAt: a.acceptedAt, daemonKey: a.daemonKey, daemonEpoch: a.daemonEpoch, watchId: a.watchId });
    return token(item, 'preparation');
  });
  const checkPreparationTrustVersion = guarded((preparation, { currentTrustVersion }) => {
    const p = owned(preparation, 'preparation').record;
    trustVersion(currentTrustVersion); requireValue(currentTrustVersion === p.trustVersion); return true;
  });
  const decodeEffect = guarded((source, { preparation, receiptDigest, retainedGraph, entered = null,
    linkedEventBytes = null, retainedLinkedEventBytes = null, retainedLinkedEventSequence = null }) => {
    const prep = owned(preparation, 'preparation'), p = prep.record;
    nullable(receiptDigest, digest);
    const item = read(source, 4096), r = item.record;
    exact(r, ['v', 'kind', 'requestId', 'payloadDigest', 'preparationDigest', 'receiptDigest', 'effectId', 'phase', 'at', 'detail']);
    requireValue(r.v === 1 && r.kind === 'effect' && ['refused', 'entered', 'completed'].includes(r.phase)); integer(r.at);
    for (const k of ['requestId', 'payloadDigest', 'effectId']) requireValue(r[k] === p[k]);
    requireValue(r.preparationDigest === hash(prep.bytes)); nullable(r.receiptDigest, digest);
    // Explicit custody-validated graph assertions are required. This pure
    // module cannot prove their durable absence or authenticate their origin.
    exact(retainedGraph, ['phase', 'enteredBytes', 'completedBytes', 'refusedBytes']);
    requireValue(retainedGraph.phase === r.phase);
    const sameBytes = value => snapshot(value, 4096).equals(item.bytes);
    if (r.phase === 'refused') requireValue(retainedGraph.enteredBytes === null && retainedGraph.completedBytes === null && sameBytes(retainedGraph.refusedBytes));
    else if (r.phase === 'entered') requireValue(sameBytes(retainedGraph.enteredBytes) && retainedGraph.completedBytes === null && retainedGraph.refusedBytes === null);
    else requireValue(sameBytes(retainedGraph.completedBytes) && retainedGraph.refusedBytes === null);
    if (r.phase === 'refused') {
      requireValue(entered === null && linkedEventBytes === null && retainedLinkedEventBytes === null && retainedLinkedEventSequence === null);
      exact(r.detail, ['code']); requireValue(['expired', 'expected-state-changed', 'proposal-not-pending', 'stage-invalid', 'target-unavailable',
        'validation-failed', 'storage-unavailable', 'trust-unavailable'].includes(r.detail.code));
      requireValue(r.receiptDigest === null || r.receiptDigest === receiptDigest);
    } else {
      digest(receiptDigest); requireValue(r.receiptDigest === receiptDigest);
      const d = r.detail, e = p.expected, completed = r.phase === 'completed';
      const priorItem = completed ? owned(entered, 'effect') : null, prior = priorItem?.record;
      if (completed) requireValue(prior.phase === 'entered' && prior.preparationDigest === r.preparationDigest && prior.receiptDigest === r.receiptDigest
        && snapshot(retainedGraph.enteredBytes, 4096).equals(priorItem.bytes));
      else requireValue(entered === null);
      if (p.operation === 'cold-wake.set') {
        exact(d, completed ? ['kind', 'beforeDigest', 'afterDigest', 'settingsDigest', 'webhookDigest'] : ['kind', 'beforeDigest', 'afterDigest']);
        const desired = desiredSetting(parameters), webhookDigest = parameters.mode === 'webhook' ? parameters.configurationDigest : null;
        requireValue(d.kind === 'cold-wake' && d.beforeDigest === coldDigest(e)
          && d.afterDigest === coldDigest({ setting: desired, webhookDigest, resume: e.resume }));
        if (completed) requireValue(d.settingsDigest === hash(encoded(desired)) && d.webhookDigest === webhookDigest
          && d.beforeDigest === prior.detail.beforeDigest && d.afterDigest === prior.detail.afterDigest);
        requireValue(linkedEventBytes === null && retainedLinkedEventBytes === null && retainedLinkedEventSequence === null);
      } else {
        exact(d, completed ? ['kind', 'journalSeq', 'journalRecordDigest', 'beforeRevision', 'afterRevision', 'proposalId', 'working']
          : ['kind', 'beforeRevision', 'afterRevision', 'proposalId', 'apply']);
        const before = e.head?.revision ?? null;
        const after = p.operation === 'revision.approve' ? e.proposal.revision : p.operation === 'revision.reject' ? before : `sha256:${parameters.packageDigest}`;
        const apply = p.operation === 'revision.edit' && parameters.apply === true;
        requireValue(d.kind === 'revision' && d.beforeRevision === before && d.afterRevision === after && d.proposalId === (e.proposal?.proposalId ?? null));
        if (completed) {
          integer(d.journalSeq, 9_999_999_999); digest(d.journalRecordDigest); nullable(d.working, working);
          requireValue((d.working !== null) === apply && prior.detail.kind === 'revision' && prior.detail.apply === apply
            && d.beforeRevision === prior.detail.beforeRevision && d.afterRevision === prior.detail.afterRevision && d.proposalId === prior.detail.proposalId);
          if (apply) requireValue(d.working.rootDigest === e.destination.rootDigest);
          requireValue(retainedLinkedEventSequence === d.journalSeq);
          verifyLinkedEvent(linkedEventBytes, retainedLinkedEventBytes, r, p);
        } else { requireValue(d.apply === apply && linkedEventBytes === null && retainedLinkedEventBytes === null && retainedLinkedEventSequence === null); }
      }
    }
    return token(item, 'effect');
  });
  function verifyLinkedEvent(source, retained, r, p) {
    const bytes = snapshot(source, 16384), actual = snapshot(retained, 16384);
    requireValue(bytes.equals(actual) && hash(bytes) === r.detail.journalRecordDigest);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), event = JSON.parse(text);
    requireValue(`${JSON.stringify(event)}\n` === text && event.schemaVersion === 1
      && event.kind === (p.operation === 'revision.reject' ? 'decision' : 'revision')
      && typeof event.at === 'string' && new Date(event.at).toISOString() === event.at);
    exact(event.authorization, ['method']); requireValue(event.authorization.method === 'owner-decision');
    exact(event.ownerDecision, ['requestId', 'payloadDigest', 'receiptDigest', 'effectId', 'preparationDigest']);
    for (const k of ['requestId', 'payloadDigest', 'receiptDigest', 'effectId', 'preparationDigest']) requireValue(event.ownerDecision[k] === r[k]);
    if (['revision.approve', 'revision.reject'].includes(p.operation)) requireValue(event.proposalId === parameters.proposalId);
    if (event.kind === 'revision') requireValue(event.revision === r.detail.afterRevision);
  }
  const decodeReconciliationPair = guarded((source, { preparation = null, basis = null, ceremony }) => {
    const item = read(source, 4352), pair = item.record;
    exact(pair, ['v', 'preimage', 'record']); requireValue(pair.v === 1);
    const r = pair.record, observation = pair.preimage, recordBytes = encoded(r), preimageBytes = encoded(observation);
    requireValue(recordBytes.length <= 2048 && preimageBytes.length <= 2048 && item.bytes.length - recordBytes.length - preimageBytes.length <= 256);
    exact(r, ['v', 'kind', 'requestId', 'payloadDigest', 'effectId', 'auditId', 'originalDaemonKey', 'originalDaemonEpoch', 'reportingDaemonKey',
      'reportingDaemonEpoch', 'at', 'finding', 'basisDigest', 'observedDigest']);
    requireValue(r.v === 1 && r.kind === 'reconciliation' && ['indeterminate', 'applied', 'refused'].includes(r.finding));
    uuid(r.auditId); integer(r.at); digest(r.reportingDaemonKey); integer(r.reportingDaemonEpoch); requireValue(r.reportingDaemonEpoch > 0);
    requireValue(r.requestId === a.requestId && r.payloadDigest === a.payloadDigest && r.originalDaemonKey === a.daemonKey && r.originalDaemonEpoch === a.daemonEpoch);
    requireValue(r.observedDigest === hash(preimageBytes));
    const p = preparation === null ? null : owned(preparation, 'preparation').record;
    requireValue(r.effectId === (p?.effectId ?? null));
    if (r.finding === 'indeterminate') requireValue(basis === null && r.basisDigest === null);
    else {
      requireValue(p !== null); const proof = owned(basis, 'effect');
      requireValue(proof.record.phase === (r.finding === 'applied' ? 'completed' : 'refused')
        && proof.record.preparationDigest === preparation.digest && r.basisDigest === hash(proof.bytes));
    }
    if (a.operation === 'cold-wake.set') cold(observation, true);
    else {
      exact(observation, ['v', 'head', 'proposal', 'working']); requireValue(observation.v === 1);
      nullable(observation.head, head); nullable(observation.proposal, proposal); nullable(observation.working, working);
      requireValue((observation.working !== null) === (a.operation === 'revision.edit' && parameters.apply === true));
    }
    // This context is a required explicit assertion by the independently
    // authenticated ceremony caller. Matching it does not authenticate it.
    exact(ceremony, ['requestId', 'namespaceDigest', 'reportingDaemonKey', 'reportingDaemonEpoch', 'finding',
      'retainedPhase', 'entered', 'matchingState', 'ownerLocalCeremony']);
    requireValue(ceremony.namespaceDigest === namespaceDigest);
    for (const k of ['requestId', 'reportingDaemonKey', 'reportingDaemonEpoch', 'finding']) requireValue(ceremony[k] === r[k]);
    requireValue(typeof ceremony.entered === 'boolean' && typeof ceremony.matchingState === 'boolean' && ceremony.ownerLocalCeremony === true);
    if (ceremony.entered) requireValue(p !== null);
    if (r.finding === 'applied') requireValue(ceremony.retainedPhase === 'completed' && ceremony.entered && ceremony.matchingState);
    else if (r.finding === 'refused') requireValue(ceremony.retainedPhase === 'refused' && !ceremony.entered);
    else {
      requireValue(['absent', 'prepared', 'entered', 'uncertain'].includes(ceremony.retainedPhase));
      if (['absent', 'prepared'].includes(ceremony.retainedPhase)) requireValue(!ceremony.entered);
      if (ceremony.retainedPhase === 'entered') requireValue(ceremony.entered);
      if (ceremony.retainedPhase === 'absent') requireValue(p === null);
      if (ceremony.retainedPhase === 'prepared') requireValue(p !== null);
    }
    return token(item, 'reconciliation');
  });
  const inspect = guarded(value => {
    requireValue(tokens.has(value)); const item = tokens.get(value);
    return { bytes: Buffer.from(item.bytes), record: JSON.parse(JSON.stringify(item.record)), digest: hash(item.bytes) };
  });
  return Object.freeze({ decodePreparation, checkPreparationTrustVersion, decodeEffect, decodeReconciliationPair, inspect });
});
