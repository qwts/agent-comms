import { ownerOperationList, validateStoredOwnerOperations } from './owner-operation-grants.mjs';
// Broker state as an append-only event log (ADR-0004 decision 1).
//
// Every accepted change is one JSON line, fsynced before the broker answers,
// and the in-memory state is a pure fold over those lines. A restart replays
// the log; a torn final line from a crash mid-write is cut off, because the
// broker never acknowledged it.

import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { LEGACY_MESSAGE_MS, LEGACY_DEDUPE_MS, mailboxId, mailboxPosition, retain, RETENTION_KEYS, senderNamespace } from './retention.mjs';
import { applyChannelRecord, validateChannelState, validatePostEntry, CHANNEL_ADDRESS, sameEndpoint } from './channel-state.mjs';
import { durableReplace } from './platform/durable-file.mjs';

export function emptyState() {
  return {
    seq: 0,
    originHubId: null,
    channels: new Map(),
    principalChannelGrants: new Map(),
    maintenanceTime: 0,
    outbound: new Map(), // outbound request id -> durable delivery outcome
    tasks: new Map(), // task id -> current revision
    taskInvocations: new Map(), // task id -> invocation id -> execution facts
    taskStreams: new Map(), // task id -> ordered event message ids
    taskEvents: new Map(), // task id -> last five summaries, independent of message retention
    launches: new Map(), // requestId -> authorized target and daemon result
    pairings: new Map(), // account -> { hash, uid, code, state, at }
    daemonEpochs: new Map(), // Retained across revocation; MAX_SAFE_INTEGER is permanently exhausted.
    daemons: new Map(), // account -> approved credential and optional pending replacement
    hardened: new Set(), // accounts requiring soul tokens
    principals: new Map(), // principal -> { hash, name, account, code, grant, state, at }
    souls: new Map(), // agentId -> { account, agentId, name, harness, parent, allow, joined, at }
    messages: new Map(), // id -> message
    mailboxes: new Map(), // soul or principal id -> [message id, in seq order]
    acked: new Map(), // soul or principal id -> Set of message ids
    wakes: new Map(), // message id -> wake outcome (ADR-0004 decision 6)
    idempotency: new Map(), // account or principal namespace + key -> { fingerprint, id }
    mailboxMeta: new Map(), // mailbox -> durable high-water marks and aggregate unread loss
    expired: new Map(), // bounded expired-ID evidence, never message bodies
  };
}

// Reserve the final safe integer for revocation, so exhaustion never prevents
// disabling an existing daemon. An exhausted account can never be approved again.
export function nextDaemonEpoch(state, account) {
  const previous = state.daemonEpochs.get(account) ?? 0;
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER - 1) {
    throw new Error('daemon epoch exhausted');
  }
  return previous + 1;
}

function revokeDaemonEpoch(state, account) {
  if (!state.daemonEpochs.has(account) && !state.daemons.has(account)) return;
  const previous = state.daemonEpochs.get(account) ?? 0;
  if (!Number.isSafeInteger(previous) || previous < 0) throw new Error('invalid daemon epoch');
  state.daemonEpochs.set(account, Math.min(Number.MAX_SAFE_INTEGER, previous + 1));
}

export function apply(state, record) {
  if (record.message && (!Number.isSafeInteger(record.message.seq) || record.message.seq !== state.seq + 1
    || state.messages.has(record.message.id) || state.expired.has(record.message.id))) throw new Error('invalid or reused message sequence/ID');
  if (Number.isSafeInteger(record.at)) state.maintenanceTime = Math.max(state.maintenanceTime, record.at);
  if (applyChannelRecord(state, record)) return state;
  switch (record.t) {
    case 'checkpoint':
      Object.assign(state, restoreCheckpoint(record));
      break;
    case 'maintenance':
      if (!record.policy || RETENTION_KEYS.some((key) => !Number.isSafeInteger(record.policy[key]) || record.policy[key] < 1)) throw new Error('invalid retention policy record');
      retain(state, state.maintenanceTime, record.policy);
      break;
    case 'gap-ack': {
      const position = mailboxPosition(state, record.mailbox);
      position.acknowledgedLoss = record.through;
      position.gap = null;
      break;
    }
    case 'task-invocation': {
      if (!state.taskInvocations.has(record.taskId)) state.taskInvocations.set(record.taskId, new Map());
      const invocations = state.taskInvocations.get(record.taskId);
      const invocation = invocations.get(record.invocationId) ?? {
        invocationId: record.invocationId, agentId: record.agentId, startedAt: null, endedAt: null, outcome: null,
      };
      if (record.phase === 'started') invocation.startedAt = record.at;
      else { invocation.endedAt = record.at; invocation.outcome = record.outcome; }
      invocations.set(record.invocationId, invocation);
      break;
    }
    case 'a2a-outbound':
      state.outbound.set(record.request.id, record.request);
      break;
    case 'task-event': {
      state.tasks.set(record.task.id, record.task);
      if (!state.taskStreams.has(record.task.id)) state.taskStreams.set(record.task.id, []);
      state.taskStreams.get(record.task.id).push(record.message.id);
      state.taskStreams.set(record.task.id, state.taskStreams.get(record.task.id).slice(-5));
      const { revision, previous, state: taskState } = JSON.parse(record.message.body);
      const events = state.taskEvents.get(record.task.id) ?? [];
      events.push({ revision, previous, state: taskState, at: record.message.at });
      state.taskEvents.set(record.task.id, events.slice(-5));
      const message = { ...record.message, expiresAt: record.message.expiresAt ?? record.message.at + LEGACY_MESSAGE_MS };
      state.seq = Math.max(state.seq, message.seq);
      state.maintenanceTime = Math.max(state.maintenanceTime, message.at);
      mailboxPosition(state, mailboxId(message.to)).highWater = message.seq;
      state.messages.set(message.id, message);
      state.mailboxes.get(message.to.principal ?? message.to.agentId)?.push(message.id);
      state.wakes.set(message.id, record.wake);
      break;
    }
    case 'launch-request':
      state.launches.set(record.requestId, { ...record, status: 'pending', agentId: null });
      break;
    case 'launch-progress': {
      const launch = state.launches.get(record.requestId);
      if (launch) launch.stage = record.stage;
      break;
    }
    case 'launch-result':
      Object.assign(state.launches.get(record.requestId), {
        status: record.status, agentId: record.agentId, ...(record.detail ? { detail: record.detail } : {}),
        ...(record.code ? { code: record.code } : {}),
        ...(record.sandbox ? { sandbox: record.sandbox } : {}),
      });
      break;
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
      revokeDaemonEpoch(state, record.account);
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
      if (current) {
        const epoch = nextDaemonEpoch(state, record.account);
        if (record.daemonEpoch !== undefined && record.daemonEpoch !== epoch) throw new Error('invalid daemon epoch transition');
        state.daemonEpochs.set(record.account, epoch);
        state.daemons.set(record.account, { ...(current.pending ?? current), state: 'approved', epoch });
      }
      break;
    }
    case 'daemon-pair-revoke':
      revokeDaemonEpoch(state, record.account);
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
        ownerOperations: [], // No operation authority is inherited from target grants.
        state: 'pending',
        at: record.at,
      });
      if (!state.mailboxes.has(record.principal)) state.mailboxes.set(record.principal, []);
      if (!state.acked.has(record.principal)) state.acked.set(record.principal, new Set());
      break;
    case 'principal-approve': {
      const principal = state.principals.get(record.principal);
      if (principal) {
        principal.state = 'approved';
        principal.grant = record.grant ?? null;
      }
      break;
    }
    case 'principal-owner-grant': {
      const principal = state.principals.get(record.principal);
      if (principal?.state !== 'approved') throw new Error('owner grant requires an approved principal');
      const operations = ownerOperationList(record.operations);
      if (operations.some((value, index) => value !== record.operations[index])) throw new Error('noncanonical owner operation grant');
      principal.ownerOperations = operations;
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
    case 'channel-post': {
      if (!Array.isArray(record.copies) || !record.entry || record.entry.at !== record.at || record.entry.recipient !== record.channel
        || typeof record.key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(record.key)
        || record.copies.length !== record.entry.snapshot?.length || state.idempotency.has(`${record.entry.sender} ${record.key}`)) throw new Error('invalid channel post record');
      // Validate the entire batch before changing any mailbox. A replay is all or none.
      const ids = new Set();
      for (const [index, copy] of record.copies.entries()) {
        const message = copy?.message;
        if (!message || message.seq !== state.seq + index + 1 || !Number.isSafeInteger(message.seq) || ids.has(message.id)
          || state.messages.has(message.id) || state.expired.has(message.id) || !state.mailboxes.has(mailboxId(message.to))
          || !sameEndpoint(message.from, record.entry.from) || typeof message.channelWake !== 'boolean'
          || message.channel !== record.channel || message.postId !== record.entry.id || message.at !== record.at
          || !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= message.at || typeof message.body !== 'string'
          || !Number.isSafeInteger(message.depth) || message.depth < 0 || typeof message.kind !== 'string' || !Array.isArray(message.refs)
          || message.replyTo !== null && typeof message.replyTo !== 'string'
          || JSON.stringify(record.entry.snapshot[index]) !== JSON.stringify({ to: message.to, id: message.id, seq: message.seq, wake: copy.wake, channelWake: message.channelWake })) throw new Error('invalid channel post copy');
        if (index && ['kind', 'body', 'refs', 'correlation', 'replyTo', 'depth', 'expiresAt'].some((key) => JSON.stringify(message[key]) !== JSON.stringify(record.copies[0].message[key]))) throw new Error('inconsistent channel post content');
        ids.add(message.id);
      }
      const prospective = { ...state, seq: state.seq + record.copies.length };
      validatePostEntry(prospective, record.entry);
      for (const { message, wake } of record.copies) {
        state.seq = message.seq;
        state.messages.set(message.id, message);
        state.mailboxes.get(mailboxId(message.to)).push(message.id);
        mailboxPosition(state, mailboxId(message.to)).highWater = message.seq;
        state.wakes.set(message.id, wake);
      }
      state.idempotency.set(`${record.entry.sender} ${record.key}`, record.entry);
      break;
    }
    case 'message': {
      const message = { ...record.message, expiresAt: record.message.expiresAt ?? record.message.at + LEGACY_MESSAGE_MS };
      state.seq = Math.max(state.seq, message.seq);
      state.maintenanceTime = Math.max(state.maintenanceTime, message.at);
      mailboxPosition(state, mailboxId(message.to)).highWater = message.seq;
      state.messages.set(message.id, message);
      state.mailboxes.get(message.to.principal ?? message.to.agentId)?.push(message.id);
      state.wakes.set(message.id, record.wake ?? 'waiting');
      state.idempotency.set(`${senderNamespace(message.from)} ${record.key}`, {
        ...(record.operation === undefined ? {} : { operation: record.operation }),
        fingerprint: record.fingerprint, id: message.id, at: message.at,
        expiresAt: record.dedupeExpiresAt ?? message.at + LEGACY_DEDUPE_MS,
        sender: senderNamespace(message.from), recipient: mailboxId(message.to),
        ...(record.requestedTo === undefined ? {} : { requestedTo: record.requestedTo }),
        outcome: { messageId: message.id, seq: message.seq, wake: record.wake ?? 'waiting' },
      });
      break;
    }
    case 'ack':
      for (const id of record.ids) state.acked.get(record.principal ?? record.agentId)?.add(id);
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

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function snapshotOf(state) {
  const snapshot = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === 'taskInvocations') snapshot[key] = [...value].map(([id, entries]) => [id, [...entries]]);
    else if (key === 'acked') snapshot[key] = [...value].map(([id, entries]) => [id, [...entries]]);
    else snapshot[key] = value instanceof Map || value instanceof Set ? [...value] : value;
  }
  return snapshot;
}

function entries(value, name) {
  if (!Array.isArray(value) || value.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
    || new Set(value.map(([key]) => key)).size !== value.length) throw new Error(`invalid checkpoint collection ${name}`);
  return value;
}

function restoreCheckpoint(record) {
  if (![1, 2, 3].includes(record.version)) throw new Error(`unsupported checkpoint version ${record.version}`);
  const snapshot = record.snapshot;
  if (!snapshot || record.checksum !== digest(snapshot)) throw new Error('checkpoint checksum mismatch');
  const state = emptyState();
  const newFields = ['originHubId', 'channels', 'principalChannelGrants'];
  const included = key => !(record.version === 1 && newFields.includes(key)) && !(record.version < 3 && key === 'daemonEpochs');
  const fields = Object.keys(state).filter(included);
  if (Object.keys(snapshot).sort().join() !== fields.sort().join()) throw new Error('invalid checkpoint fields');
  for (const [key, initial] of Object.entries(state)) {
    if (!included(key)) continue;
    const value = snapshot[key];
    if (key === 'originHubId') { state[key] = value; continue; }
    if (key === 'taskInvocations') state[key] = new Map(entries(value, key).map(([id, items]) => [id, new Map(entries(items, key))]));
    else if (key === 'acked') {
      state[key] = new Map(entries(value, key).map(([id, ids]) => {
        if (!Array.isArray(ids) || ids.some((item) => typeof item !== 'string')) throw new Error('invalid checkpoint receipts');
        return [id, new Set(ids)];
      }));
    } else if (initial instanceof Map) state[key] = new Map(entries(value, key));
    else if (initial instanceof Set) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`invalid checkpoint set ${key}`);
      state[key] = new Set(value);
    } else {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid checkpoint scalar ${key}`);
      state[key] = value;
    }
  }
  const safe = (value) => Number.isSafeInteger(value) && value >= 0;
  const endpoints = (value) => value && ((typeof value.principal === 'string' && value.agentId === undefined)
    || (typeof value.agentId === 'string' && typeof value.account === 'string' && value.principal === undefined));
  // Legacy checkpoints predate owner receipts. Establish a baseline only for
  // their currently approved daemons; do not pretend discarded history is known.
  if (record.version < 3) {
    for (const [account, daemon] of state.daemons) {
      if (daemon.state === 'approved') { state.daemonEpochs.set(account, 1); state.daemons.set(account, { ...daemon, epoch: 1 }); }
    }
  }
  for (const [account, epoch] of state.daemonEpochs) {
    if (/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.exec(account)?.[0] !== account || !Number.isSafeInteger(epoch) || epoch < 1) {
      throw new Error('invalid checkpoint daemon epoch');
    }
  }
  for (const [account, daemon] of state.daemons) {
    if (daemon.state === 'approved' && (daemon.epoch !== state.daemonEpochs.get(account)
        || !Number.isSafeInteger(daemon.epoch) || daemon.epoch < 1 || daemon.epoch >= Number.MAX_SAFE_INTEGER)) {
      throw new Error('invalid checkpoint approved daemon epoch');
    }
  }
  for (const principal of state.principals.values()) validateStoredOwnerOperations(principal);
  validateChannelState(state);
  const sequences = new Set();
  for (const [id, message] of state.messages) {
    if (message?.id !== id || !safe(message.seq) || !message.seq || message.seq > state.seq || sequences.has(message.seq)
      || !safe(message.at) || message.at > state.maintenanceTime || !endpoints(message.to) || !endpoints(message.from)
      || !safe(message.expiresAt) || message.expiresAt <= message.at || typeof message.body !== 'string' || !safe(message.depth)) {
      throw new Error('invalid checkpoint message');
    }
    if (message.channel !== undefined && (!CHANNEL_ADDRESS.test(message.channel) || !state.channels.has(message.channel)
      || typeof message.postId !== 'string' || !/^post_/.test(message.postId) || typeof message.channelWake !== 'boolean')) throw new Error('invalid checkpoint channel copy');
    sequences.add(message.seq);
  }
  const members = new Set();
  for (const [recipient, ids] of state.mailboxes) {
    if (!Array.isArray(ids)) throw new Error('invalid checkpoint mailbox');
    let previous = 0;
    for (const id of ids) {
      const message = state.messages.get(id);
      if (!message || mailboxId(message.to) !== recipient || message.seq <= previous || members.has(id)) throw new Error('invalid checkpoint mailbox reference');
      members.add(id); previous = message.seq;
    }
    for (const id of state.acked.get(recipient) ?? []) if (!ids.includes(id)) throw new Error('invalid checkpoint receipt reference');
    if (ids.length && !state.mailboxMeta.has(recipient)) throw new Error('missing checkpoint mailbox position');
  }
  if (members.size !== state.messages.size) throw new Error('checkpoint has orphan messages');
  for (const [recipient, position] of state.mailboxMeta) {
    if (!state.mailboxes.has(recipient) || !position || !['highWater', 'expiredThrough', 'totalLoss', 'acknowledgedLoss'].every((key) => safe(position[key]))
      || position.highWater > state.seq || position.expiredThrough > position.highWater || position.acknowledgedLoss > position.totalLoss
      || (state.mailboxes.get(recipient).some((id) => state.messages.get(id).seq > position.highWater))) throw new Error('invalid checkpoint mailbox position');
    const gap = position.gap;
    if (gap === null) {
      if (position.totalLoss !== position.acknowledgedLoss) throw new Error('missing checkpoint loss notice');
    } else if (!gap || ![gap.count, gap.firstSeq, gap.lastSeq].every(safe) || !gap.count || !gap.firstSeq
      || gap.count !== position.totalLoss - position.acknowledgedLoss || gap.firstSeq > gap.lastSeq
      || gap.lastSeq > position.expiredThrough) throw new Error('invalid checkpoint loss notice');
  }
  for (const [id, evidence] of state.expired) {
    const position = evidence && state.mailboxMeta.get(mailboxId(evidence.to ?? {}));
    if (!evidence || evidence.id !== id || state.messages.has(id) || !endpoints(evidence.to) || !endpoints(evidence.from)
      || !safe(evidence.seq) || !evidence.seq || evidence.seq > state.seq || sequences.has(evidence.seq) || !position
      || evidence.seq > position.expiredThrough || !safe(evidence.depth) || !safe(evidence.expiredAt) || evidence.expiredAt > state.maintenanceTime
      || !safe(evidence.expiresAt) || evidence.expiresAt <= evidence.expiredAt) throw new Error('invalid checkpoint expired evidence');
    sequences.add(evidence.seq);
  }
  for (const [key, entry] of state.idempotency) {
    if (entry?.operation === 'channel-post') {
      if (!key.startsWith(`${entry.sender} `)) throw new Error('invalid checkpoint dedupe namespace');
      validatePostEntry(state, entry); continue;
    }
    const outcome = entry?.outcome;
    if (!entry || (entry.operation !== undefined && entry.operation !== 'send') || typeof entry.sender !== 'string' || !key.startsWith(`${entry.sender} `) || typeof entry.recipient !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || typeof entry.id !== 'string' || !safe(entry.at) || entry.at > state.maintenanceTime
      || !safe(entry.expiresAt) || entry.expiresAt <= entry.at || !outcome || outcome.messageId !== entry.id || !safe(outcome.seq) || !outcome.seq || outcome.seq > state.seq
      || !['warm', 'cold', 'waiting', 'failed'].includes(outcome.wake)
      || (state.messages.has(entry.id) && (state.messages.get(entry.id).seq !== outcome.seq || mailboxId(state.messages.get(entry.id).to) !== entry.recipient))) throw new Error('invalid checkpoint dedupe outcome');
  }
  for (const [taskId, ids] of state.taskStreams) {
    if (!Array.isArray(ids) || ids.length > 5 || !state.tasks.has(taskId)
      || ids.some((id) => state.messages.get(id)?.kind !== 'task-event' || state.messages.get(id)?.correlation !== taskId)) throw new Error('invalid checkpoint task reference');
  }
  for (const [taskId, events] of state.taskEvents) {
    if (!state.tasks.has(taskId) || !Array.isArray(events) || events.length > 5 || events.some((event) => !safe(event?.revision)
      || !event.revision || !safe(event.at) || typeof event.state !== 'string')) throw new Error('invalid checkpoint task summary');
  }
  return state;
}

export class EventLog {
  constructor(dir, { io = fs, fault = () => {} } = {}) {
    this.io = io;
    this.fault = fault;
    this.poisoned = false;
    this.tailBytes = 0;
    io.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'events.jsonl');
  }

  replay() {
    const state = emptyState();
    this.tailBytes = 0;
    if (!this.io.existsSync(this.file)) return state;
    const raw = this.io.readFileSync(this.file);
    // The broker answers only after a whole line, newline included, is
    // fsynced, so bytes after the last newline were never acknowledged. Cut
    // them off before anything is appended, or the next line would fuse with
    // them. Work in bytes: a torn tail can end inside a UTF-8 character.
    const end = raw.lastIndexOf(0x0a) + 1;
    const lines = raw.subarray(0, end).toString('utf8').split('\n');
    lines.forEach((line, index) => {
      if (!line) return;
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new Error(`event log line ${index + 1} is corrupt: ${error.message}`);
      }
      if (record.t === 'checkpoint' && index !== 0) throw new Error('checkpoint must be the first event log record');
      apply(state, record);
      this.tailBytes = record.t === 'checkpoint' ? 0 : this.tailBytes + Buffer.byteLength(line) + 1;
    });
    // Validate committed history before changing any bytes. Unsupported or
    // corrupt complete data must leave even a torn suffix untouched.
    if (end < raw.length) {
      let fd;
      try {
        fd = this.io.openSync(this.file, 'r+');
        this.io.ftruncateSync(fd, end);
        this.io.fsyncSync(fd);
      } catch (error) { this.poisoned = true; throw error; }
      finally { if (fd !== undefined) this.io.closeSync(fd); }
    }
    return state;
  }

  append(record) {
    this.assertWritable();
    let fd;
    let temporary;
    try {
      const exists = this.io.existsSync(this.file);
      temporary = exists ? undefined : `${this.file}.${randomUUID()}.tmp`;
      fd = this.io.openSync(temporary ?? this.file, exists ? 'a' : 'wx', 0o600);
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
      this.writeAll(fd, bytes);
      this.io.fsyncSync(fd);
      this.io.closeSync(fd); fd = undefined;
      if (!exists) durableReplace(temporary, this.file, { io: this.io, fault: this.fault });
      this.tailBytes += bytes.length;
    } catch (error) {
      this.poisoned = true;
      throw error;
    } finally {
      if (fd !== undefined) this.io.closeSync(fd);
      if (temporary) { try { this.io.rmSync(temporary, { force: true }); } catch { /* Abandoned staging files are not recovery inputs. */ } }
    }
  }

  assertWritable() {
    if (this.poisoned) throw new Error('event log writer is poisoned; restart and recover before accepting writes');
  }

  writeAll(fd, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const written = this.io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(written) || written <= 0) throw new Error('event log write made no progress');
      offset += written;
    }
  }

  compact(state) {
    this.assertWritable();
    const snapshot = snapshotOf(state);
    const record = { t: 'checkpoint', version: 3, snapshot, checksum: digest(snapshot) };
    try { restoreCheckpoint(record); } catch (error) { this.poisoned = true; throw error; }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = this.io.openSync(temporary, 'wx', 0o600);
      this.writeAll(fd, Buffer.from(`${JSON.stringify(record)}\n`));
      this.fault('before-temp-fsync');
      this.io.fsyncSync(fd);
      this.fault('after-temp-fsync');
      this.io.closeSync(fd); fd = undefined;
      this.fault('before-replace');
      durableReplace(temporary, this.file, { io: this.io, fault: this.fault });
      this.tailBytes = 0;
    } catch (error) {
      this.poisoned = true;
      throw error;
    } finally {
      if (fd !== undefined) this.io.closeSync(fd);
      try { this.io.rmSync(temporary, { force: true }); } catch { /* Never select an abandoned temporary file on recovery. */ }
    }
  }
}
