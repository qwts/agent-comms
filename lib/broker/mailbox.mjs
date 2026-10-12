// Mailbox operations and send policy, including retries and paging.

import { fail } from '../errors.mjs';
import { covers } from './shared.mjs';
import { createMessageAdmission, endpoint, fingerprint as sendFingerprint, PAGE_BUDGET } from './message-admission.mjs';
import { lossDetails, mailboxPosition } from '../retention.mjs';
import { CHANNEL_ADDRESS } from '../channel-state.mjs';
import { validTraceparent } from '../trace-context.mjs';

export function createMailbox(broker, commit, pairing, watches) {
  const idOf = (identity) => identity.principal ?? identity.agentId;
  const admission = createMessageAdmission(broker);

  function caller(request, { joined = false } = {}) {
    if (request.auth?.principal !== undefined) {
      const { principal, pairing: { grant } } = pairing.principal(request);
      if (request.agentId !== undefined || request.sender !== undefined) {
        fail('unauthenticated', 'a principal cannot act as a soul or another sender');
      }
      return { principal, grant };
    }
    const { account } = pairing.account(request);
    return joined ? pairing.joinedSoul(account, request.agentId, request.soulToken)
      : pairing.ownSoul(account, request.agentId, request.soulToken);
  }

  function resolve(address) {
    const principal = broker.state.principals.get(address);
    if (principal?.state === 'approved') return { principal: address, grant: principal.grant };
    return pairing.resolve(address);
  }

  function remember(identity) {
    if (!identity.principal) pairing.rememberVerification(identity);
  }

  function canSend(from, to) {
    if (to.principal) return !from.principal && covers(to.grant, from);
    if (from.principal) {
      if (!covers(from.grant, to)) return false;
      if (!to.joined || broker.state.pairings.get(to.account)?.state !== 'approved') return false;
      return to.allow === null || to.allow.includes(from.principal);
    }
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

  function expired(identity, id) {
    const evidence = broker.state.expired.get(id);
    if (evidence && idOf(evidence.to) === idOf(identity)) fail('message-expired', 'this message expired under the mailbox retention policy');
  }

  function send(request) {
    const from = caller(request, { joined: true });
    const account = from.principal ? `principal ${from.principal}` : from.account;
    const content = admission.payload(request);
    const { replyTo, key } = content;

    // A retry must get the original answer even if the recipient has since
    // left or narrowed its allowlist, so settle idempotency before policy.
    const to = resolve(request.to);
    const previous = broker.state.idempotency.get(`${account} ${key}`);
    if (previous) {
      const recipient = to ? idOf(to)
        : (request.to === previous.requestedTo || request.to === previous.recipient ? previous.recipient : null);
      const fingerprint = recipient && previous.operation !== 'channel-post'
        && sendFingerprint(previous.operation === 'send' ? 'send' : null, from, recipient, content);
      if (previous.fingerprint !== fingerprint) fail('conflict', 'this key was already used for a different message');
      remember(from);
      return { ...previous.outcome, duplicate: true };
    }

    // Unknown, departed, and not-allowed recipients look the same, so a send
    // cannot be used to discover souls the sender may not see.
    if (!to || !canSend(from, to)) fail('unknown-recipient', 'no soul you may message has that agent id or peer name');
    const fingerprint = sendFingerprint('send', from, idOf(to), content);

    let depth = 0;
    if (replyTo !== null) {
      const parent = typeof replyTo === 'string' ? broker.state.messages.get(replyTo) : undefined;
      if (!parent) expired(from, replyTo);
      if (!parent || idOf(parent.to) !== idOf(from)) fail('unknown-message', 'replyTo must be a message you received');
      if (idOf(parent.from) === idOf(from)) fail('reply-to-self', 'a soul may not reply to its own message');
      depth = parent.depth + 1;
      if (depth > broker.limits.replyDepth) fail('reply-depth-exceeded', 'this conversation reached the reply-depth limit');
    }

    const charge = admission.rates(from, [to]);
    const message = admission.message(from, to, content, { depth });

    // Warm only when this soul's own watch is open. The account daemon's
    // watch does not change it; a later wake-report can. The call returns
    // this outcome now — notify only arms the coalescer (ADR-0008 decision 7).
    const { wake, notify } = to.principal
      ? { wake: 'waiting', notify: () => {} } : watches.delivery(to.agentId, message, validTraceparent(request.traceparent));
    admission.admit(idOf(to), message);
    const entry = { operation: 'send', fingerprint, id: message.id, at: message.at, expiresAt: message.at + broker.limits.dedupeRetentionMs, sender: account, recipient: idOf(to), requestedTo: request.to,
      outcome: { messageId: message.id, seq: message.seq, wake } };
    admission.dedupe(key, entry);
    commit({ t: 'message', operation: 'send', message, key, fingerprint, wake, requestedTo: request.to, dedupeExpiresAt: entry.expiresAt });
    charge();

    remember(from);
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
    const soul = caller(request);
    const after = request.after ?? 0;
    const limit = request.limit ?? 20;
    const channel = request.channel;
    if (channel !== undefined && (typeof channel !== 'string' || !CHANNEL_ADDRESS.test(channel))) fail('bad-request', 'channel must be a canonical channel address');
    if (!Number.isInteger(after) || after < 0) fail('bad-request', 'after must be a cursor from an earlier read');
    if (!Number.isInteger(limit) || limit < 1 || limit > broker.limits.readPage) {
      fail('bad-request', `limit must be between 1 and ${broker.limits.readPage}`);
    }
    // A page must fit one protocol line: stop at the limit or the byte
    // budget, whichever comes first, but always return at least one message.
    const pending = unacked(idOf(soul), after);
    const position = mailboxPosition(broker.state, idOf(soul));
    const details = lossDetails(broker.state, idOf(soul));
    // Prospective policy overrides can expire a later message first. A
    // retained cursor and the advertised exclusive resume must remain usable;
    // holes after that boundary are reported by the independent loss notice.
    const staleBefore = details.earliestAvailableSeq === null ? position.expiredThrough
      : Math.min(position.expiredThrough, details.resumeAfter);
    if (after > 0 && after < staleBefore) fail('cursor-expired', 'this cursor precedes the retained mailbox; choose whether to resume', details);
    const messages = [];
    let bytes = 0;
    let cursor = after;
    for (const message of pending) {
      if (channel === undefined || message.channel === channel) {
        const size = Buffer.byteLength(JSON.stringify(message)) + 1;
        if (messages.length >= limit || messages.length && bytes + size > PAGE_BUDGET) break;
        bytes += size;
        messages.push(message);
      }
      // The cursor belongs to this mailbox, including nonmatching copies we
      // examined. Filtering never acknowledges them or a mailbox loss notice.
      cursor = message.seq;
    }
    remember(soul);
    return { messages, cursor, remaining: pending.filter((message) => message.seq > cursor && (channel === undefined || message.channel === channel)).length,
      ...(details.gap ? { gap: details.gap } : {}) };
  }

  function ack(request) {
    const soul = caller(request);
    const { ids } = request;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > broker.limits.readPage) fail('bad-request', 'ids must be a non-empty list');
    const mailbox = new Set(broker.state.mailboxes.get(idOf(soul)));
    for (const id of ids) if (!mailbox.has(id)) { expired(soul, id); fail('unknown-message', `${id} is not in this mailbox`); }
    const fresh = ids.filter((id) => !broker.state.acked.get(idOf(soul)).has(id));
    if (fresh.length) commit({ t: 'ack', ...(soul.principal ? { principal: soul.principal } : { agentId: soul.agentId }), ids: fresh, at: broker.now() });
    remember(soul);
    return { acknowledged: fresh.length, alreadyAcknowledged: ids.length - fresh.length };
  }

  function ackGap(request) {
    const soul = caller(request);
    const { through } = request;
    if (!Number.isSafeInteger(through) || through < 1) fail('bad-request', 'through must identify a received loss notice');
    const position = mailboxPosition(broker.state, idOf(soul));
    if (through <= position.acknowledgedLoss) return { acknowledged: 0, alreadyAcknowledged: true };
    if (through !== position.totalLoss || !position.gap) fail('gap-changed', 'read the current loss notice before acknowledging it');
    const acknowledged = position.gap.count;
    commit({ t: 'gap-ack', mailbox: idOf(soul), through, at: broker.now() });
    remember(soul);
    return { acknowledged, alreadyAcknowledged: false };
  }

  function messageStatus(request) {
    const soul = caller(request);
    const message = broker.state.messages.get(request.id);
    if (message && idOf(message.to) === idOf(soul)) return { status: 'retained' };
    expired(soul, request.id);
    fail('unknown-message', 'no message with that id in this mailbox');
  }

  function taskEvent(from, to, task, previous) {
    const recipient = idOf(to);
    const charge = admission.rates(from, [to]);
    const message = admission.message(from, to, {
      kind: 'task-event', body: JSON.stringify({ taskId: task.id, previous, state: task.state, revision: task.revision }),
      refs: [], correlation: task.id, replyTo: null,
    });
    admission.admit(recipient, message);
    const { wake, notify } = to.principal
      ? { wake: 'waiting', notify: () => {} } : watches.delivery(to.agentId, message);
    return { message, wake, notify: () => { charge(); notify(message); } };
  }

  return { peers, send, unacked, read, ack, ackGap, messageStatus, caller, resolve, canSend, remember, endpoint, taskEvent };
}
