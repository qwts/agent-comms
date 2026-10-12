// Disabled proof composition. No route imports this module. Successful proof
// binding does not check current authority, custody, journal state or release.
import { createHash, KeyObject } from 'node:crypto';
import { verifyPresence } from './vendor/agent-bot-presence/identity-presence.mjs';
import { bindOwnerDecisionChallenge } from './owner-decision-challenge.mjs';
import { verifySignedOwnerDecisionReceipt } from './owner-decision-codec.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const time = value => Number.isSafeInteger(value) && value >= 0;
const fail = () => { throw new Error('invalid-owner-decision'); };

export function verifyOwnerDecisionProof(options = {}) {
  try {
    const { challengeBytes, saved, receiptToken, presenceToken, brokerPublicKey,
      presencePublicKey, nowMilliseconds } = options;
    if (!time(nowMilliseconds) || typeof presenceToken !== 'string' || presenceToken.length > 4096
        || !/^[\x00-\x7f]+$/.test(presenceToken)) fail();
    if (!(presencePublicKey instanceof KeyObject) || presencePublicKey.type !== 'public'
        || presencePublicKey.asymmetricKeyType !== 'ed25519') fail();
    const bound = bindOwnerDecisionChallenge(challengeBytes, { ...saved, nowMilliseconds });
    const signed = verifySignedOwnerDecisionReceipt(receiptToken, { brokerPublicKey, nowMilliseconds });
    for (const key of ['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'nonce']) {
      if (signed.payload[key] !== bound.challenge[key]) fail();
    }
    const presenceKey = hash(presencePublicKey.export({ type: 'spki', format: 'der' }));
    const presenceDigest = hash(presenceToken);
    if (signed.payload.presenceKey !== presenceKey || signed.payload.presenceDigest !== presenceDigest) fail();
    // The fixed bot-owned implementation retains p1 decoding/signature/skew
    // semantics. No caller-supplied function or token-selected key is consulted.
    const presence = verifyPresence(presenceToken, {
      key: Buffer.from(presencePublicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
      action: bound.actionText, nonce: bound.challenge.nonce, now: nowMilliseconds,
    });
    // New d1 binding is stricter about its deadline; it adds no grace beyond
    // either saved preparation or p1 expiry, despite p1's existing verifier skew.
    if (!time(presence.iat) || !time(presence.exp)
        || signed.payload.exp > bound.challenge.exp || signed.payload.exp > presence.exp
        || presence.iat < Math.max(0, bound.challenge.preparedAt - 30)
        || signed.payload.iat < Math.max(0, bound.challenge.preparedAt - 30)
        || signed.payload.iat < Math.max(0, presence.iat - 30)) fail();
    return { ...bound, receipt: signed.payload, receiptDigest: signed.receiptDigest,
      presence: { iat: presence.iat, exp: presence.exp }, presenceKey, presenceDigest };
  } catch { fail(); }
}
