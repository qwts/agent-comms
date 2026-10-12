import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
const f = JSON.parse(readFileSync(new URL('../fixtures/owner-decisions/v1.json', import.meta.url)));
const canonical = v => v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const bytes = v => Buffer.from(canonical(v));
const hash = v => createHash('sha256').update(v).digest('hex');
const publicKey = base64 => createPublicKey({ key: Buffer.from(base64, 'base64'), type: 'spki', format: 'der' });
const namespaceDigest = 'a'.repeat(64), daemonKey = 'b'.repeat(64);
const watchId = '11111111-1111-4111-8111-111111111111';
const config = { namespaceDigest, brokerPublicKeys: [publicKey(f.keys.brokerSpkiBase64)], presencePublicKeys: [publicKey(f.keys.presenceSpkiBase64)] };

export function lifecycleInput(vector = f.positive[0]) {
  const action = JSON.parse(vector.actionJson), iat = vector.receiptPayload.iat;
  const acceptance = { v: 1, kind: 'acceptance', requestId: action.requestId, principal: action.principal,
    account: action.account, soul: action.soul, operation: action.operation, payloadDigest: vector.payloadDigest,
    namespaceDigest, acceptedAt: iat, daemonKey, daemonEpoch: 1, watchId, reservationBytes: 262144 };
  const challenge = { requestId: action.requestId, principal: action.principal, account: action.account, soul: action.soul,
    operation: action.operation, payloadDigest: vector.payloadDigest, action: vector.actionBase64url,
    nonce: vector.receiptPayload.nonce, acceptedAt: iat, preparedAt: iat, exp: iat + 180, daemonKey, daemonEpoch: 1, watchId };
  const p = action.parameters;
  const stage = p.stagingId ? { stagingId: p.stagingId, kind: action.operation === 'cold-wake.set' ? 'webhook' : 'package',
    contentDigest: p.packageDigest ?? p.configurationDigest, expiresAt: iat + 180 } : null;
  const prepared = { v: 1, challenge, stage };
  const authorization = { v: 1, kind: 'authorization', requestId: action.requestId, payloadDigest: vector.payloadDigest,
    nonce: challenge.nonce, actionDigest: hash(vector.actionText), challengeDigest: hash(bytes(challenge)),
    presenceDigest: hash(vector.presenceToken), receiptDigest: vector.receiptDigest, exp: vector.receiptPayload.exp,
    daemonKey, daemonEpoch: 1, watchId };
  const release = { requestId: action.requestId, payloadDigest: vector.payloadDigest, receiptDigest: vector.receiptDigest,
    daemonKey, daemonEpoch: 1, watchId, state: 'released', mayApply: true, exp: authorization.exp };
  const outcome = { v: 1, kind: 'outcome', requestId: action.requestId, payloadDigest: vector.payloadDigest,
    state: 'indeterminate', receiptDigest: vector.receiptDigest, outcome: { code: 'effect-uncertain', effectDigest: null },
    source: 'broker', reportingDaemonKey: null, reportingDaemonEpoch: null, at: iat + 181 };
  const reference = { v: 1, kind: 'reconciliation-reference', requestId: action.requestId, payloadDigest: vector.payloadDigest,
    originalDaemonKey: daemonKey, originalDaemonEpoch: 1, reportingDaemonKey: 'c'.repeat(64), reportingDaemonEpoch: 2,
    at: iat + 1000, finding: 'indeterminate', auditId: watchId, evidenceDigest: 'd'.repeat(64) };
  const slots = new Map([['original-action', Buffer.from(vector.actionJson)], ['acceptance', bytes(acceptance)],
    ['prepared-challenge', bytes(prepared)], ['presence', Buffer.from(vector.presenceToken)], ['receipt', Buffer.from(vector.receiptToken)],
    ['authorization', bytes(authorization)], ['release', bytes(release)], ['initial-outcome', bytes(outcome)],
    ['observation-reference', bytes(reference)], ['terminal-reference', bytes({ ...reference, finding: 'applied' })]]);
  return { vector, action, acceptance, challenge, stage, prepared, authorization, release, outcome, reference, slots };
}

export { f, bytes, hash, namespaceDigest, daemonKey, watchId, config };
