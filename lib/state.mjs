// Broker state as an append-only event log (ADR-0004 decision 1).
//
// Every accepted change is one JSON line, fsynced before the broker answers,
// and the in-memory state is a pure fold over those lines. A restart replays
// the log; a torn final line from a crash mid-write is cut off, because the
// broker never acknowledged it.

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync,
} from 'node:fs';
import path from 'node:path';

export function emptyState() {
  return {
    seq: 0,
    pairings: new Map(), // account -> { hash, uid, code, state, at }
    daemons: new Map(), // account -> approved credential and optional pending replacement
    hardened: new Set(), // accounts requiring soul tokens
    principals: new Map(), // principal -> { hash, name, account, code, grant, state, at }
    souls: new Map(), // agentId -> { account, agentId, name, harness, parent, allow, joined, at }
    messages: new Map(), // id -> message
    mailboxes: new Map(), // agentId -> [message id, in seq order]
    acked: new Map(), // agentId -> Set of message ids
    wakes: new Map(), // message id -> wake outcome (ADR-0004 decision 6)
    idempotency: new Map(), // `${account} ${key}` -> { fingerprint, id }
  };
}

export function apply(state, record) {
  switch (record.t) {
    case 'pair-request':
      state.pairings.set(record.account, {
        hash: record.hash, uid: record.uid, code: record.code, state: 'pending', at: record.at,
      });
      break;
    case 'pair-approve': {
      const pairing = state.pairings.get(record.account);
      if (pairing) pairing.state = 'approved';
      break;
    }
    case 'pair-revoke':
      state.pairings.delete(record.account);
      state.daemons.delete(record.account);
      break;
    case 'daemon-pair-request': {
      const pending = { hash: record.hash, publicKey: record.publicKey, uid: record.uid,
        code: record.code, state: 'pending', at: record.at };
      const current = state.daemons.get(record.account);
      if (current?.state === 'approved') current.pending = pending;
      else state.daemons.set(record.account, pending);
      break;
    }
    case 'daemon-pair-approve': {
      const current = state.daemons.get(record.account);
      if (current) state.daemons.set(record.account, { ...(current.pending ?? current), state: 'approved' });
      break;
    }
    case 'daemon-pair-revoke':
      state.daemons.delete(record.account);
      break;
    case 'account-harden':
      if (record.hardened) state.hardened.add(record.account);
      else state.hardened.delete(record.account);
      break;
    case 'principal-request':
      state.principals.set(record.principal, {
        hash: record.hash,
        name: record.name ?? null,
        account: record.account,
        code: record.code,
        grant: null, // the owner states it at approval, never the requester
        state: 'pending',
        at: record.at,
      });
      break;
    case 'principal-approve': {
      const principal = state.principals.get(record.principal);
      if (principal) {
        principal.state = 'approved';
        principal.grant = record.grant ?? null;
      }
      break;
    }
    case 'principal-revoke':
      state.principals.delete(record.principal);
      break;
    case 'join':
      state.souls.set(record.agentId, {
        account: record.account,
        agentId: record.agentId,
        name: record.name ?? null,
        harness: record.harness ?? null,
        parent: record.parent ?? null,
        allow: record.allow ?? null,
        verification: record.verification ?? 'claimed',
        joined: true,
        at: record.at,
      });
      if (!state.mailboxes.has(record.agentId)) state.mailboxes.set(record.agentId, []);
      if (!state.acked.has(record.agentId)) state.acked.set(record.agentId, new Set());
      break;
    case 'soul-verification': {
      const soul = state.souls.get(record.agentId);
      if (soul) soul.verification = record.verification;
      break;
    }
    case 'leave': {
      const soul = state.souls.get(record.agentId);
      if (soul) soul.joined = false;
      break;
    }
    case 'message': {
      const message = record.message;
      state.seq = Math.max(state.seq, message.seq);
      state.messages.set(message.id, message);
      state.mailboxes.get(message.to.agentId)?.push(message.id);
      state.wakes.set(message.id, record.wake ?? 'waiting');
      state.idempotency.set(`${message.from.account} ${record.key}`, {
        fingerprint: record.fingerprint, id: message.id,
      });
      break;
    }
    case 'ack':
      for (const id of record.ids) state.acked.get(record.agentId)?.add(id);
      break;
    case 'wake-outcome':
      // A daemon report overwrites the outcome recorded at send. Ids that
      // are not this soul's message are ignored, the same way the op replies.
      for (const id of record.ids) {
        const message = state.messages.get(id);
        if (message?.to.agentId === record.agentId) state.wakes.set(id, record.outcome);
      }
      break;
    default:
      // An unknown record type means a newer broker wrote this log. Refusing
      // to start beats silently dropping state it does not understand.
      throw new Error(`unknown log record type ${record.t}`);
  }
  return state;
}

export class EventLog {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'events.jsonl');
  }

  replay() {
    const state = emptyState();
    if (!existsSync(this.file)) return state;
    const raw = readFileSync(this.file);
    // The broker answers only after a whole line, newline included, is
    // fsynced, so bytes after the last newline were never acknowledged. Cut
    // them off before anything is appended, or the next line would fuse with
    // them. Work in bytes: a torn tail can end inside a UTF-8 character.
    const end = raw.lastIndexOf(0x0a) + 1;
    if (end < raw.length) truncateSync(this.file, end);
    const lines = raw.subarray(0, end).toString('utf8').split('\n');
    lines.forEach((line, index) => {
      if (!line) return;
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new Error(`event log line ${index + 1} is corrupt: ${error.message}`);
      }
      apply(state, record);
    });
    return state;
  }

  append(record) {
    const fd = openSync(this.file, 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
