// Soul-token v2 signing-key cache (#1196, ADR-0008 amendments): the identity
// service publishes its ES256 keys at <issuer>/.well-known/agent-bot/soul-keys.json.
// The cache is in-memory only; failed refreshes keep the last good keys, so a
// signing-key outage never revokes souls already verifiable.
import { createPublicKey } from 'node:crypto';

import { fail } from '../errors.mjs';

export const DEFAULT_SOUL_TOKEN_ISSUERS = ['https://agents.true-line.ai'];

const BODY_LIMIT_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
// The service serves Cache-Control: max-age=60; scheduled refreshes never run
// closer together than this floor, whatever max-age says.
const MIN_SCHEDULED_REFRESH_MS = 60_000;
const UNKNOWN_KID_THROTTLE_MS = 30_000;

// Issuers normalize to origin form (no path, no trailing slash). https is
// valid anywhere; http is accepted only on loopback, and only when it appears
// in the explicitly configured list — tests pair against a local service.
export function normalizeSoulTokenIssuer(value) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return url.origin;
  return null;
}

// Broker config takes an array or a comma-separated env string; every entry
// must normalize (an http entry is legal only as loopback). The unset case
// is the shipped default.
export function parseSoulTokenIssuers(configured) {
  const list = configured === undefined || configured === null || configured === ''
    ? DEFAULT_SOUL_TOKEN_ISSUERS
    : typeof configured === 'string' ? configured.split(',').map((entry) => entry.trim()).filter(Boolean) : configured;
  if (!Array.isArray(list) || list.length === 0) fail('usage', 'soul token issuers must be a non-empty list');
  return Object.freeze(list.map((entry) => {
    const issuer = normalizeSoulTokenIssuer(entry);
    if (issuer === null) fail('usage', `soul token issuer ${JSON.stringify(entry)} must be an https URL (loopback http for tests only)`);
    return issuer;
  }));
}

export function createSoulKeyStore({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const slots = new Map(); // issuer -> { keys, fetchedAt, expiresAt, lastAttempt, refreshing }
  const slot = (issuer) => {
    let entry = slots.get(issuer);
    if (!entry) { entry = { keys: new Map(), fetchedAt: 0, expiresAt: 0, lastAttempt: 0, refreshing: null }; slots.set(issuer, entry); }
    return entry;
  };

  async function refresh(issuer) {
    const entry = slot(issuer);
    const response = await fetchImpl(`${issuer}/.well-known/agent-bot/soul-keys.json`, {
      redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response?.ok) throw new Error(`soul keys refresh failed for ${issuer}`);
    const text = await response.text();
    if (text.length > BODY_LIMIT_BYTES) throw new Error(`soul keys response exceeds ${BODY_LIMIT_BYTES} bytes`);
    const body = JSON.parse(text);
    if (body?.issuer !== issuer) throw new Error('soul keys issuer does not match the pairing');
    const keys = new Map();
    for (const jwk of body.keys ?? []) {
      if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.alg !== 'ES256' || jwk.use !== 'sig' || typeof jwk.kid !== 'string') continue;
      try { keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* an unparseable key is skipped, not fatal */ }
    }
    if (keys.size === 0) throw new Error('soul keys response carries no usable key');
    const at = now();
    const maxAge = /(?:^|,)\s*max-age=(\d+)/.exec(response.headers?.get?.('cache-control') ?? '');
    entry.keys = keys;
    entry.fetchedAt = at;
    entry.expiresAt = at + Math.max(maxAge ? Number(maxAge[1]) * 1000 : 0, MIN_SCHEDULED_REFRESH_MS);
    entry.lastAttempt = at;
  }

  // Fire-and-forget on a cache miss or unknown kid; at most once per 30 s per
  // issuer, so a hostile token flood cannot hammer the service.
  function requestRefresh(issuer) {
    const entry = slot(issuer);
    if (entry.refreshing || now() - entry.lastAttempt < UNKNOWN_KID_THROTTLE_MS) return;
    entry.lastAttempt = now();
    entry.refreshing = refresh(issuer).catch(() => {}).finally(() => { entry.refreshing = null; });
  }

  return {
    // Synchronous for verification; a miss kicks a throttled background refresh.
    get(issuer, kid) {
      const key = slots.get(issuer)?.keys.get(kid);
      if (key === undefined) requestRefresh(issuer);
      return key;
    },
    // Awaited on broker start and on v2 pairing approval; keeps last good keys.
    refresh,
    // Periodic tick: refresh the issuers whose cached set went stale.
    refreshStale() {
      const at = now();
      return Promise.allSettled([...slots]
        .filter(([, entry]) => entry.expiresAt <= at && !entry.refreshing)
        .map(([issuer]) => refresh(issuer)));
    },
    // Test seam: does an issuer hold any cached key?
    hasKeys(issuer) {
      return (slots.get(issuer)?.keys.size ?? 0) > 0;
    },
  };
}
