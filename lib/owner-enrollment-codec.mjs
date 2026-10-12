// Broker-local public metadata only. Decoding is not owner authority, custody,
// physical durability, a protected installation provider or permission to write.
import { createHash } from 'node:crypto';
import { decodeOwnerDecisionCanonical, snapshotOwnerDecisionBytes } from './owner-decision-canonical.mjs';

const invalid = () => { throw new Error('invalid-owner-enrollment-record'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && value.length === 36
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const exact = (value, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k))) invalid();
};
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function pin(value) {
  exact(value, ['alg', 'publicKey', 'keyId']);
  if (value.alg !== 'ed25519' || typeof value.publicKey !== 'string' || value.publicKey.length !== 43 || !digest(value.keyId)) invalid();
  const raw = Buffer.from(value.publicKey, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== value.publicKey
      || hash(Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])) !== value.keyId) invalid();
}

export function decodeBrokerOwnerEnrollmentRecord(input) {
  try {
    const bytes = Buffer.from(snapshotOwnerDecisionBytes(input));
    if (bytes.length > 4096) invalid();
    const value = decodeOwnerDecisionCanonical(bytes);
    const common = ['v', 'kind', 'namespaceDigest', 'revision'];
    if (!value || value.v !== 1 || !digest(value.namespaceDigest) || !Number.isSafeInteger(value.revision)
        || value.revision < 1 || value.revision > 1024) invalid();
    if (value.kind === 'broker-owner-confirmation') {
      exact(value, [...common, 'recordDigest', 'auditDigest']);
      if (bytes.length > 512 || !digest(value.recordDigest) || !digest(value.auditDigest)) invalid();
    } else if (value.kind === 'broker-owner-audit') {
      exact(value, [...common, 'recordDigest', 'transactionId', 'decisionEvidenceDigest']);
      if (bytes.length > 512 || !digest(value.recordDigest) || !uuid(value.transactionId) || !digest(value.decisionEvidenceDigest)) invalid();
    } else {
      const fields = [...common, 'previousDigest', 'transactionId', 'at', 'service', 'decisionEvidenceDigest'];
      if (value.kind === 'broker-owner-enrollment') {
        exact(value, [...fields, 'receiptKey', 'presenceKey']);
        if (value.revision > 1023) invalid();
        pin(value.receiptKey); pin(value.presenceKey);
        if (value.receiptKey.keyId === value.presenceKey.keyId) invalid();
      } else if (value.kind === 'broker-owner-revocation') {
        exact(value, [...fields, 'enrollmentDigest']);
        if (!digest(value.enrollmentDigest)) invalid();
      } else invalid();
      if ((value.revision === 1 ? value.previousDigest !== null : !digest(value.previousDigest))
          || !uuid(value.transactionId) || !Number.isSafeInteger(value.at) || value.at < 0
          || !digest(value.decisionEvidenceDigest)) invalid();
      exact(value.service, ['platform', 'brokerUid']);
      if (value.service.platform !== 'darwin' || !Number.isSafeInteger(value.service.brokerUid)
          || value.service.brokerUid <= 0 || value.service.brokerUid > 0xffffffff) invalid();
    }
    return Object.freeze({ record: freeze(value), sha256: hash(bytes) });
  } catch { invalid(); }
}

// Exact complete public triples are structural evidence only. A storage loader
// must independently establish custody, durability and owner-ceremony evidence.
export function validateBrokerOwnerEnrollmentChain(entries) {
  try {
    if (!Array.isArray(entries)) invalid();
    const count = Object.getOwnPropertyDescriptor(entries, 'length')?.value;
    if (!Number.isSafeInteger(count) || count < 1 || count > 1024) invalid();
    // No entry/field getter may rewrite the sequence while it is validated.
    // Copy each byte input up front; all later reads use this private snapshot.
    const snapshot = [];
    for (let i = 0; i < count; i++) {
      const item = Object.getOwnPropertyDescriptor(entries, String(i));
      if (!item || !Object.hasOwn(item, 'value')) invalid();
      exact(item.value, ['record', 'audit', 'confirmation']);
      const copy = {};
      for (const field of ['record', 'audit', 'confirmation']) {
        const descriptor = Object.getOwnPropertyDescriptor(item.value, field);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
        copy[field] = snapshotOwnerDecisionBytes(descriptor.value);
        if (copy[field].length > (field === 'record' ? 4096 : 512)) invalid();
      }
      snapshot.push(copy);
    }
    let previous = null, active = null, namespace = null, serviceUid = null;
    const transactions = new Set();
    for (let i = 0; i < count; i++) {
      const r = decodeBrokerOwnerEnrollmentRecord(snapshot[i].record);
      const a = decodeBrokerOwnerEnrollmentRecord(snapshot[i].audit);
      const c = decodeBrokerOwnerEnrollmentRecord(snapshot[i].confirmation);
      const record = r.record, audit = a.record, confirmation = c.record;
      if (!['broker-owner-enrollment', 'broker-owner-revocation'].includes(record.kind)
          || audit.kind !== 'broker-owner-audit' || confirmation.kind !== 'broker-owner-confirmation') invalid();
      namespace ??= record.namespaceDigest; serviceUid ??= record.service.brokerUid;
      if ([record, audit, confirmation].some(v => v.namespaceDigest !== namespace || v.revision !== i + 1)
          || record.service.brokerUid !== serviceUid || record.previousDigest !== previous
          || audit.recordDigest !== r.sha256 || confirmation.recordDigest !== r.sha256
          || confirmation.auditDigest !== a.sha256 || audit.transactionId !== record.transactionId
          || audit.decisionEvidenceDigest !== record.decisionEvidenceDigest || transactions.has(record.transactionId)) invalid();
      transactions.add(record.transactionId);
      if (record.kind === 'broker-owner-enrollment') {
        if (active) invalid();
        active = r;
      } else {
        if (!active || record.enrollmentDigest !== active.sha256) invalid();
        active = null;
      }
      previous = r.sha256;
    }
    return Object.freeze({ namespaceDigest: namespace, brokerLocalRevision: count,
      headDigest: previous, state: active ? 'active' : 'revoked', activeRecord: active?.record ?? null,
      authorizationSupported: false, custodyVerified: false, durabilityVerified: false });
  } catch { invalid(); }
}
