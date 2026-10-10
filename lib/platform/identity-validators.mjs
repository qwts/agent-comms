import { createPublicKey } from 'node:crypto';

export const BASE64 = /^[A-Za-z0-9+/]+=*$/;

export const publicKeyFrom = (base64) => {
  if (typeof base64 !== 'string' || !BASE64.test(base64)) throw new Error('not base64');
  const key = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
  return key;
};

export const isEd25519PublicKey = (base64) => {
  try { publicKeyFrom(base64); return true; }
  catch { return false; }
};

export const isWindowsSid = (value) => typeof value === 'string' && /^S-1-\d+(?:-\d+)+$/.test(value);
