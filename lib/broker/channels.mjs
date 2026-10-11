// Channel authorization and one-event fan-out. Transport adapters share these routes.
import { randomUUID } from 'node:crypto';
import { fail } from '../errors.mjs';
import { mailboxId, senderNamespace, serializedBytes } from '../retention.mjs';
import { CHANNEL_ADDRESS, channelAddress, channelCapabilities, channelMetadataBytes,
  noChannelCapabilities, sameEndpoint, validateChannel } from '../channel-state.mjs';
import { createMessageAdmission, endpoint, fingerprint, PAGE_BUDGET } from './message-admission.mjs';

export function createChannels(broker, commit, mailbox, watches) {
  const admission = createMessageAdmission(broker);
  const own = (identity) => endpoint(identity);
  const capabilities = (identity) => identity.principal
    ? broker.state.principalChannelGrants.get(identity.principal) ?? noChannelCapabilities() : null;
  const memberOf = (channel, identity) => channel.members.find((member) => sameEndpoint(member.endpoint, identity));
  const addressOf = (request) => {
    if (typeof request.channel !== 'string' || !CHANNEL_ADDRESS.test(request.channel)) fail('bad-request', 'channel must be a canonical channel address');
    return request.channel;
  };
  const get = (request) => broker.state.channels.get(addressOf(request));
  const permits = (identity, operation, channel) => !identity.principal || (operation === 'create' ? capabilities(identity).create
    : capabilities(identity)[operation]?.includes(channel.address)
      || operation === 'manage' && capabilities(identity).create && sameEndpoint(channel.creator, identity));
  const eligible = (identity) => {
    if (identity.principal) return broker.state.principals.get(identity.principal)?.state === 'approved';
    const current = broker.state.souls.get(identity.agentId);
    return current?.account === identity.account && current.joined && broker.state.pairings.get(identity.account)?.state === 'approved';
  };
  function wakeAllowed(message) {
    if (message.channel === undefined) return true;
    if (!message.channelWake || message.to.principal || message.expiresAt <= broker.now()) return false;
    const channel = broker.state.channels.get(message.channel);
    if (!channel) return false;
    const from = mailbox.resolve(message.from.principal ?? `${message.from.account}/${message.from.agentId}`);
    const to = mailbox.resolve(`${message.to.account}/${message.to.agentId}`);
    const member = to && memberOf(channel, to);
    // A delayed side effect needs current authorization. Committed copies and
    // retry outcomes remain readable even when these wake conditions change.
    return Boolean(from && to && eligible(from) && eligible(to) && member?.state === 'subscribed' && member.wake
      && permits(from, 'post', channel) && channel.posters.some((poster) => sameEndpoint(poster, from))
      && permits(to, 'subscribe', channel) && (sameEndpoint(from, to) || mailbox.canSend(from, to)));
  }
  function manager(request) {
    const caller = mailbox.caller(request, { joined: true });
    const channel = get(request);
    if (!channel || !sameEndpoint(channel.manager, caller) || !permits(caller, 'manage', channel)) fail('unknown-channel', 'no channel you may manage has that address');
    return { caller, channel };
  }
  function target(caller, to) {
    const resolved = mailbox.resolve(to);
    if (!resolved || !sameEndpoint(caller, resolved) && !mailbox.canSend(caller, resolved)) fail('unknown-recipient', 'no endpoint you may message has that address');
    return resolved;
  }
  function put(channel, { creating = false, origin = broker.state.originHubId } = {}) {
    validateChannel(channel, origin, broker.now());
    const counts = [...broker.state.channels.values()].filter((item) => item.creatorNamespace === channel.creatorNamespace).length;
    const previousSlots = broker.state.channels.get(channel.address)?.members.length ?? 0;
    if (creating && (broker.state.channels.size >= broker.limits.channelsPerBroker || counts >= broker.limits.channelsPerCreator)
      || channel.members.length > broker.limits.channelMembers && channel.members.length > previousSlots) fail('channel-full', 'channel metadata admission is full');
    const before = channelMetadataBytes(broker.state);
    const after = channelMetadataBytes({ ...broker.state, originHubId: origin }, channel);
    if (after > broker.limits.channelMetadataBytes && after > before) fail('channel-full', 'channel metadata admission is full');
    commit({ t: 'channel-put', originHubId: origin, channel, at: broker.now() });
  }
  function create(request) {
    const caller = mailbox.caller(request, { joined: true });
    if (!permits(caller, 'create')) fail('channel-forbidden', 'channel creation requires an owner capability');
    if (typeof request.name !== 'string' || Buffer.byteLength(request.name) < 1 || Buffer.byteLength(request.name) > 128) fail('bad-request', 'channel name must be 1-128 UTF-8 bytes');
    const origin = broker.state.originHubId ?? `hub_${randomUUID()}`;
    const id = `channel_${randomUUID()}`;
    const channel = { id, address: channelAddress(origin, id), name: request.name, creator: own(caller),
      creatorNamespace: senderNamespace(caller), manager: own(caller), at: broker.now(), members: [], posters: [own(caller)] };
    put(channel, { creating: true, origin });
    mailbox.remember(caller);
    return { channel: channel.address, address: channel.address, name: channel.name };
  }
  function invite(request) {
    const { caller, channel } = manager(request);
    const to = target(caller, request.to);
    if (request.canPost !== undefined && typeof request.canPost !== 'boolean') fail('bad-request', 'canPost must be boolean');
    const old = memberOf(channel, to);
    if (old?.state !== 'subscribed') {
      const expiresAt = broker.now() + broker.limits.channelInvitationMs;
      if (!Number.isSafeInteger(expiresAt)) fail('usage', 'invitation duration exceeds the safe timestamp range');
      const copy = structuredClone(channel);
      copy.members = copy.members.filter((member) => !sameEndpoint(member.endpoint, to));
      const canPost = (request.canPost ?? false) || channel.posters.some((poster) => sameEndpoint(poster, to));
      copy.members.push({ endpoint: own(to), state: 'invited', at: broker.now(), expiresAt, canPost, wake: false });
      put(copy);
    }
    mailbox.remember(caller);
    return { accepted: true };
  }
  function invitations(request) {
    const caller = mailbox.caller(request);
    const after = request.after ?? '';
    const limit = request.limit ?? 20;
    if (typeof after !== 'string' || after && !CHANNEL_ADDRESS.test(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > broker.limits.readPage) fail('bad-request', 'invalid invitation page');
    const pending = [...broker.state.channels.values()].sort((a, b) => a.address.localeCompare(b.address))
      .filter((channel) => channel.address > after).flatMap((channel) => {
        const member = memberOf(channel, caller);
        return member?.state === 'invited' ? [{ channel: channel.address, name: channel.name, canPost: member.canPost, expiresAt: member.expiresAt }] : [];
      });
    const result = [];
    let bytes = 0;
    for (const invite of pending.slice(0, limit)) {
      bytes += serializedBytes(invite) + 1;
      if (bytes > PAGE_BUDGET && result.length) break;
      result.push(invite);
    }
    return { invitations: result, cursor: result.at(-1)?.channel ?? after, remaining: pending.length - result.length };
  }
  function subscribe(request) {
    const caller = mailbox.caller(request, { joined: true });
    const channel = get(request);
    const member = channel && memberOf(channel, caller);
    if (!member || !permits(caller, 'subscribe', channel)) fail('unknown-channel', 'no invitation you may accept has that address');
    if (request.wake !== undefined && typeof request.wake !== 'boolean') fail('bad-request', 'wake must be boolean');
    if (member.state === 'invited') {
      const copy = structuredClone(channel);
      const accepted = memberOf(copy, caller);
      delete accepted.expiresAt;
      Object.assign(accepted, { state: 'subscribed', at: broker.now(), wake: request.wake ?? false });
      if (accepted.canPost && !copy.posters.some((item) => sameEndpoint(item, caller))) copy.posters.push(own(caller));
      put(copy);
    }
    mailbox.remember(caller);
    return { accepted: true };
  }
  function unsubscribe(request) {
    const caller = mailbox.caller(request);
    const channel = get(request);
    if (channel && memberOf(channel, caller)) {
      const copy = structuredClone(channel);
      copy.members = copy.members.filter((member) => !sameEndpoint(member.endpoint, caller));
      put(copy);
    }
    return { accepted: true };
  }
  function setWake(request) {
    const caller = mailbox.caller(request, { joined: true });
    const channel = get(request);
    if (!channel || memberOf(channel, caller)?.state !== 'subscribed' || !permits(caller, 'subscribe', channel)) fail('unknown-channel', 'no subscription you may update has that address');
    if (typeof request.wake !== 'boolean') fail('bad-request', 'wake must be boolean');
    const copy = structuredClone(channel);
    memberOf(copy, caller).wake = request.wake;
    put(copy);
    return { accepted: true };
  }
  function remove(request) {
    const { caller, channel } = manager(request);
    const candidates = [...channel.members.map((member) => member.endpoint), ...channel.posters];
    const to = candidates.find((item) => request.to === item.principal || request.to === item.agentId || request.to === `${item.account}/${item.agentId}`);
    if (!to) return { accepted: true };
    const copy = structuredClone(channel);
    copy.members = copy.members.filter((member) => !sameEndpoint(member.endpoint, to));
    copy.posters = copy.posters.filter((poster) => !sameEndpoint(poster, to));
    put(copy);
    return { accepted: true };
  }
  function permission(request) {
    const { caller, channel } = manager(request);
    const to = target(caller, request.to);
    if (typeof request.canPost !== 'boolean') fail('bad-request', 'canPost must be boolean');
    const copy = structuredClone(channel);
    copy.posters = copy.posters.filter((poster) => !sameEndpoint(poster, to));
    if (request.canPost) copy.posters.push(own(to));
    const member = memberOf(copy, to);
    if (member) member.canPost = request.canPost;
    put(copy);
    return { accepted: true };
  }
  function post(request) {
    // Authentication still applies to a retry, but departure cannot turn an
    // already accepted durable outcome into a new admission decision.
    const caller = mailbox.caller(request);
    const address = addressOf(request);
    const content = admission.payload(request);
    const hash = fingerprint('channel-post', caller, address, content);
    const previous = broker.state.idempotency.get(`${senderNamespace(caller)} ${content.key}`);
    if (previous) {
      if (previous.operation !== 'channel-post' || previous.fingerprint !== hash) fail('conflict', 'this key was already used for a different message');
      return { ...previous.outcome, duplicate: true };
    }
    if (!eligible(caller)) fail('not-joined', 'this soul has left the hub');
    const channel = broker.state.channels.get(address);
    if (!channel || !permits(caller, 'post', channel) || !channel.posters.some((poster) => sameEndpoint(poster, caller))) fail('unknown-channel', 'no channel you may post to has that address');
    let depth = 0;
    if (content.replyTo !== null) {
      const parent = broker.state.messages.get(content.replyTo);
      if (!parent) mailbox.messageStatus({ ...request, id: content.replyTo });
      if (!parent || !sameEndpoint(parent.to, caller) || parent.channel !== address) fail('unknown-message', 'replyTo must be a channel copy you received');
      depth = parent.depth + 1;
      if (depth > broker.limits.replyDepth) fail('reply-depth-exceeded', 'this conversation reached the reply-depth limit');
    }
    const members = channel.members.filter((member) => member.state === 'subscribed');
    const targets = members.map((member) => {
      const to = mailbox.resolve(member.endpoint.principal ?? `${member.endpoint.account}/${member.endpoint.agentId}`);
      if (!to || !eligible(to) || !permits(to, 'subscribe', channel) || !sameEndpoint(to, caller) && !mailbox.canSend(caller, to)) fail('channel-unavailable', 'the complete channel snapshot cannot accept this post');
      return to;
    });
    const charge = admission.rates(caller, targets);
    const at = broker.now();
    const postId = `post_${randomUUID()}`;
    const notifications = [];
    let postBytes = 0;
    const copies = targets.map((to, index) => {
      const message = admission.message(caller, to, content, { seq: broker.state.seq + index + 1, at, depth,
        channel: address, postId, channelWake: members[index].wake });
      // A cheap lower bound stops oversized batches early; final admission
      // measures the complete event, including its snapshot and retry outcome.
      postBytes += serializedBytes(message);
      if (postBytes > broker.limits.channelPostBytes) fail('channel-full', 'the atomic post exceeds its byte budget');
      try { admission.admit(mailboxId(to), message); }
      catch (error) { if (error.code === 'mailbox-full') fail('channel-unavailable', 'the complete channel snapshot cannot accept this post'); throw error; }
      const delivery = to.principal ? { wake: 'waiting', notify: () => {} } : watches.delivery(to.agentId, message);
      notifications.push(() => delivery.notify(message));
      return { message, wake: delivery.wake };
    });
    const entry = { operation: 'channel-post', sender: senderNamespace(caller), from: own(caller), recipient: address,
      id: postId, at, expiresAt: at + broker.limits.dedupeRetentionMs, fingerprint: hash,
      snapshot: copies.map(({ message, wake }) => ({ to: message.to, id: message.id, seq: message.seq, wake, channelWake: message.channelWake })),
      outcome: { postId, accepted: true } };
    const record = { t: 'channel-post', channel: address, copies, entry, key: content.key, at };
    if (serializedBytes(record) + 1 > broker.limits.channelPostBytes) fail('channel-full', 'the atomic post exceeds its byte budget');
    admission.dedupe(content.key, entry);
    commit(record);
    charge();
    mailbox.remember(caller);
    for (const notify of notifications) notify();
    return { ...entry.outcome, duplicate: false };
  }
  function admin(request) {
    if (request.op === 'channel-grant') {
      if (broker.state.principals.get(request.principal)?.state !== 'approved') fail('unknown-principal', 'the principal is not approved');
      let value;
      try { value = channelCapabilities(request.capabilities); } catch { fail('bad-request', 'invalid channel capabilities'); }
      const grants = new Map(broker.state.principalChannelGrants);
      grants.set(request.principal, value);
      const after = channelMetadataBytes(broker.state, null, grants);
      if (after > broker.limits.channelMetadataBytes && after > channelMetadataBytes(broker.state)) fail('channel-full', 'channel metadata admission is full');
      commit({ t: 'channel-grant', principal: request.principal, capabilities: value, at: broker.now() });
      return { accepted: true };
    }
    if (request.op === 'channel-manager') {
      const channel = get(request);
      const to = mailbox.resolve(request.to);
      if (!channel || !to || !eligible(to) || !permits(to, 'manage', channel)) fail('bad-request', 'manager must be an eligible endpoint with channel management permission');
      const copy = structuredClone(channel);
      copy.manager = own(to);
      put(copy);
      return { accepted: true };
    }
    fail('unknown-operation', 'unknown channel administration operation');
  }
  return { create, invite, invitations, subscribe, unsubscribe, setWake, remove, permission, post, admin,
    permits, eligible, memberOf, wakeAllowed };
}
