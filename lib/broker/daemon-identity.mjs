// The approved daemon's identity as the account watch and the owner-decision
// records carry it (`daemonKey`, 64 lowercase hex). It names the pairing's
// credential, whichever form the daemon paired with (ADR-0276 decision 1):
//
// - a host key pairing: SHA-256 of the Ed25519 public key's DER SPKI
//   (ADR-0077, unchanged);
// - a soul-token v2 pairing: SHA-256 of a domain-separated encoding of the
//   paired issuer and device (ADR-0309). There is no host key to hash, and
//   the device is what the broker binds every v2 token to.
//
// The two can never collide in practice: one hashes a 44-byte DER structure,
// the other a text that starts with the domain label.
import { createHash, createPublicKey } from 'node:crypto';

export const DAEMON_IDENTITY_V2_LABEL = 'agent-comms/daemon-identity/v2';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Issuer is the normalized origin and device the validated id from the pairing
// request; neither can contain a newline, so the encoding is unambiguous.
export function daemonIdentityFromSoulTokens({ issuer, device }) {
  return sha256(Buffer.from(`${DAEMON_IDENTITY_V2_LABEL}\n${issuer}\n${device}`, 'utf8'));
}

// null when the row carries no usable credential; the caller refuses.
export function daemonIdentityKey(daemon) {
  if (daemon?.publicKey != null) {
    let key;
    try { key = createPublicKey(daemon.publicKey); } catch { return null; }
    if (key.asymmetricKeyType !== 'ed25519') return null;
    return sha256(key.export({ type: 'spki', format: 'der' }));
  }
  const soulTokens = daemon?.soulTokens;
  if (soulTokens?.v === 2 && typeof soulTokens.issuer === 'string' && typeof soulTokens.device === 'string'
      && !/[\n\0]/.test(soulTokens.issuer + soulTokens.device) && soulTokens.issuer && soulTokens.device) {
    return daemonIdentityFromSoulTokens(soulTokens);
  }
  return null;
}
