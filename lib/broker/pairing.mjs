// Pairing, account authentication, and soul membership.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { fail } from '../errors.mjs';
import { sha256 } from './shared.mjs';

const ACCOUNT = /^[a-z_][a-z0-9_.-]{0,63}$/i;
const AGENT_ID = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

export function createPairing(broker, commit, watches) {
  function authenticateAccount(request, { allowPending = false } = {}) {
    const { account, secret } = request.auth ?? {};
    const pairing = typeof account === 'string' ? broker.state.pairings.get(account) : undefined;
    if (!pairing || !sameSecret(pairing.hash, secret)) fail('unauthenticated', 'this account is not paired with the broker');
    if (pairing.state !== 'approved' && !allowPending) fail('not-approved', 'the owner has not approved this pairing yet');
    return { account, pairing };
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
      default:
        return fail('unknown-operation', `unknown admin operation ${request.op}`);
    }
  }

  return { account: authenticateAccount, ownSoul, joinedSoul, resolve, pairRequest, join, leave, handleAdmin };
}
