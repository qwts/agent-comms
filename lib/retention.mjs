// Deterministic retention fold. Policy and time are in the durable record,
// never read from the process clock while replaying.
export const RETENTION_KEYS = Object.freeze([
  'messageRetentionMs', 'dedupeRetentionMs', 'referenceRetentionMs',
  'expiredPerMailbox', 'expiredBytesPerMailbox',
]);

export const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(value));
export const mailboxId = (endpoint) => endpoint.principal ?? endpoint.agentId;
export const senderNamespace = (endpoint) => endpoint.principal ? `principal ${endpoint.principal}` : endpoint.account;
export const LEGACY_MESSAGE_MS = 30 * 24 * 60 * 60 * 1000;
export const LEGACY_DEDUPE_MS = 7 * 24 * 60 * 60 * 1000;

export function nextExpiry(state) {
  let next = Infinity;
  for (const message of state.messages.values()) next = Math.min(next, message.expiresAt);
  for (const entry of state.idempotency.values()) next = Math.min(next, entry.expiresAt);
  for (const evidence of state.expired.values()) next = Math.min(next, evidence.expiresAt);
  return next;
}

export function mailboxPosition(state, id) {
  let position = state.mailboxMeta.get(id);
  if (!position) {
    position = { highWater: 0, expiredThrough: 0, totalLoss: 0, acknowledgedLoss: 0, gap: null };
    state.mailboxMeta.set(id, position);
  }
  return position;
}

export function lossDetails(state, id) {
  const position = mailboxPosition(state, id);
  const first = state.messages.get(state.mailboxes.get(id)?.[0]);
  return {
    earliestAvailableSeq: first?.seq ?? null,
    resumeAfter: first ? first.seq - 1 : position.highWater,
    ...(position.gap ? { gap: { through: position.totalLoss, ...position.gap } } : {}),
  };
}

export function retain(state, at, policy) {
  for (const [id, message] of state.messages) {
    if (at < message.expiresAt) continue;
    const recipient = mailboxId(message.to);
    const position = mailboxPosition(state, recipient);
    position.expiredThrough = Math.max(position.expiredThrough, message.seq);
    if (!state.acked.get(recipient)?.has(id)) {
      position.totalLoss += 1;
      if (!position.gap) position.gap = { count: 0, firstSeq: message.seq, lastSeq: message.seq };
      position.gap.count += 1;
      position.gap.firstSeq = Math.min(position.gap.firstSeq, message.seq);
      position.gap.lastSeq = Math.max(position.gap.lastSeq, message.seq);
    }
    state.expired.set(id, { id, from: message.from, to: message.to, seq: message.seq,
      depth: message.depth, expiredAt: message.expiresAt,
      expiresAt: Math.min(Number.MAX_SAFE_INTEGER, message.expiresAt + policy.referenceRetentionMs) });
    state.messages.delete(id);
    state.acked.get(recipient)?.delete(id);
    state.wakes.delete(id);
  }
  for (const [id, mailbox] of state.mailboxes) state.mailboxes.set(id, mailbox.filter((item) => state.messages.has(item)));
  for (const [id, stream] of state.taskStreams) state.taskStreams.set(id, stream.filter((item) => state.messages.has(item)));
  for (const [key, entry] of state.idempotency) {
    if (at >= entry.expiresAt) state.idempotency.delete(key);
  }
  // Evidence is best effort beyond the durable aggregate notice: evict oldest
  // IDs at this independent bound, never the count of unread losses.
  const sizes = new Map();
  const keep = [];
  for (const [id, evidence] of state.expired) {
    if (at >= evidence.expiresAt) {
      state.expired.delete(id);
      continue;
    }
    keep.push([id, evidence]);
  }
  for (const [id, evidence] of keep.reverse()) {
    const recipient = mailboxId(evidence.to);
    const used = sizes.get(recipient) ?? { count: 0, bytes: 0 };
    const bytes = serializedBytes(evidence);
    if (used.count >= policy.expiredPerMailbox || used.bytes + bytes > policy.expiredBytesPerMailbox) {
      state.expired.delete(id);
    } else {
      used.count += 1; used.bytes += bytes; sizes.set(recipient, used);
    }
  }
}
