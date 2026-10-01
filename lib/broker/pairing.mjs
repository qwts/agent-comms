// Pairing, account and principal authentication, and soul membership.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { fail } from '../errors.mjs';
import { sha256 } from './shared.mjs';

const ACCOUNT = /^[a-z_][a-z0-9_.-]{0,63}$/i;
const AGENT_ID = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRINCIPAL = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function systemUidOf(account) {
  try {
    return Number(execFileSync('/usr/bin/id', ['-u', account], { encoding: 'utf8' }).trim());
  } catch {
    return null;
  }
}

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
    const { account, secret } = request.auth ?? {};
    const pairing = typeof account === 'string' ? broker.state.pairings.get(account) : undefined;
    if (!pairing || !sameSecret(pairing.hash, secret)) fail('unauthenticated', 'this account is not paired with the broker');
    if (pairing.state !== 'approved' && !allowPending) fail('not-approved', 'the owner has not approved this pairing yet');
    return { account, pairing };
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

  function ownSoul(account, agentId) {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) fail('unbound', 'no valid soul id was supplied');
    const soul = broker.state.souls.get(agentId);
    if (!soul || soul.account !== account) fail('not-joined', 'this soul has not joined the hub from this account');
    return soul;
  }

  function joinedSoul(account, agentId) {
    const soul = ownSoul(account, agentId);
    if (!soul.joined) fail('not-joined', 'this soul has left the hub');
    return soul;
  }

  function resolve(address) {
    if (typeof address !== 'string') return null;
    const [account, agentId] = address.includes('/') ? address.split('/', 2) : [null, address];
    const soul = broker.state.souls.get(agentId);
    if (!soul || (account !== null && soul.account !== account)) return null;
    return soul;
  }

  function pairRequest({ account, secretHash, proof }) {
    if (typeof account !== 'string' || !ACCOUNT.test(account)) fail('bad-request', 'account name is invalid');
    if (typeof secretHash !== 'string' || !/^[0-9a-f]{64}$/.test(secretHash)) fail('bad-request', 'secretHash is invalid');
    if (typeof proof !== 'string' || path.basename(proof) !== proof || !proof.endsWith('.proof')) {
      fail('bad-request', 'proof must be a file name in the pairing directory');
    }
    const existing = broker.state.pairings.get(account);
    if (existing?.state === 'approved') fail('already-paired', 'this account is already paired; the owner must revoke it first');

    // The kernel stamps the proof file with its creator's uid, and the sticky
    // directory stops anyone else replacing it, so the uid proves the account.
    const file = path.join(broker.paths.proofs, proof);
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      fail('pairing-proof-invalid', 'the pairing proof file is missing');
    }
    const uid = broker.uidOf(account);
    const valid = stat.isFile() && uid !== null && stat.uid === uid
      && broker.now() - stat.mtimeMs <= broker.limits.proofMaxAgeMs
      && readFileSync(file, 'utf8').trim() === secretHash;
    rmSync(file, { force: true });
    if (!valid) fail('pairing-proof-invalid', 'the pairing proof does not belong to that account');

    const code = pairingCode();
    commit({ t: 'pair-request', account, hash: secretHash, uid, code, at: broker.now() });
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
    commit({ t: 'join', account, agentId, name, harness, parent, allow, at: broker.now() });
    return { address: `${account}/${agentId}`, verification: 'claimed' };
  }

  function leave(request) {
    const { account } = authenticateAccount(request);
    const soul = joinedSoul(account, request.agentId);
    commit({ t: 'leave', account, agentId: soul.agentId, at: broker.now() });
    return { address: `${account}/${soul.agentId}`, joined: false };
  }

  // ---- owner operations, on the private admin socket --------------------

  function handleAdmin(request) {
    switch (request.op) {
      case 'pairings':
        return {
          pairings: [...broker.state.pairings].map(([account, { uid, code, state, at }]) => ({
            account, uid, state, at, ...(state === 'pending' ? { code } : {}),
          })),
        };
      case 'approve': {
        const match = [...broker.state.pairings].find(([, pairing]) => pairing.state === 'pending' && pairing.code === request.code);
        if (!match) fail('unknown-code', 'no pending pairing has that code');
        commit({ t: 'pair-approve', account: match[0], at: broker.now() });
        return { account: match[0], state: 'approved' };
      }
      case 'revoke': {
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
      default:
        return fail('unknown-operation', `unknown admin operation ${request.op}`);
    }
  }

  return {
    account: authenticateAccount,
    principal: authenticatePrincipal,
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
