// Disabled, producer-owned lifecycle validation. Records are evidence, not
// current authority; no live check permit or credential lookup is implemented.
import { createHash, KeyObject } from 'node:crypto';
import { decodeOwnerDecisionCanonical, snapshotOwnerDecisionBytes } from './owner-decision-canonical.mjs';
import { validateOwnerDecisionAdmission } from './owner-decision-admission.mjs';
import { decodeOwnerDecisionPrepared } from './owner-decision-prepared.mjs';
import { verifySignedOwnerDecisionReceipt } from './owner-decision-codec.mjs';
import { verifyOwnerDecisionProof } from './owner-decision-proof.mjs';
import { verifyPresence } from './vendor/agent-bot-presence/identity-presence.mjs';
import { OWNER_JOURNAL_FIXED_SLOTS } from './owner-decision-journal-frame.mjs';

const fail = () => { throw new Error('invalid-owner-journal-record'); };
const integer = v => Number.isSafeInteger(v) && v >= 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (re, value) => typeof value === 'string' && re.exec(value)?.[0] === value;
const digest = v => { if (!matches(/^[a-f0-9]{64}$/, v)) fail(); };
const uuid = v => { if (!matches(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, v)) fail(); };
const epoch = v => { if (!integer(v) || v === 0) fail(); };
const exact = (v, names) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== names.length
      || names.some(k => !Object.hasOwn(v, k))) fail();
};
const same = (record, source, keys) => { for (const key of keys) if (record[key] !== source[key]) fail(); };
const CAPS = new Map(OWNER_JOURNAL_FIXED_SLOTS.map(v => [v.slot, v.cap]));
const CODES = { applied: ['applied'], refused: ['validation-refused', 'authority-refused', 'deadline-expired'],
  cancelled: ['cancelled'], expired: ['deadline-expired'], indeterminate: ['effect-uncertain'] };
const keyMap = keys => {
  if (!Array.isArray(keys) || keys.length > 4096) fail();
  const result = new Map();
  for (const key of keys) {
    if (!(key instanceof KeyObject) || key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') fail();
    const id = hash(key.export({ type: 'spki', format: 'der' }));
    if (result.has(id)) fail(); result.set(id, key);
  }
  return result;
};
const token = bytes => {
  if (bytes.length > 4096 || bytes.some(byte => byte > 127)) fail();
  return bytes.toString('ascii');
};
function reference(source, a, outcome, findings) {
  const raw = Buffer.from(snapshotOwnerDecisionBytes(source));
  if (raw.length > 2048) fail();
  const r = decodeOwnerDecisionCanonical(raw);
  if (outcome?.state !== 'indeterminate') fail();
  exact(r, ['v', 'kind', 'requestId', 'payloadDigest', 'originalDaemonKey', 'originalDaemonEpoch',
    'reportingDaemonKey', 'reportingDaemonEpoch', 'at', 'finding', 'auditId', 'evidenceDigest']);
  if (r.v !== 1 || r.kind !== 'reconciliation-reference' || !findings.includes(r.finding) || !integer(r.at)) fail();
  same(r, a, ['requestId', 'payloadDigest']);
  if (r.originalDaemonKey !== a.daemonKey || r.originalDaemonEpoch !== a.daemonEpoch) fail();
  digest(r.reportingDaemonKey); epoch(r.reportingDaemonEpoch); uuid(r.auditId); digest(r.evidenceDigest);
  return r;
}
// Bounded observation content only. Caller first validates the complete immutable
// graph; no custody, immutable-frame or signature error is caught as quarantine.
export function decodeOwnerDecisionObservationReference(source, graph) {
  try { return reference(source, graph.admission.record, graph.outcome, ['indeterminate']); }
  catch { fail(); }
}

// Trusted constructor enrollment snapshots only: token fields may select an
// already trusted key, never enroll one or invoke a request-selected verifier.
export function createOwnerDecisionLifecycleValidator({ namespaceDigest, brokerPublicKeys = [], presencePublicKeys = [] }) {
  digest(namespaceDigest);
  const brokers = keyMap(brokerPublicKeys), presenceKeys = keyMap(presencePublicKeys);
  return function validate(records) {
    try {
      if (!(records instanceof Map) || records.size > CAPS.size) fail();
      const slots = new Map();
      for (const [name, source] of records) {
        if (!CAPS.has(name)) fail();
        const bytes = Buffer.from(snapshotOwnerDecisionBytes(source));
        if (bytes.length > CAPS.get(name)) fail(); slots.set(name, bytes);
      }
      if (!slots.has('original-action') || !slots.has('acceptance')) fail();
      const admission = validateOwnerDecisionAdmission(slots.get('original-action'), slots.get('acceptance'), namespaceDigest);
      const a = admission.record;
      const saved = { originalActionBytes: slots.get('original-action'), acceptedAt: a.acceptedAt,
        daemonKey: a.daemonKey, daemonEpoch: a.daemonEpoch, watchId: a.watchId };
      const json = name => slots.has(name) ? decodeOwnerDecisionCanonical(slots.get(name)) : null;
      const prepared = slots.has('prepared-challenge') ? decodeOwnerDecisionPrepared(slots.get('prepared-challenge'), saved) : null;
      if (!prepared && ['presence', 'receipt', 'authorization', 'release'].some(name => slots.has(name))) fail();
      const presenceToken = slots.has('presence') ? token(slots.get('presence')) : null;
      const receiptToken = slots.has('receipt') ? token(slots.get('receipt')) : null;
      if (receiptToken && !presenceToken) fail();
      let proof = null, historicalClock = null, proofKeys = null;
      if (presenceToken && !receiptToken) {
        // A legitimate crash can retain p1 before d1. Verify that standalone
        // prefix with the bot-owned p1 semantics; never call it authorized.
        const parts = presenceToken.split('.');
        if (parts.length !== 3 || parts[0] !== 'p1') fail();
        const hint = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (!integer(hint?.iat)) fail();
        const clock = Math.max(hint.iat, 0, a.acceptedAt - 30, prepared.challenge.preparedAt - 30) * 1000;
        if (!integer(clock) || clock / 1000 >= prepared.challenge.exp) fail();
        let verified = false;
        for (const key of presenceKeys.values()) {
          try {
            const p = verifyPresence(presenceToken, { key: Buffer.from(key.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
              action: prepared.actionText, nonce: prepared.challenge.nonce, now: clock });
            if (integer(p.iat) && integer(p.exp) && p.iat >= Math.max(0, prepared.challenge.preparedAt - 30)) verified = true;
          } catch { /* Try only the next independently pinned historical key. */ }
          if (verified) break;
        }
        if (!verified) fail();
      }
      if (receiptToken) {
        const parts = receiptToken.split('.'); if (parts.length !== 3 || parts[0] !== 'd1') fail();
        // Bounded canonical peek is untrusted until signature/key validation.
        const hint = decodeOwnerDecisionCanonical(Buffer.from(parts[1], 'base64url'));
        const brokerPublicKey = brokers.get(hint?.brokerKey); if (!brokerPublicKey || !integer(hint.iat)) fail();
        historicalClock = Math.max(hint.iat, 0, a.acceptedAt - 30, prepared.challenge.preparedAt - 30) * 1000;
        if (!integer(historicalClock)) fail();
        const receipt = verifySignedOwnerDecisionReceipt(receiptToken, { brokerPublicKey, nowMilliseconds: historicalClock });
        const presencePublicKey = presenceKeys.get(receipt.payload.presenceKey); if (!presencePublicKey) fail();
        proofKeys = { brokerPublicKey, presencePublicKey };
        proof = verifyOwnerDecisionProof({ challengeBytes: prepared.challengeBytes, saved: { ...saved,
          ...(prepared.wrapper.stage === null ? {} : { stageExpiresAt: prepared.wrapper.stage.expiresAt }) },
        receiptToken, presenceToken, brokerPublicKey, presencePublicKey, nowMilliseconds: historicalClock });
      }
      const authorization = json('authorization');
      if (authorization) {
        if (!proof) fail();
        exact(authorization, ['v', 'kind', 'requestId', 'payloadDigest', 'nonce', 'actionDigest', 'challengeDigest',
          'presenceDigest', 'receiptDigest', 'exp', 'daemonKey', 'daemonEpoch', 'watchId']);
        if (authorization.v !== 1 || authorization.kind !== 'authorization'
            || authorization.actionDigest !== hash(proof.actionText) || authorization.challengeDigest !== hash(prepared.challengeBytes)
            || authorization.presenceDigest !== proof.presenceDigest || authorization.receiptDigest !== proof.receiptDigest
            || authorization.exp !== proof.receipt.exp || authorization.nonce !== prepared.challenge.nonce) fail();
        same(authorization, a, ['requestId', 'payloadDigest', 'daemonKey', 'daemonEpoch', 'watchId']);
      }
      const release = json('release');
      if (release) {
        if (!authorization) fail();
        exact(release, ['requestId', 'payloadDigest', 'receiptDigest', 'daemonKey', 'daemonEpoch', 'watchId', 'state', 'mayApply', 'exp']);
        if (release.state !== 'released' || release.mayApply !== true || release.exp !== authorization.exp
            || release.receiptDigest !== authorization.receiptDigest) fail();
        same(release, a, ['requestId', 'payloadDigest', 'daemonKey', 'daemonEpoch', 'watchId']);
      }
      const outcome = json('initial-outcome');
      if (outcome) {
        exact(outcome, ['v', 'kind', 'requestId', 'payloadDigest', 'state', 'receiptDigest', 'outcome', 'source',
          'reportingDaemonKey', 'reportingDaemonEpoch', 'at']);
        if (outcome.v !== 1 || outcome.kind !== 'outcome' || !Object.hasOwn(CODES, outcome.state)
            || !integer(outcome.at) || !['broker', 'daemon'].includes(outcome.source)) fail();
        same(outcome, a, ['requestId', 'payloadDigest']); exact(outcome.outcome, ['code', 'effectDigest']);
        if (!CODES[outcome.state].includes(outcome.outcome.code)) fail();
        if (outcome.outcome.effectDigest !== null) digest(outcome.outcome.effectDigest);
        if (outcome.receiptDigest !== (proof?.receiptDigest ?? null)) fail();
        if (outcome.source === 'broker') {
          if (outcome.reportingDaemonKey !== null || outcome.reportingDaemonEpoch !== null
              || outcome.outcome.effectDigest !== null || outcome.state === 'applied'
              || (release && outcome.state !== 'indeterminate')) fail();
        } else {
          same(outcome, { reportingDaemonKey: a.daemonKey, reportingDaemonEpoch: a.daemonEpoch },
            ['reportingDaemonKey', 'reportingDaemonEpoch']);
          if (['cancelled', 'expired'].includes(outcome.state)) fail();
        }
        if (['cancelled', 'expired'].includes(outcome.state) && authorization) fail();
        if (['applied', 'indeterminate'].includes(outcome.state) && !release) fail();
        if (outcome.state === 'applied' && outcome.outcome.effectDigest === null) fail();
      }
      const observation = slots.has('observation-reference')
        ? reference(slots.get('observation-reference'), a, outcome, ['indeterminate']) : null;
      const resolution = slots.has('terminal-reference')
        ? reference(slots.get('terminal-reference'), a, outcome, ['applied', 'refused']) : null;
      const state = resolution?.finding ?? outcome?.state ?? (release ? 'released' : authorization ? 'authorized' : prepared ? 'prepared' : 'preparing');
      return { slots, admission, saved, prepared, presenceToken, receiptToken, proof, proofKeys, historicalClock, authorization,
        release, outcome, observation, resolution, state, proofIncomplete: Boolean(presenceToken && !authorization),
        authorizationSupported: false, physicalAllocationSupported: false };
    } catch { fail(); }
  };
}
