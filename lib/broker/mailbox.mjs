// Mailbox operations and send policy, including retries and paging.

import { randomUUID } from 'node:crypto';

import { fail } from '../errors.mjs';
import { MAX_LINE_BYTES } from '../wire.mjs';
import { sha256 } from './shared.mjs';

const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const KEY = /^[\x21-\x7e]{1,128}$/;
// Room left in one protocol line for a read page's envelope. Any stored
// message must fit in a page on its own, escaping included.
const PAGE_BUDGET = MAX_LINE_BYTES - 4096;

export function createMailbox(broker, commit, pairing, watches) {
  function canSend(from, to) {
    if (!to.joined || to.agentId === from.agentId) return false;
    if (broker.state.pairings.get(to.account)?.state !== 'approved') return false;
    if (to.allow === null) return true;
    return to.allow.some((entry) => entry === from.account || entry === from.agentId
      || entry === `${from.account}/${from.agentId}`);
  }

  function peers(request) {
    const { account } = pairing.account(request);
    const me = pairing.joinedSoul(account, request.agentId, request.soulToken);
    const peers = [...broker.state.souls.values()]
      .filter((soul) => canSend(me, soul))
      .map(({ account: owner, agentId, name, harness, parent, verification }) => ({
        address: `${owner}/${agentId}`, account: owner, agentId, name, harness, parent, verification: verification ?? 'claimed',
      }));
    pairing.rememberVerification(me);
    return { peers };
  }

  function rateLimit(keys) {
    const now = broker.now();
    for (const [key, limit] of keys) {
      const recent = (broker.sendTimes.get(key) ?? []).filter((at) => now - at < 60_000);
      if (recent.length >= limit) fail('rate-limited', 'too many messages in the last minute; retry later');
      broker.sendTimes.set(key, recent);
    }
    for (const [key] of keys) broker.sendTimes.get(key).push(now);
  }

  function send(request) {
    const { account } = pairing.account(request);
    const from = pairing.joinedSoul(account, request.agentId, request.soulToken);
    const { kind = 'message', body, refs = [], correlation = null, replyTo = null, key } = request;
    if (typeof key !== 'string' || !KEY.test(key)) fail('bad-request', 'key must be 1-128 printable ASCII characters');
    if (typeof kind !== 'string' || !KIND.test(kind)) fail('bad-request', 'kind must be a short lowercase word');
    if (typeof body !== 'string' || Buffer.byteLength(body) > broker.limits.bodyBytes) {
      fail('message-too-large', `body must be a string of at most ${broker.limits.bodyBytes} bytes`);
    }
    if (!Array.isArray(refs) || refs.length > broker.limits.refs
      || refs.some((ref) => typeof ref !== 'string' || ref.length > broker.limits.refChars)) {
      fail('bad-request', `refs must be at most ${broker.limits.refs} strings`);
    }
    if (correlation !== null && (typeof correlation !== 'string' || correlation.length > 128)) {
      fail('bad-request', 'correlation must be a short string');
    }

    // A retry must get the original answer even if the recipient has since
    // left or narrowed its allowlist, so settle idempotency before policy.
    const to = pairing.resolve(request.to);
    const previous = broker.state.idempotency.get(`${account} ${key}`);
    if (previous) {
      const fingerprint = to && sha256(JSON.stringify([from.agentId, to.agentId, kind, body, refs, correlation, replyTo]));
      if (previous.fingerprint !== fingerprint) fail('conflict', 'this key was already used for a different message');
      pairing.rememberVerification(from);
      return { messageId: previous.id, duplicate: true, wake: broker.state.wakes.get(previous.id) };
    }

    // Unknown, departed, and not-allowed recipients look the same, so a send
    // cannot be used to discover souls the sender may not see.
    if (!to || !canSend(from, to)) fail('unknown-recipient', 'no soul you may message has that address');
    const fingerprint = sha256(JSON.stringify([from.agentId, to.agentId, kind, body, refs, correlation, replyTo]));

    let depth = 0;
    if (replyTo !== null) {
      const parent = typeof replyTo === 'string' ? broker.state.messages.get(replyTo) : undefined;
      if (!parent || parent.to.agentId !== from.agentId) fail('unknown-message', 'replyTo must be a message you received');
      if (parent.from.agentId === from.agentId) fail('reply-to-self', 'a soul may not reply to its own message');
      depth = parent.depth + 1;
      if (depth > broker.limits.replyDepth) fail('reply-depth-exceeded', 'this conversation reached the reply-depth limit');
    }

    const acked = broker.state.acked.get(to.agentId);
    const unacked = broker.state.mailboxes.get(to.agentId).filter((id) => !acked.has(id)).length;
    if (unacked >= broker.limits.unackedPerMailbox) fail('mailbox-full', 'the recipient mailbox is full');

    rateLimit([
      [`account ${account}`, broker.limits.sendsPerAccountPerMinute],
      [`pair ${from.agentId} ${to.agentId}`, broker.limits.sendsPerPairPerMinute],
    ]);

    const message = {
      id: `msg_${randomUUID()}`,
      seq: broker.state.seq + 1,
      at: broker.now(),
      from: { account, agentId: from.agentId, verification: from.verification },
      to: { account: to.account, agentId: to.agentId },
      kind, body, refs, correlation, replyTo, depth,
    };
    if (Buffer.byteLength(JSON.stringify({ ...message, wake: 'waiting' })) > PAGE_BUDGET) {
      fail('message-too-large', 'this message would not fit in a read page once escaped');
    }

    // Warm only when this soul's own watch is open. The account daemon's
    // watch does not change it; a later wake-report can. The call returns
    // this outcome now — notify only arms the coalescer (ADR-0008 decision 7).
    const { wake, notify } = watches.delivery(to.agentId);
    commit({ t: 'message', message, key, fingerprint, wake });

    pairing.rememberVerification(from);
    notify(message);
    return { messageId: message.id, seq: message.seq, duplicate: false, wake };
  }

  function unacked(agentId, after = 0) {
    const acked = broker.state.acked.get(agentId);
    return broker.state.mailboxes.get(agentId)
      .filter((id) => !acked.has(id))
      .map((id) => broker.state.messages.get(id))
      .filter((message) => message.seq > after)
      .map((message) => ({ ...message, wake: broker.state.wakes.get(message.id) }));
  }

  function read(request) {
    const { account } = pairing.account(request);
    const soul = pairing.ownSoul(account, request.agentId, request.soulToken);
    const after = request.after ?? 0;
    const limit = request.limit ?? 20;
    if (!Number.isInteger(after) || after < 0) fail('bad-request', 'after must be a cursor from an earlier read');
    if (!Number.isInteger(limit) || limit < 1 || limit > broker.limits.readPage) {
      fail('bad-request', `limit must be between 1 and ${broker.limits.readPage}`);
    }
    // A page must fit one protocol line: stop at the limit or the byte
    // budget, whichever comes first, but always return at least one message.
    const pending = unacked(soul.agentId, after);
    const messages = [];
    let bytes = 0;
    for (const message of pending.slice(0, limit)) {
      bytes += Buffer.byteLength(JSON.stringify(message)) + 1;
      if (messages.length && bytes > PAGE_BUDGET) break;
      messages.push(message);
    }
    pairing.rememberVerification(soul);
    return { messages, cursor: messages.at(-1)?.seq ?? after, remaining: pending.length - messages.length };
  }

  function ack(request) {
    const { account } = pairing.account(request);
    const soul = pairing.ownSoul(account, request.agentId, request.soulToken);
    const { ids } = request;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > broker.limits.readPage) fail('bad-request', 'ids must be a non-empty list');
    const mailbox = new Set(broker.state.mailboxes.get(soul.agentId));
    for (const id of ids) if (!mailbox.has(id)) fail('unknown-message', `${id} is not in this mailbox`);
    const fresh = ids.filter((id) => !broker.state.acked.get(soul.agentId).has(id));
    if (fresh.length) commit({ t: 'ack', agentId: soul.agentId, ids: fresh, at: broker.now() });
    pairing.rememberVerification(soul);
    return { acknowledged: fresh.length, alreadyAcknowledged: ids.length - fresh.length };
  }

  return { peers, send, unacked, read, ack };
}
