// Pairing, account and principal authentication, and soul membership.

import { createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import path from 'node:path';

import { consumePairingProof } from '../platform/account-isolation.mjs';
import { fail } from '../errors.mjs';
import { sha256 } from './shared.mjs';

const ACCOUNT = /^[a-z_][a-z0-9_.-]{0,63}$/i;
const AGENT_ID = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRINCIPAL = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export { systemUidOf } from '../platform/account-isolation.mjs';

function pairingCode() {
  const bytes = randomBytes(6);
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function sameSecret(hash, secret) {
  const presented = Buffer.from(sha256(String(secret ?? '')), 'hex');
  const stored = Buffer.from(hash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

// A grant names accounts, souls, or addresses, exactly like a soul's join
// allowlist. Null is the owner's default and covers every soul (ADR-0007
// decision 1); anything narrower hides the rows it does not name.
function grantList(grant) {
  if (grant === null) return null;
  if (!Array.isArray(grant) || grant.some((entry) => typeof entry !== 'string' || entry.length > 200)) {
    fail('bad-request', 'grant must be a list of accounts, souls, or addresses');
  }
  return grant;
}

export function createPairing(broker, commit, watches) {
  function authenticateAccount(request, { allowPending = false } = {}) {
    if (request.auth?.daemon !== undefined) fail('unauthenticated', 'a daemon credential cannot act for an account');
    const { account, secret } = request.auth ?? {};
    const pairing = typeof account === 'string' ? broker.state.pairings.get(account) : undefined;
    if (!pairing || !sameSecret(pairing.hash, secret)) fail('unauthenticated', 'this account is not paired with the broker');
    if (pairing.state !== 'approved' && !allowPending) fail('not-approved', 'the owner has not approved this pairing yet');
    return { account, pairing };
  }

  // Only the daemon operation dispatcher uses this credential kind.
  function authenticateDaemon(request) {
    const { daemon: account, secret } = request.auth ?? {};
    const pairing = broker.state.daemons.get(account);
    if (request.auth?.account !== undefined || request.auth?.principal !== undefined
      || broker.state.pairings.get(account)?.state !== 'approved'
      || pairing?.state !== 'approved' || !sameSecret(pairing.hash, secret)) {
      fail('unauthenticated', 'this daemon is not approved');
    }
    return { account, pairing };
  }

  function verifySoulToken(account, agentId, token) {
    if (token === undefined) {
      if (broker.state.hardened.has(account)) fail('unverified', 'this account requires a soul token');
      return 'claimed';
    }
    try {
      const daemon = broker.state.daemons.get(account);
      if (daemon?.state !== 'approved' || typeof token !== 'string') throw new Error();
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== 'v1'
        || !parts.slice(1).every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      // Signatures cover the ASCII payload segment exactly as it appears in the token.
      const data = Buffer.from(parts[1], 'base64url');
      const signature = Buffer.from(parts[2], 'base64url');
      if (data.toString('base64url') !== parts[1] || signature.toString('base64url') !== parts[2]
        || !verify(null, Buffer.from(parts[1], 'ascii'), daemon.publicKey, signature)) throw new Error();
      const payload = JSON.parse(data.toString('utf8'));
      const now = broker.now() / 1000;
      if (payload.v !== 1 || payload.aud !== 'agent-comms'
        || payload.account !== account || payload.agentId !== agentId
        || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
        || payload.exp < now - 30 || payload.iat > now + 30
        || payload.exp < payload.iat || payload.exp - payload.iat > 300) throw new Error();
      return 'verified';
    } catch {
      fail('soul-token-invalid', 'the soul token is invalid');
    }
  }

  // A principal is the owner's human credential, separate from any account
  // (ADR-0006 decision 8). It authenticates reads only: no operation that
  // needs a soul accepts it, because none of them look at this map.
  function authenticatePrincipal(request) {
    const { principal, secret } = request.auth ?? {};
    const pairing = typeof principal === 'string' && PRINCIPAL.test(principal)
      ? broker.state.principals.get(principal) : undefined;
    if (!pairing || !sameSecret(pairing.hash, secret)) fail('unauthenticated', 'this principal is not paired with the broker');
    if (pairing.state !== 'approved') fail('not-approved', 'the owner has not approved this principal yet');
    return { principal, pairing };
  }

  // Daemon reports need ownership only; soul requests additionally verify a token.
  function soulForAccount(account, agentId) {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) fail('unbound', 'no valid soul id was supplied');
    const soul = broker.state.souls.get(agentId);
    if (!soul || soul.account !== account) fail('not-joined', 'this soul has not joined the hub from this account');
    return soul;
  }

  function ownSoul(account, agentId, soulToken) {
    const soul = soulForAccount(account, agentId);
    return { ...soul, verification: verifySoulToken(account, agentId, soulToken) };
  }

  function joinedSoul(account, agentId, soulToken) {
    const soul = ownSoul(account, agentId, soulToken);
    if (!soul.joined) fail('not-joined', 'this soul has left the hub');
    return soul;
  }

  // Census and peers show the last successful soul request's verification.
  // Request handlers call this only after validation; messages keep their own snapshot.
  function rememberVerification(soul) {
    if (broker.state.souls.get(soul.agentId)?.verification !== soul.verification) {
      commit({ t: 'soul-verification', agentId: soul.agentId, verification: soul.verification, at: broker.now() });
    }
  }

  function resolve(address) {
    if (typeof address !== 'string') return null;
    const [account, agentId] = address.includes('/') ? address.split('/', 2) : [null, address];
    const soul = broker.state.souls.get(agentId);
    if (!soul || (account !== null && soul.account !== account)) return null;
    return soul;
  }

  function pairRequest({ account, secretHash, proof, publicKey }, kind = 'account') {
    if (typeof account !== 'string' || !ACCOUNT.test(account)) fail('bad-request', 'account name is invalid');
    if (typeof secretHash !== 'string' || !/^[0-9a-f]{64}$/.test(secretHash)) fail('bad-request', 'secretHash is invalid');
    if (typeof proof !== 'string' || path.basename(proof) !== proof || !proof.endsWith('.proof')) {
      fail('bad-request', 'proof must be a file name in the pairing directory');
    }
    const existing = broker.state.pairings.get(account);
    if (kind === 'daemon') {
      if (existing?.state !== 'approved') fail('not-approved', 'the account must be approved first');
      try {
        if (typeof publicKey !== 'string') throw new Error();
        const key = createPublicKey(typeof publicKey === 'string' && publicKey.startsWith('-----BEGIN PUBLIC KEY-----')
          ? publicKey : { key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
        if (key.asymmetricKeyType !== 'ed25519') throw new Error();
        publicKey = key.export({ format: 'pem', type: 'spki' });
      } catch {
        fail('bad-request', 'publicKey must be an Ed25519 SPKI public key');
      }
    }
    if (kind === 'account' && existing?.state === 'approved') fail('already-paired', 'this account is already paired; the owner must revoke it first');

    // The kernel stamps the proof file with its creator's uid, and the sticky
    // directory stops anyone else replacing it, so the uid proves the account.
    const file = path.join(broker.paths.proofs, proof);
    const uid = consumePairingProof(file, account, broker, secretHash);

    const code = pairingCode();
    commit({ t: kind === 'daemon' ? 'daemon-pair-request' : 'pair-request', account, hash: secretHash, uid, code,
      ...(kind === 'daemon' ? { publicKey } : {}), at: broker.now() });
    return { account, code, state: 'pending' };
  }

  // A principal has no OS account for the kernel to vouch for, so a paired
  // account asks for it and its name is recorded: the owner sees who requested
  // the credential before approving it. The broker mints the id, so a caller
  // cannot choose one that collides with or impersonates another.
  function principalRequest(request) {
    const { account } = authenticateAccount(request);
    const { name = null, secretHash } = request;
    if (typeof secretHash !== 'string' || !/^[0-9a-f]{64}$/.test(secretHash)) fail('bad-request', 'secretHash is invalid');
    if (name !== null && (typeof name !== 'string' || name.length > 64)) fail('bad-request', 'name must be a short string');
    const principal = `principal_${randomUUID()}`;
    const code = pairingCode();
    commit({ t: 'principal-request', principal, account, name, hash: secretHash, code, at: broker.now() });
    return { principal, code, state: 'pending' };
  }

  function join(request) {
    const { account } = authenticateAccount(request);
    const { agentId, name = null, harness = null, parent = null, allow = null } = request;
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) fail('unbound', 'no valid soul id was supplied');
    const existing = broker.state.souls.get(agentId);
    if (existing && existing.account !== account) fail('soul-taken', 'another account joined this soul');
    if (parent !== null && (typeof parent !== 'string' || !AGENT_ID.test(parent))) fail('bad-request', 'parent must be a soul id');
    if (allow !== null && (!Array.isArray(allow) || allow.some((entry) => typeof entry !== 'string' || entry.length > 200))) {
      fail('bad-request', 'allow must be a list of accounts, souls, or addresses');
    }
    for (const [field, value] of [['name', name], ['harness', harness]]) {
      if (value !== null && (typeof value !== 'string' || value.length > 64)) fail('bad-request', `${field} must be a short string`);
    }
    const verification = verifySoulToken(account, agentId, request.soulToken);
    commit({ t: 'join', verification, account, agentId, name, harness, parent, allow, at: broker.now() });
    return { address: `${account}/${agentId}`, verification };
  }

  function leave(request) {
    const { account } = authenticateAccount(request);
    const soul = joinedSoul(account, request.agentId, request.soulToken);
    commit({ t: 'leave', account, agentId: soul.agentId, at: broker.now() });
    rememberVerification(soul);
    return { address: `${account}/${soul.agentId}`, joined: false };
  }

  // ---- owner operations, on the private admin socket --------------------

  function handleAdmin(request) {
    switch (request.op) {
      case 'pairings':
        return {
          pairings: [...broker.state.pairings].map(([account, { uid, code, state, at }]) => ({
            account, uid, state, at, hardened: broker.state.hardened.has(account), ...(state === 'pending' ? { code } : {}),
          })).concat([...broker.state.daemons].flatMap(([account, daemon]) =>
            [daemon, daemon.pending].filter(Boolean).map(({ uid, code, state, at }) => ({
              account, kind: 'daemon', uid, state, at, ...(state === 'pending' ? { code } : {}),
            })))),
        };
      case 'approve': {
        const match = [...broker.state.pairings].find(([, pairing]) => pairing.state === 'pending' && pairing.code === request.code);
        if (!match) {
          const daemon = [...broker.state.daemons].find(([, row]) =>
            (row.pending ?? row).state === 'pending' && (row.pending ?? row).code === request.code);
          if (!daemon) fail('unknown-code', 'no pending pairing has that code');
          commit({ t: 'daemon-pair-approve', account: daemon[0], at: broker.now() });
          // A re-pair replaces the key: streams opened with the old one close.
          const watchesClosed = watches.revokeDaemon(daemon[0]);
          return { account: daemon[0], kind: 'daemon', state: 'approved', watchesClosed };
        }
        commit({ t: 'pair-approve', account: match[0], at: broker.now() });
        return { account: match[0], state: 'approved' };
      }
      case 'harden': {
        if (!broker.state.pairings.has(request.account)) fail('unknown-account', 'that account is not paired');
        if (request.off !== undefined && typeof request.off !== 'boolean') fail('bad-request', 'off must be boolean');
        const hardened = request.off !== true;
        commit({ t: 'account-harden', account: request.account, hardened, at: broker.now() });
        if (hardened) watches.revoke(request.account);
        return { account: request.account, hardened };
      }
      case 'revoke': {
        if (request.kind !== undefined && !['account', 'daemon'].includes(request.kind)) fail('bad-request', 'unknown credential kind');
        if (request.kind === 'daemon') {
          if (!broker.state.daemons.has(request.account)) fail('unknown-account', 'that daemon is not paired');
          commit({ t: 'daemon-pair-revoke', account: request.account, at: broker.now() });
          return { account: request.account, kind: 'daemon', state: 'revoked', watchesClosed: watches.revokeDaemon(request.account) };
        }
        if (!broker.state.pairings.has(request.account)) fail('unknown-account', 'that account is not paired');
        commit({ t: 'pair-revoke', account: request.account, at: broker.now() });
        const closed = watches.revoke(request.account);
        return { account: request.account, state: 'revoked', watchesClosed: closed };
      }
      case 'principals':
        return {
          principals: [...broker.state.principals].map(([principal, { name, account, grant, code, state, at }]) => ({
            principal, name, account, grant, state, at, ...(state === 'pending' ? { code } : {}),
          })),
        };
      // Account codes and principal codes are separate spaces, so approving
      // one kind never approves the other.
      case 'principal-approve': {
        const match = [...broker.state.principals].find(([, pairing]) => pairing.state === 'pending' && pairing.code === request.code);
        if (!match) fail('unknown-code', 'no pending principal has that code');
        const grant = grantList(request.grant ?? null);
        commit({ t: 'principal-approve', principal: match[0], grant, at: broker.now() });
        return { principal: match[0], state: 'approved', grant };
      }
      case 'principal-revoke': {
        if (!broker.state.principals.has(request.principal)) fail('unknown-principal', 'that principal is not paired');
        commit({ t: 'principal-revoke', principal: request.principal, at: broker.now() });
        return { principal: request.principal, state: 'revoked' };
      }
      case 'daemon-watches':
        return watches.daemonWatches();
      default:
        return fail('unknown-operation', `unknown admin operation ${request.op}`);
    }
  }

  return {
    account: authenticateAccount,
    daemon: authenticateDaemon,
    verifySoulToken,
    rememberVerification,
    principal: authenticatePrincipal,
    soulForAccount,
    ownSoul,
    joinedSoul,
    resolve,
    pairRequest,
    principalRequest,
    join,
    leave,
    handleAdmin,
  };
}
