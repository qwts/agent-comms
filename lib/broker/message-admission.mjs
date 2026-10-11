// Shared, side-effect-free admission for direct sends and channel fan-out.
import { randomUUID } from 'node:crypto';
import { fail } from '../errors.mjs';
import { mailboxId, senderNamespace, serializedBytes } from '../retention.mjs';
import { MAX_LINE_BYTES } from '../wire.mjs';
import { sha256 } from './shared.mjs';

export const PAGE_BUDGET = MAX_LINE_BYTES - 4096;
export const endpoint = (identity) => identity.principal
  ? { principal: identity.principal } : { account: identity.account, agentId: identity.agentId };
export const fingerprint = (operation, from, destination, payload) => sha256(JSON.stringify([
  ...(operation === null ? [] : [operation]), mailboxId(from), destination,
  payload.kind, payload.body, payload.refs, payload.correlation, payload.replyTo,
]));

export function createMessageAdmission(broker) {
  function payload(request) {
    const { kind = 'message', body, refs = [], correlation = null, replyTo = null, key } = request;
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) fail('bad-request', 'key must be 1-128 printable ASCII characters');
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(kind)) fail('bad-request', 'kind must be a short lowercase word');
    if (typeof body !== 'string' || Buffer.byteLength(body) > broker.limits.bodyBytes) fail('message-too-large', `body must be a string of at most ${broker.limits.bodyBytes} bytes`);
    if (!Array.isArray(refs) || refs.length > broker.limits.refs || refs.some((ref) => typeof ref !== 'string' || ref.length > broker.limits.refChars)) fail('bad-request', `refs must be at most ${broker.limits.refs} strings`);
    if (correlation !== null && (typeof correlation !== 'string' || correlation.length > 128)) fail('bad-request', 'correlation must be a short string');
    if (replyTo !== null && (typeof replyTo !== 'string' || replyTo.length > 128)) fail('bad-request', 'replyTo must be a message id');
    return { kind, body, refs, correlation, replyTo, key };
  }

  function message(from, to, content, { seq = broker.state.seq + 1, at = broker.now(), depth = 0, ...extra } = {}) {
    const value = { id: `msg_${randomUUID()}`, seq, at,
      from: { ...endpoint(from), ...(from.principal ? {} : { verification: from.verification }) },
      to: endpoint(to), kind: content.kind, body: content.body, refs: content.refs,
      correlation: content.correlation, replyTo: content.replyTo, depth,
      expiresAt: at + broker.limits.messageRetentionMs, ...extra };
    if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(value.expiresAt) || !Number.isSafeInteger(at + broker.limits.dedupeRetentionMs)) fail('usage', 'retention duration exceeds the safe timestamp range');
    if (serializedBytes({ ...value, wake: 'waiting' }) > PAGE_BUDGET) fail('message-too-large', 'this message would not fit in a read page once escaped');
    return value;
  }

  function admit(recipient, value) {
    const ids = broker.state.mailboxes.get(recipient);
    const acked = broker.state.acked.get(recipient);
    if (!Number.isSafeInteger(value.seq) || !Number.isSafeInteger(value.expiresAt) || !Number.isSafeInteger(value.at + broker.limits.dedupeRetentionMs)) fail('usage', 'retention duration exceeds the safe timestamp range');
    if (!ids || ids.filter((id) => !acked.has(id)).length >= broker.limits.unackedPerMailbox || ids.length >= broker.limits.retainedPerMailbox
      || ids.reduce((bytes, id) => bytes + serializedBytes(broker.state.messages.get(id)), 0) + serializedBytes(value) > broker.limits.mailboxBytes) fail('mailbox-full', 'the recipient mailbox reached its count or byte limit');
  }

  function dedupe(key, entry) {
    if (!Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= entry.at) fail('usage', 'retention duration exceeds the safe timestamp range');
    const protectedEntries = [...broker.state.idempotency].filter(([, item]) => item.sender === entry.sender);
    if (protectedEntries.length >= broker.limits.dedupeEntriesPerSender || protectedEntries.reduce((bytes, item) => bytes + serializedBytes(item), 0)
      + serializedBytes([`${entry.sender} ${key}`, entry]) > broker.limits.dedupeBytesPerSender) fail('dedupe-full', 'the sender deduplication budget is full; retry after protected entries expire');
  }

  function rates(from, recipients) {
    const keys = [[`account ${senderNamespace(from)}`, broker.limits.sendsPerAccountPerMinute],
      ...[...new Set(recipients.map(mailboxId))].map((id) => [`pair ${mailboxId(from)} ${id}`, broker.limits.sendsPerPairPerMinute])];
    const at = broker.now();
    const updates = keys.map(([key, limit]) => {
      const recent = (broker.sendTimes.get(key) ?? []).filter((time) => at - time < 60_000);
      if (recent.length >= limit) fail('rate-limited', 'too many messages in the last minute; retry later');
      return [key, [...recent, at]];
    });
    return () => { for (const [key, values] of updates) broker.sendTimes.set(key, values); };
  }
  return { payload, message, admit, dedupe, rates };
}
