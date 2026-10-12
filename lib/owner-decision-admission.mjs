// Shared strict admission validation, independent of filesystem and authority.
import { decodeOwnerDecisionCanonical, snapshotOwnerDecisionBytes } from './owner-decision-canonical.mjs';
import { decodeOwnerDecisionAction } from './owner-decision-codec.mjs';
const matches = (re, v) => typeof v === 'string' && re.exec(v)?.[0] === v;
const integer = v => Number.isSafeInteger(v) && v >= 0;
const digest = /^[a-f0-9]{64}$/;
const uuid4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const invalid = () => { throw new Error('invalid-owner-journal-record'); };

export function validateOwnerDecisionAdmission(actionBytes, acceptanceBytes, namespaceDigest) {
  try {
    if (!matches(digest, namespaceDigest)) invalid();
    const original = snapshotOwnerDecisionBytes(actionBytes), saved = snapshotOwnerDecisionBytes(acceptanceBytes);
    if (saved.length > 4096) invalid();
    const verified = decodeOwnerDecisionAction(original), acceptance = decodeOwnerDecisionCanonical(saved);
    const fields = ['v', 'kind', 'requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest',
      'namespaceDigest', 'acceptedAt', 'daemonKey', 'daemonEpoch', 'watchId', 'reservationBytes'];
    if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)
        || Object.keys(acceptance).length !== fields.length || fields.some(k => !Object.hasOwn(acceptance, k))
        || acceptance.v !== 1 || acceptance.kind !== 'acceptance' || acceptance.namespaceDigest !== namespaceDigest
        || acceptance.reservationBytes !== 262144 || !integer(acceptance.acceptedAt)
        || !matches(digest, acceptance.daemonKey) || !integer(acceptance.daemonEpoch) || acceptance.daemonEpoch === 0
        || !matches(uuid4, acceptance.watchId) || acceptance.payloadDigest !== verified.payloadDigest) invalid();
    for (const k of ['requestId', 'principal', 'account', 'soul', 'operation']) if (acceptance[k] !== verified.action[k]) invalid();
    return { action: original, acceptance: saved, record: acceptance, payloadDigest: verified.payloadDigest };
  } catch { invalid(); }
}
