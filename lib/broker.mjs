// The machine broker (ADR-0006). One process owns the event log and answers
// paired accounts on a Unix socket in the shared space; the owner approves
// pairings on an admin socket inside the broker's private state directory.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { assertAncestors, assertOwnedDir } from './custody.mjs';
import { CommsError, fail } from './errors.mjs';
import { apply, EventLog } from './state.mjs';
import { lineReader, PROTOCOL_VERSION, writeLine } from './wire.mjs';

export const LIMITS = Object.freeze({
  bodyBytes: 32 * 1024,
  refs: 16,
  refChars: 256,
  readPage: 100,
  unackedPerMailbox: 1000,
  replyDepth: 8,
  sendsPerAccountPerMinute: 120,
  sendsPerPairPerMinute: 30,
  proofMaxAgeMs: 5 * 60 * 1000,
});

const ACCOUNT = /^[a-z_][a-z0-9_.-]{0,63}$/i;
const AGENT_ID = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const KEY = /^[\x21-\x7e]{1,128}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

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

function removeStaleSocket(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return;
  }
  if (!stat.isSocket()) fail('socket-path-occupied', `${file} exists and is not a socket`);
  unlinkSync(file);
}

export class Broker {
  constructor({ paths, gid = null, uidOf = systemUidOf, now = () => Date.now(), limits = LIMITS }) {
    this.paths = paths;
    this.gid = gid;
    this.uidOf = uidOf;
    this.now = now;
    this.limits = limits;
    this.log = new EventLog(paths.state);
    this.state = this.log.replay();
    this.watchers = new Map(); // agentId -> Set of sockets
    this.wakes = new Map(); // message id -> wake outcome, in memory only
    this.sendTimes = new Map(); // rate-limit key -> recent send times
    this.servers = [];
    this.connections = new Set();
  }

  async start() {
    const { shared, proofs, socket, admin, state } = this.paths;
    const uid = process.getuid();
    // Refuse a rendezvous path another account could have planted: check the
    // ancestors and ownership before touching modes, so a foreign directory or
    // symlink stops the broker instead of being adopted.
    mkdirSync(shared, { recursive: true, mode: 0o755 });
    assertAncestors(shared, uid, 'shared-dir-untrusted');
    assertOwnedDir(shared, uid, { code: 'shared-dir-untrusted' });
    chmodSync(shared, 0o755); // no client account may replace the socket
    mkdirSync(proofs, { recursive: true, mode: 0o755 });
    assertOwnedDir(proofs, uid, { code: 'shared-dir-untrusted' });
    chmodSync(proofs, 0o1777);
    assertOwnedDir(state, uid, { code: 'shared-dir-untrusted' });
    chmodSync(state, 0o700);
    removeStaleSocket(socket);
    removeStaleSocket(admin);
    this.servers.push(await this.#listen(socket, (request, client) => this.#handle(request, client), this.gid === null ? 0o600 : 0o660));
    if (this.gid !== null) chownSync(socket, process.getuid(), this.gid);
    this.servers.push(await this.#listen(admin, (request) => this.#handleAdmin(request), 0o600));
    return this;
  }

  async stop() {
    const closing = this.servers.map((server) => new Promise((resolve) => server.close(resolve)));
    for (const socket of this.connections) socket.destroy();
    await Promise.all(closing);
    this.servers = [];
    this.watchers.clear();
  }

  #listen(file, handler, mode) {
    const server = net.createServer((socket) => {
      this.connections.add(socket);
      socket.on('close', () => this.connections.delete(socket));
      let handled = false;
      lineReader(socket, (request) => {
        if (handled) return;
        handled = true;
        try {
          if (request?.v !== PROTOCOL_VERSION) {
            fail('protocol-version', `this broker speaks protocol ${PROTOCOL_VERSION}`);
          }
          const result = handler(request, socket);
          if (result === STREAMING) return;
          writeLine(socket, { ok: true, ...result });
        } catch (error) {
          const code = error instanceof CommsError ? error.code : 'internal';
          const message = error instanceof CommsError ? error.message : 'the broker hit an internal error';
          if (!(error instanceof CommsError)) console.error(error);
          writeLine(socket, { ok: false, error: { code, message } });
        }
        socket.end();
      }, (error) => {
        // Stop reading, flush the refusal, then drop the connection.
        socket.pause();
        socket.end(`${JSON.stringify({ ok: false, error: { code: 'bad-request', message: error.message } })}\n`, () => socket.destroy());
      });
      socket.on('error', () => {});
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(file, () => {
        chmodSync(file, mode);
        resolve(server);
      });
    });
  }

  #commit(record) {
    this.log.append(record);
    apply(this.state, record);
  }

  // ---- authentication -------------------------------------------------

  #account(request, { allowPending = false } = {}) {
    const { account, secret } = request.auth ?? {};
    const pairing = typeof account === 'string' ? this.state.pairings.get(account) : undefined;
    if (!pairing || !sameSecret(pairing.hash, secret)) fail('unauthenticated', 'this account is not paired with the broker');
    if (pairing.state !== 'approved' && !allowPending) fail('not-approved', 'the owner has not approved this pairing yet');
    return { account, pairing };
  }

  #ownSoul(account, agentId) {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) fail('unbound', 'no valid soul id was supplied');
    const soul = this.state.souls.get(agentId);
    if (!soul || soul.account !== account) fail('not-joined', 'this soul has not joined the hub from this account');
    return soul;
  }

  #joinedSoul(account, agentId) {
    const soul = this.#ownSoul(account, agentId);
    if (!soul.joined) fail('not-joined', 'this soul has left the hub');
    return soul;
  }

  #canSend(from, to) {
    if (!to.joined || to.agentId === from.agentId) return false;
    if (this.state.pairings.get(to.account)?.state !== 'approved') return false;
    if (to.allow === null) return true;
    return to.allow.some((entry) => entry === from.account || entry === from.agentId
      || entry === `${from.account}/${from.agentId}`);
  }

  #resolve(address) {
    if (typeof address !== 'string') return null;
    const [account, agentId] = address.includes('/') ? address.split('/', 2) : [null, address];
    const soul = this.state.souls.get(agentId);
    if (!soul || (account !== null && soul.account !== account)) return null;
    return soul;
  }

  // ---- account operations ----------------------------------------------

  #handle(request, socket) {
    switch (request.op) {
      case 'pair-request': return this.#pairRequest(request);
      case 'pair-status': {
        const { account, pairing } = this.#account(request, { allowPending: true });
        return { account, state: pairing.state };
      }
      case 'join': return this.#join(request);
      case 'leave': return this.#leave(request);
      case 'peers': return this.#peers(request);
      case 'send': return this.#send(request);
      case 'read': return this.#read(request);
      case 'ack': return this.#ack(request);
      case 'watch': return this.#watch(request, socket);
      default: return fail('unknown-operation', `unknown operation ${request.op}`);
    }
  }

  #pairRequest({ account, secretHash, proof }) {
    if (typeof account !== 'string' || !ACCOUNT.test(account)) fail('bad-request', 'account name is invalid');
    if (typeof secretHash !== 'string' || !/^[0-9a-f]{64}$/.test(secretHash)) fail('bad-request', 'secretHash is invalid');
    if (typeof proof !== 'string' || path.basename(proof) !== proof || !proof.endsWith('.proof')) {
      fail('bad-request', 'proof must be a file name in the pairing directory');
    }
    const existing = this.state.pairings.get(account);
    if (existing?.state === 'approved') fail('already-paired', 'this account is already paired; the owner must revoke it first');

    // The kernel stamps the proof file with its creator's uid, and the sticky
    // directory stops anyone else replacing it, so the uid proves the account.
    const file = path.join(this.paths.proofs, proof);
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      fail('pairing-proof-invalid', 'the pairing proof file is missing');
    }
    const uid = this.uidOf(account);
    const valid = stat.isFile() && uid !== null && stat.uid === uid
      && this.now() - stat.mtimeMs <= this.limits.proofMaxAgeMs
      && readFileSync(file, 'utf8').trim() === secretHash;
    rmSync(file, { force: true });
    if (!valid) fail('pairing-proof-invalid', 'the pairing proof does not belong to that account');

    const code = pairingCode();
    this.#commit({ t: 'pair-request', account, hash: secretHash, uid, code, at: this.now() });
    return { account, code, state: 'pending' };
  }

  #join(request) {
    const { account } = this.#account(request);
    const { agentId, name = null, harness = null, parent = null, allow = null } = request;
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) fail('unbound', 'no valid soul id was supplied');
    const existing = this.state.souls.get(agentId);
    if (existing && existing.account !== account) fail('soul-taken', 'another account joined this soul');
    if (parent !== null && (typeof parent !== 'string' || !AGENT_ID.test(parent))) fail('bad-request', 'parent must be a soul id');
    if (allow !== null && (!Array.isArray(allow) || allow.some((entry) => typeof entry !== 'string' || entry.length > 200))) {
      fail('bad-request', 'allow must be a list of accounts, souls, or addresses');
    }
    for (const [field, value] of [['name', name], ['harness', harness]]) {
      if (value !== null && (typeof value !== 'string' || value.length > 64)) fail('bad-request', `${field} must be a short string`);
    }
    this.#commit({ t: 'join', account, agentId, name, harness, parent, allow, at: this.now() });
    return { address: `${account}/${agentId}`, verification: 'claimed' };
  }

  #leave(request) {
    const { account } = this.#account(request);
    const soul = this.#joinedSoul(account, request.agentId);
    this.#commit({ t: 'leave', account, agentId: soul.agentId, at: this.now() });
    return { address: `${account}/${soul.agentId}`, joined: false };
  }

  #peers(request) {
    const { account } = this.#account(request);
    const me = this.#joinedSoul(account, request.agentId);
    const peers = [...this.state.souls.values()]
      .filter((soul) => this.#canSend(me, soul))
      .map(({ account: owner, agentId, name, harness, parent }) => ({
        address: `${owner}/${agentId}`, account: owner, agentId, name, harness, parent, verification: 'claimed',
      }));
    return { peers };
  }

  #rateLimit(keys) {
    const now = this.now();
    for (const [key, limit] of keys) {
      const recent = (this.sendTimes.get(key) ?? []).filter((at) => now - at < 60_000);
      if (recent.length >= limit) fail('rate-limited', 'too many messages in the last minute; retry later');
      this.sendTimes.set(key, recent);
    }
    for (const [key] of keys) this.sendTimes.get(key).push(now);
  }

  #send(request) {
    const { account } = this.#account(request);
    const from = this.#joinedSoul(account, request.agentId);
    const { kind = 'message', body, refs = [], correlation = null, replyTo = null, key } = request;
    if (typeof key !== 'string' || !KEY.test(key)) fail('bad-request', 'key must be 1-128 printable ASCII characters');
    if (typeof kind !== 'string' || !KIND.test(kind)) fail('bad-request', 'kind must be a short lowercase word');
    if (typeof body !== 'string' || Buffer.byteLength(body) > this.limits.bodyBytes) {
      fail('message-too-large', `body must be a string of at most ${this.limits.bodyBytes} bytes`);
    }
    if (!Array.isArray(refs) || refs.length > this.limits.refs
      || refs.some((ref) => typeof ref !== 'string' || ref.length > this.limits.refChars)) {
      fail('bad-request', `refs must be at most ${this.limits.refs} strings`);
    }
    if (correlation !== null && (typeof correlation !== 'string' || correlation.length > 128)) {
      fail('bad-request', 'correlation must be a short string');
    }

    // Unknown, departed, and not-allowed recipients look the same, so a send
    // cannot be used to discover souls the sender may not see.
    const to = this.#resolve(request.to);
    if (!to || !this.#canSend(from, to)) fail('unknown-recipient', 'no soul you may message has that address');

    const fingerprint = sha256(JSON.stringify([from.agentId, to.agentId, kind, body, refs, correlation, replyTo]));
    const previous = this.state.idempotency.get(`${account} ${key}`);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('conflict', 'this key was already used for a different message');
      return { messageId: previous.id, duplicate: true, wake: this.wakes.get(previous.id) ?? 'waiting' };
    }

    let depth = 0;
    if (replyTo !== null) {
      const parent = typeof replyTo === 'string' ? this.state.messages.get(replyTo) : undefined;
      if (!parent || parent.to.agentId !== from.agentId) fail('unknown-message', 'replyTo must be a message you received');
      if (parent.from.agentId === from.agentId) fail('reply-to-self', 'a soul may not reply to its own message');
      depth = parent.depth + 1;
      if (depth > this.limits.replyDepth) fail('reply-depth-exceeded', 'this conversation reached the reply-depth limit');
    }

    const acked = this.state.acked.get(to.agentId);
    const unacked = this.state.mailboxes.get(to.agentId).filter((id) => !acked.has(id)).length;
    if (unacked >= this.limits.unackedPerMailbox) fail('mailbox-full', 'the recipient mailbox is full');

    this.#rateLimit([
      [`account ${account}`, this.limits.sendsPerAccountPerMinute],
      [`pair ${from.agentId} ${to.agentId}`, this.limits.sendsPerPairPerMinute],
    ]);

    const message = {
      id: `msg_${randomUUID()}`,
      seq: this.state.seq + 1,
      at: this.now(),
      from: { account, agentId: from.agentId, verification: 'claimed' },
      to: { account: to.account, agentId: to.agentId },
      kind, body, refs, correlation, replyTo, depth,
    };
    this.#commit({ t: 'message', message, key, fingerprint });

    const watchers = this.watchers.get(to.agentId);
    const wake = watchers?.size ? 'warm' : 'waiting';
    this.wakes.set(message.id, wake);
    for (const socket of watchers ?? []) writeLine(socket, { event: 'message', message: { ...message, wake } });
    return { messageId: message.id, seq: message.seq, duplicate: false, wake };
  }

  #unacked(agentId, after = 0) {
    const acked = this.state.acked.get(agentId);
    return this.state.mailboxes.get(agentId)
      .filter((id) => !acked.has(id))
      .map((id) => this.state.messages.get(id))
      .filter((message) => message.seq > after)
      .map((message) => ({ ...message, wake: this.wakes.get(message.id) ?? 'waiting' }));
  }

  #read(request) {
    const { account } = this.#account(request);
    const soul = this.#ownSoul(account, request.agentId);
    const after = request.after ?? 0;
    const limit = request.limit ?? 20;
    if (!Number.isInteger(after) || after < 0) fail('bad-request', 'after must be a cursor from an earlier read');
    if (!Number.isInteger(limit) || limit < 1 || limit > this.limits.readPage) {
      fail('bad-request', `limit must be between 1 and ${this.limits.readPage}`);
    }
    const pending = this.#unacked(soul.agentId, after);
    const messages = pending.slice(0, limit);
    return { messages, cursor: messages.at(-1)?.seq ?? after, remaining: pending.length - messages.length };
  }

  #ack(request) {
    const { account } = this.#account(request);
    const soul = this.#ownSoul(account, request.agentId);
    const { ids } = request;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > this.limits.readPage) fail('bad-request', 'ids must be a non-empty list');
    const mailbox = new Set(this.state.mailboxes.get(soul.agentId));
    for (const id of ids) if (!mailbox.has(id)) fail('unknown-message', `${id} is not in this mailbox`);
    const fresh = ids.filter((id) => !this.state.acked.get(soul.agentId).has(id));
    if (fresh.length) this.#commit({ t: 'ack', agentId: soul.agentId, ids: fresh, at: this.now() });
    return { acknowledged: fresh.length, alreadyAcknowledged: ids.length - fresh.length };
  }

  #watch(request, socket) {
    const { account } = this.#account(request);
    const soul = this.#joinedSoul(account, request.agentId);
    const set = this.watchers.get(soul.agentId) ?? new Set();
    this.watchers.set(soul.agentId, set);
    set.add(socket);
    socket.on('close', () => set.delete(socket));
    writeLine(socket, { event: 'ready', address: `${account}/${soul.agentId}` });
    for (const message of this.#unacked(soul.agentId)) writeLine(socket, { event: 'message', message });
    return STREAMING;
  }

  // ---- owner operations, on the private admin socket --------------------

  #handleAdmin(request) {
    switch (request.op) {
      case 'pairings':
        return {
          pairings: [...this.state.pairings].map(([account, { uid, code, state, at }]) => ({
            account, uid, state, at, ...(state === 'pending' ? { code } : {}),
          })),
        };
      case 'approve': {
        const match = [...this.state.pairings].find(([, pairing]) => pairing.state === 'pending' && pairing.code === request.code);
        if (!match) fail('unknown-code', 'no pending pairing has that code');
        this.#commit({ t: 'pair-approve', account: match[0], at: this.now() });
        return { account: match[0], state: 'approved' };
      }
      case 'revoke': {
        if (!this.state.pairings.has(request.account)) fail('unknown-account', 'that account is not paired');
        this.#commit({ t: 'pair-revoke', account: request.account, at: this.now() });
        // Cut the account off at once (ADR-0006 decision 3): close its open
        // watches now rather than when they next authenticate.
        let closed = 0;
        for (const soul of this.state.souls.values()) {
          if (soul.account !== request.account) continue;
          for (const socket of this.watchers.get(soul.agentId) ?? []) {
            socket.destroy();
            closed += 1;
          }
          this.watchers.delete(soul.agentId);
        }
        return { account: request.account, state: 'revoked', watchesClosed: closed };
      }
      default:
        return fail('unknown-operation', `unknown admin operation ${request.op}`);
    }
  }
}

const STREAMING = Symbol('streaming');
