// Versioned channel metadata and pure folds; never retain a post-body archive.
import { mailboxId, senderNamespace, serializedBytes } from './retention.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const HUB_ID = new RegExp(`^hub_${UUID}$`);
export const CHANNEL_ID = new RegExp(`^channel_${UUID}$`);
export const CHANNEL_ADDRESS = new RegExp(`^hub:hub_${UUID}/channel:channel_${UUID}$`);
export const CHANNEL_OPERATIONS = Object.freeze(['manage', 'subscribe', 'post', 'census']);
export const CHANNEL_LIMITS = Object.freeze({ channelsPerBroker: 1024, channelsPerCreator: 64,
  channelMembers: 100, channelPostBytes: 16 * 1024 * 1024, channelMetadataBytes: 16 * 1024 * 1024, channelInvitationMs: 7 * 24 * 60 * 60 * 1000 });
export const channelAddress = (origin, id) => `hub:${origin}/channel:${id}`;
export const sameEndpoint = (left, right) => Boolean(left && right) && mailboxId(left) === mailboxId(right)
  && left?.account === right?.account && left?.principal === right?.principal;
const safe = (value) => Number.isSafeInteger(value) && value >= 0;
const exact = (value, keys) => value && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
export const validEndpoint = (value) => exact(value, value?.principal ? ['principal'] : ['account', 'agentId'])
  && (typeof value.principal === 'string' ? new RegExp(`^principal_${UUID}$`).test(value.principal)
    : typeof value.account === 'string' && /^[a-z_][a-z0-9_.-]{0,63}$/i.test(value.account) && typeof value.agentId === 'string' && new RegExp(`^agent_${UUID}$`).test(value.agentId));
const uniqueEndpoints = (values) => Array.isArray(values) && values.every(validEndpoint)
  && new Set(values.map(mailboxId)).size === values.length;

export function channelCapabilities(value) {
  if (!exact(value, ['create', ...CHANNEL_OPERATIONS]) || typeof value.create !== 'boolean'
    || CHANNEL_OPERATIONS.some((op) => !Array.isArray(value[op]) || value[op].length > 1024
      || value[op].some((id) => typeof id !== 'string' || !CHANNEL_ADDRESS.test(id)) || new Set(value[op]).size !== value[op].length)) throw new Error('invalid channel capabilities');
  return structuredClone(value);
}
export const noChannelCapabilities = () => ({ create: false, manage: [], subscribe: [], post: [], census: [] });

export function validateChannel(channel, origin, at) {
  if (!exact(channel, ['id', 'address', 'name', 'creator', 'creatorNamespace', 'manager', 'at', 'members', 'posters'])
    || !CHANNEL_ID.test(channel.id) || channel.address !== channelAddress(origin, channel.id)
    || typeof channel.name !== 'string' || Buffer.byteLength(channel.name) < 1 || Buffer.byteLength(channel.name) > 128
    || !validEndpoint(channel.creator) || channel.creatorNamespace !== senderNamespace(channel.creator)
    || !validEndpoint(channel.manager) || !safe(channel.at) || channel.at > at || !uniqueEndpoints(channel.posters)
    || !Array.isArray(channel.members) || new Set(channel.members.map((member) => mailboxId(member?.endpoint ?? {}))).size !== channel.members.length) throw new Error('invalid channel metadata');
  for (const member of channel.members) {
    const keys = member?.state === 'invited' ? ['endpoint', 'state', 'at', 'expiresAt', 'canPost', 'wake'] : ['endpoint', 'state', 'at', 'canPost', 'wake'];
    if (!exact(member, keys) || !validEndpoint(member.endpoint) || !['invited', 'subscribed'].includes(member.state)
      || !safe(member.at) || member.at < channel.at || member.at > at || typeof member.canPost !== 'boolean' || typeof member.wake !== 'boolean'
      || (member.state === 'invited' && (!safe(member.expiresAt) || member.expiresAt <= member.at || member.wake))) throw new Error('invalid channel membership');
  }
  return channel;
}

export function channelMetadataBytes(state, replacement, grants = state.principalChannelGrants) {
  const channels = new Map(state.channels);
  if (replacement) channels.set(replacement.address, replacement);
  return serializedBytes({ originHubId: state.originHubId, channels: [...channels], principalChannelGrants: [...grants] });
}

export function validateChannelState(state) {
  if (state.originHubId !== null && !HUB_ID.test(state.originHubId)) throw new Error('invalid channel origin');
  if (state.channels.size && state.originHubId === null) throw new Error('missing channel origin');
  for (const [address, channel] of state.channels) {
    if (address !== channel.address) throw new Error('invalid channel address');
    validateChannel(channel, state.originHubId, state.maintenanceTime);
  }
  for (const [principal, capabilities] of state.principalChannelGrants) {
    if (!new RegExp(`^principal_${UUID}$`).test(principal)) throw new Error('invalid channel grant principal');
    channelCapabilities(capabilities);
  }
}

export function applyChannelRecord(state, record) {
  if (record.t === 'channel-put') {
    const origin = state.originHubId ?? record.originHubId;
    if (!HUB_ID.test(origin) || record.originHubId !== origin || !safe(record.at)) throw new Error('invalid channel origin record');
    validateChannel(record.channel, origin, record.at);
    const previous = state.channels.get(record.channel.address);
    if (previous && (JSON.stringify(previous.creator) !== JSON.stringify(record.channel.creator)
      || previous.creatorNamespace !== record.channel.creatorNamespace || previous.at !== record.channel.at || previous.name !== record.channel.name)) throw new Error('immutable channel identity changed');
    state.originHubId = origin;
    state.channels.set(record.channel.address, structuredClone(record.channel));
    return true;
  }
  if (record.t === 'channel-grant') {
    if (typeof record.principal !== 'string' || !new RegExp(`^principal_${UUID}$`).test(record.principal)) throw new Error('invalid channel grant principal');
    state.principalChannelGrants.set(record.principal, channelCapabilities(record.capabilities));
    return true;
  }
  return false;
}

export function validatePostEntry(state, entry) {
  if (!exact(entry, ['operation', 'sender', 'from', 'recipient', 'id', 'at', 'expiresAt', 'fingerprint', 'snapshot', 'outcome'])
    || entry.operation !== 'channel-post' || !validEndpoint(entry.from) || entry.sender !== senderNamespace(entry.from)
    || !CHANNEL_ADDRESS.test(entry.recipient) || !state.channels.has(entry.recipient) || !/^post_/.test(entry.id)
    || !safe(entry.at) || entry.at > state.maintenanceTime || !safe(entry.expiresAt) || entry.expiresAt <= entry.at
    || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || !exact(entry.outcome, ['postId', 'accepted'])
    || entry.outcome.postId !== entry.id || entry.outcome.accepted !== true || !Array.isArray(entry.snapshot)
    || new Set(entry.snapshot.map((item) => item?.id)).size !== entry.snapshot.length
    || new Set(entry.snapshot.map((item) => mailboxId(item?.to ?? {}))).size !== entry.snapshot.length) throw new Error('invalid channel post dedupe');
  let previous = 0;
  for (const item of entry.snapshot) {
    if (!exact(item, ['to', 'id', 'seq', 'wake', 'channelWake']) || !validEndpoint(item.to) || typeof item.id !== 'string' || !/^msg_/.test(item.id)
      || !safe(item.seq) || item.seq <= previous || item.seq > state.seq || typeof item.channelWake !== 'boolean'
      || !['warm', 'cold', 'waiting', 'failed'].includes(item.wake)) throw new Error('invalid channel post snapshot');
    const message = state.messages.get(item.id);
    if (message && (message.seq !== item.seq || !sameEndpoint(message.to, item.to) || message.channel !== entry.recipient
      || message.postId !== entry.id || !sameEndpoint(message.from, entry.from) || message.channelWake !== item.channelWake)) throw new Error('invalid channel post reference');
    previous = item.seq;
  }
}
