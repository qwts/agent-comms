// Disabled receipt producer. No route imports this module. The coordinator must
// supply independently enrolled keys and custody-checked saved preparation,
// recheck current authority, and durably authorize before dispatch. Signing is
// not authorization, release, nonce consumption, or permission to apply.
import { createHash, createPublicKey, KeyObject, sign } from 'node:crypto';
import { snapshotOwnerDecisionBytes } from './owner-decision-canonical.mjs';
import { decodeOwnerDecisionPrepared } from './owner-decision-prepared.mjs';
import { verifyOwnerDecisionProof } from './owner-decision-proof.mjs';
import { verifyPresence } from './vendor/agent-bot-presence/identity-presence.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fail = () => { throw new Error('invalid-owner-decision'); };

export function issueOwnerDecisionReceipt(options = {}) {
  try {
    const { preparedBytes, saved, presenceToken, presencePublicKey, brokerPrivateKey, nowMilliseconds } = options;
    if (!integer(nowMilliseconds) || typeof presenceToken !== 'string' || presenceToken.length > 4096
        || !/^[\x00-\x7f]+$/.test(presenceToken)) fail();
    for (const [key, type] of [[brokerPrivateKey, 'private'], [presencePublicKey, 'public']]) {
      if (!(key instanceof KeyObject) || key.type !== type || key.asymmetricKeyType !== 'ed25519') fail();
    }
    // Snapshot all saved inputs once. Reuse the validated snapshot for final
    // proof composition instead of rereading caller-owned context/accessors.
    const savedSnapshot = { originalActionBytes: snapshotOwnerDecisionBytes(saved.originalActionBytes),
      acceptedAt: saved.acceptedAt, daemonKey: saved.daemonKey, daemonEpoch: saved.daemonEpoch, watchId: saved.watchId };
    const prepared = decodeOwnerDecisionPrepared(preparedBytes, savedSnapshot, nowMilliseconds);
    const c = prepared.challenge;
    const pinnedSaved = { originalActionBytes: Buffer.from(c.action, 'base64url'), acceptedAt: c.acceptedAt,
      daemonKey: c.daemonKey, daemonEpoch: c.daemonEpoch, watchId: c.watchId,
      ...(prepared.wrapper.stage === null ? {} : { stageExpiresAt: prepared.wrapper.stage.expiresAt }) };
    const brokerPublicKey = createPublicKey(brokerPrivateKey);
    const brokerKey = hash(brokerPublicKey.export({ type: 'spki', format: 'der' }));
    const presenceKey = hash(presencePublicKey.export({ type: 'spki', format: 'der' }));
    if (brokerKey === presenceKey || brokerKey === c.daemonKey || presenceKey === c.daemonKey) fail();
    const p = verifyPresence(presenceToken, {
      key: Buffer.from(presencePublicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
      action: prepared.actionText, nonce: c.nonce, now: nowMilliseconds,
    });
    const now = Math.floor(nowMilliseconds / 1000);
    if (!integer(now + 60) || !integer(p.iat) || !integer(p.exp)
        || p.iat < Math.max(0, c.preparedAt - 30)) fail();
    const exp = Math.min(now + 60, c.exp, p.exp);
    if (now >= exp) fail(); // No p1 verifier expiry skew extends a new d1.
    const payload = { v: 1, aud: 'agent-comms-owner-decision', brokerKey,
      requestId: c.requestId, principal: c.principal, account: c.account, soul: c.soul,
      operation: c.operation, payloadDigest: c.payloadDigest, nonce: c.nonce,
      presenceKey, presenceDigest: hash(presenceToken), iat: now, exp };
    // Every payload field is a validated primitive; sort the exact fixed schema.
    const json = `{${Object.keys(payload).sort().map(k => `${JSON.stringify(k)}:${JSON.stringify(payload[k])}`).join(',')}}`;
    const segment = Buffer.from(json, 'utf8').toString('base64url');
    const receiptToken = `d1.${segment}.${sign(null, Buffer.from(segment, 'ascii'), brokerPrivateKey).toString('base64url')}`;
    const proof = verifyOwnerDecisionProof({ challengeBytes: prepared.challengeBytes, saved: pinnedSaved,
      receiptToken, presenceToken, brokerPublicKey, presencePublicKey, nowMilliseconds });
    return { receiptToken, receiptDigest: proof.receiptDigest, payload: proof.receipt };
  } catch { fail(); }
}
