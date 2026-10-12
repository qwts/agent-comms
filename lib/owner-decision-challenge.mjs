// Disabled pure binding check. Callers must obtain the saved context from their
// custody-checked transport/journal; successful parsing is never authority.
import { decodeOwnerDecisionCanonical, snapshotOwnerDecisionBytes } from './owner-decision-canonical.mjs';
import { decodeOwnerDecisionAction } from './owner-decision-codec.mjs';

const fail = () => { throw new Error('invalid-owner-decision'); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const matches = (pattern, s) => typeof s === 'string' && pattern.exec(s)?.[0] === s;
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const fields = ['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest',
  'action', 'nonce', 'acceptedAt', 'preparedAt', 'exp', 'daemonKey', 'daemonEpoch', 'watchId'];
function plus(n, delta) {
  if (!integer(n) || !integer(n + delta)) fail();
  return n + delta;
}
function decoded(text, size) {
  if (!matches(/^[A-Za-z0-9_-]+$/, text)) fail();
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text || (size !== undefined && bytes.length !== size)) fail();
  return bytes;
}

// challengeBytes are canonical local serialization of the typed challenge,
// not a new wire framing requirement. Never populate saved options from the
// challenge being checked. In particular, stage expiry comes from its saved
// authenticated descriptor, not from the principal or daemon response here.
export function bindOwnerDecisionChallenge(challengeBytes, options = {}) {
  try {
    const { originalActionBytes, acceptedAt, daemonKey, daemonEpoch, watchId,
      stageExpiresAt, nowMilliseconds } = options;
    const original = snapshotOwnerDecisionBytes(originalActionBytes);
    const verified = decodeOwnerDecisionAction(original);
    const challenge = decodeOwnerDecisionCanonical(challengeBytes);
    if (challenge === null || typeof challenge !== 'object' || Array.isArray(challenge)
        || Object.keys(challenge).length !== fields.length
        || fields.some(key => !Object.hasOwn(challenge, key))) fail();
    for (const key of ['requestId', 'principal', 'account', 'soul', 'operation']) {
      if (challenge[key] !== verified.action[key]) fail();
    }
    if (challenge.payloadDigest !== verified.payloadDigest
        || !decoded(challenge.action).equals(Buffer.from(original))) fail();
    decoded(challenge.nonce, 32);
    if (!matches(digest, daemonKey) || !matches(uuid4, watchId)
        || !integer(daemonEpoch) || daemonEpoch === 0
        || challenge.daemonKey !== daemonKey || challenge.daemonEpoch !== daemonEpoch
        || challenge.watchId !== watchId || challenge.acceptedAt !== acceptedAt) fail();
    if (!integer(nowMilliseconds) || !integer(challenge.preparedAt) || !integer(challenge.exp)) fail();
    const now = Math.floor(nowMilliseconds / 1000);
    const acceptedDeadline = plus(acceptedAt, 180);
    const preparedDeadline = plus(challenge.preparedAt, 180);
    if (acceptedAt > plus(now, 30) || challenge.preparedAt < Math.max(0, acceptedAt - 30)
        || challenge.preparedAt > plus(now, 30)) fail();
    const staged = Object.hasOwn(verified.action.parameters, 'stagingId');
    if (staged ? !integer(stageExpiresAt) : stageExpiresAt !== undefined) fail();
    const deadline = Math.min(acceptedDeadline, preparedDeadline, ...(staged ? [stageExpiresAt] : []));
    if (challenge.exp !== deadline || now >= deadline) fail();
    return { challenge, ...verified };
  } catch { fail(); }
}
