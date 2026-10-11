import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Broker } from '../lib/broker.mjs';
import { admin, call, callPrincipal, loadCredential, loadPrincipalCredential, pairPrincipal } from '../lib/client.mjs';
import { readHostConfig } from '../lib/host-config.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { createPrincipalClient } from '../lib/principal-client.mjs';
import { withBroker } from './helpers/broker.mjs';

const principalCapabilities = (overrides = {}) => ({
  create: false, manage: [], subscribe: [], post: [], census: [], ...overrides,
});

async function fixture(run, options = {}) {
  return withBroker(async (context) => {
    const accountCredential = loadCredential(clientPaths(context.env));
    const soul = (agentId, request) => call(context.paths, accountCredential, { ...request, agentId });
    const newPrincipal = async (name, grant = [context.accounts.alice, context.accounts.bob]) => {
      const env = { ...context.env, AGENT_COMMS_NO_KEYCHAIN: '1', AGENT_COMMS_CREDENTIAL_NAME: `acceptance-${name}` };
      const client = clientPaths(env);
      const pending = await pairPrincipal(context.paths, client, `Channel acceptance ${name}`, env);
      await admin(context.paths, { op: 'principal-approve', code: pending.code, grant });
      const credential = loadPrincipalCredential(client, readHostConfig(env));
      return {
        credential,
        request: (request) => callPrincipal(context.paths, credential, request),
        client: createPrincipalClient({ env, credentialLoader: () => credential }),
      };
    };
    return run({ ...context, accountCredential, soul, newPrincipal });
  }, options);
}

async function channelWithMembers(context, members, { canPost = true } = {}) {
  const created = await context.soul(context.accounts.alice, { op: 'channel-create', name: 'acceptance' });
  for (const member of members) {
    await context.soul(context.accounts.alice, { op: 'channel-invite', channel: created.channel,
      to: member.to ?? `${context.owner}/${member.agentId}`, canPost: member.canPost ?? canPost });
    if (member.subscribe !== false) {
      if (member.request) await member.request({ op: 'channel-subscribe', channel: created.channel });
      else await context.soul(member.agentId, { op: 'channel-subscribe', channel: created.channel });
    }
  }
  return created.channel;
}

const key = () => `acceptance-${randomUUID()}`;

test('invites require endpoint consent, creators do not auto-subscribe, and late members get no history', () => fixture(async (c) => {
  const created = await c.soul(c.accounts.alice, { op: 'channel-create', name: 'consent test' });
  assert.match(created.channel, /^hub:hub_[0-9a-f-]+\/channel:channel_[0-9a-f-]+$/);
  assert.equal(created.address, created.channel);

  const early = await c.soul(c.accounts.alice, { op: 'channel-post', channel: created.channel,
    key: key(), body: 'before subscription' });
  assert.equal(early.accepted, true);
  assert.equal((await c.soul(c.accounts.bob, { op: 'channel-invitations' })).invitations.length, 0);
  await assert.rejects(c.soul(c.accounts.bob, { op: 'channel-subscribe', channel: created.channel }), { code: 'unknown-channel' });
  await c.soul(c.accounts.alice, { op: 'channel-invite', channel: created.channel,
    to: `${c.owner}/${c.accounts.bob}`, canPost: true });
  const invitations = await c.soul(c.accounts.bob, { op: 'channel-invitations' });
  assert.deepEqual(invitations.invitations.map(({ channel, name, canPost }) => ({ channel, name, canPost })),
    [{ channel: created.channel, name: 'consent test', canPost: true }]);
  await c.soul(c.accounts.bob, { op: 'channel-subscribe', channel: created.channel });
  assert.equal((await c.soul(c.accounts.alice, { op: 'read' })).messages.some((m) => m.channel === created.channel), false,
    'the creator remains unsubscribed until explicitly invited and subscribed');
  assert.equal((await c.soul(c.accounts.bob, { op: 'read' })).messages.some((m) => m.body === 'before subscription'), false,
    'the zero-subscriber post did not create a history archive');

  await c.soul(c.accounts.alice, { op: 'channel-invite', channel: created.channel,
    to: `${c.owner}/${c.accounts.alice}`, canPost: true });
  await c.soul(c.accounts.alice, { op: 'channel-subscribe', channel: created.channel });
  const posted = await c.soul(c.accounts.alice, { op: 'channel-post', channel: created.channel,
    key: key(), body: 'after consent' });
  const aliceCopies = (await c.soul(c.accounts.alice, { op: 'read' })).messages.filter((m) => m.channel === created.channel);
  const bobCopies = (await c.soul(c.accounts.bob, { op: 'read' })).messages.filter((m) => m.channel === created.channel);
  assert.equal(aliceCopies.length, 1);
  assert.equal(bobCopies.length, 1);
  assert.notEqual(aliceCopies[0].id, bobCopies[0].id);
  assert.equal(aliceCopies[0].postId, posted.postId);
  assert.equal(bobCopies[0].postId, posted.postId);
  assert.equal(aliceCopies[0].body, 'after consent');
  assert.equal(bobCopies[0].body, 'after consent');
  assert.equal(aliceCopies[0].channelWake, false);
  assert.equal(bobCopies[0].channelWake, false);
}));

test('principal messaging grants do not imply channel capabilities; create derives management only', () => fixture(async (c) => {
  const host = await c.newPrincipal('capabilities');
  await assert.rejects(host.request({ op: 'channel-create', name: 'denied' }), { code: 'channel-forbidden' });

  await admin(c.paths, { op: 'channel-grant', principal: host.credential.principal,
    capabilities: principalCapabilities({ create: true }) });
  const created = await host.request({ op: 'channel-create', name: 'principal-created' });
  await host.request({ op: 'channel-invite', channel: created.channel,
    to: `${c.owner}/${c.accounts.bob}`, canPost: true });
  await c.soul(c.accounts.bob, { op: 'channel-subscribe', channel: created.channel });

  await assert.rejects(host.request({ op: 'channel-post', channel: created.channel,
    key: key(), body: 'no post capability' }), { code: 'unknown-channel' });
  await admin(c.paths, { op: 'channel-grant', principal: host.credential.principal,
    capabilities: principalCapabilities({ create: true, post: [created.channel] }) });
  const posted = await host.request({ op: 'channel-post', channel: created.channel,
    key: key(), body: 'explicit post capability' });
  assert.equal(posted.accepted, true);
  const copy = (await c.soul(c.accounts.bob, { op: 'read' })).messages.find((m) => m.postId === posted.postId);
  assert.equal(copy?.body, 'explicit post capability');
}));

test('principal channel API keeps its fixed protocol identity across create, invite, subscribe, and post', () => fixture(async (c) => {
  const host = await c.newPrincipal('api-roundtrip');
  const api = host.client;
  for (const method of ['grantChannel', 'channelGrant', 'setChannelManager', 'transferChannelManager', 'channelManager']) {
    assert.equal(method in api, false, `principal API must not expose ${method}`);
  }

  await assert.rejects(api.createChannel({ name: 'denied', op: 'channel-grant',
    auth: c.accountCredential, agentId: c.accounts.alice, sender: c.accounts.alice }), { code: 'channel-forbidden' },
  'an ordinary soul messaging grant does not confer channel creation authority');

  await admin(c.paths, { op: 'channel-grant', principal: host.credential.principal,
    capabilities: principalCapabilities({ create: true }) });
  const created = await api.createChannel({ name: 'principal API', op: 'channel-grant',
    auth: c.accountCredential, agentId: c.accounts.alice, sender: c.accounts.alice });
  assert.match(created.channel, /^hub:hub_[0-9a-f-]+\/channel:channel_[0-9a-f-]+$/);

  await admin(c.paths, { op: 'channel-grant', principal: host.credential.principal,
    capabilities: principalCapabilities({ create: true, subscribe: [created.channel], post: [created.channel] }) });
  await api.inviteToChannel({ channel: created.channel, to: host.credential.principal, canPost: true,
    op: 'channel-manager', auth: c.accountCredential, agentId: c.accounts.alice });
  await api.subscribeChannel({ channel: created.channel, wake: false,
    op: 'channel-grant', auth: c.accountCredential, agentId: c.accounts.alice });
  await api.inviteToChannel({ channel: created.channel, to: `${c.owner}/${c.accounts.bob}`, canPost: false,
    op: 'channel-grant', auth: c.accountCredential, agentId: c.accounts.alice });
  await c.soul(c.accounts.bob, { op: 'channel-subscribe', channel: created.channel });

  const posted = await api.postChannel({ channel: created.channel, body: 'principal API post', key: key(),
    op: 'send', auth: c.accountCredential, agentId: c.accounts.alice, sender: c.accounts.alice });
  assert.equal(posted.accepted, true);
  const ownCopy = (await api.inbox({ channel: created.channel })).messages.find((message) => message.postId === posted.postId);
  const bobCopy = (await c.soul(c.accounts.bob, { op: 'read' })).messages.find((message) => message.postId === posted.postId);
  assert.deepEqual(ownCopy?.from, { principal: host.credential.principal });
  assert.equal(ownCopy?.to.principal, host.credential.principal);
  assert.deepEqual(bobCopy?.from, { principal: host.credential.principal });
  assert.equal(bobCopy?.body, 'principal API post');
}));

test('a principal can explicitly receive its own channel copy, but cross-principal fanout fails atomically', () => fixture(async (c) => {
  const principalA = await c.newPrincipal('self-copy', [c.accounts.alice]);
  const principalB = await c.newPrincipal('peer-principal', [c.accounts.alice]);
  const created = await c.soul(c.accounts.alice, { op: 'channel-create', name: 'principal fanout' });

  for (const host of [principalA, principalB]) {
    await c.soul(c.accounts.alice, { op: 'channel-invite', channel: created.channel,
      to: host.credential.principal, canPost: host === principalA });
    await admin(c.paths, { op: 'channel-grant', principal: host.credential.principal,
      capabilities: principalCapabilities({ subscribe: [created.channel], post: host === principalA ? [created.channel] : [] }) });
    await host.request({ op: 'channel-subscribe', channel: created.channel });
  }

  await assert.rejects(principalA.request({ op: 'channel-post', channel: created.channel,
    key: key(), body: 'must not partly reach self' }), { code: 'channel-unavailable' });
  assert.equal((await principalA.request({ op: 'read' })).messages.some((m) => m.body === 'must not partly reach self'), false,
    'a denied principal-to-principal recipient blocks the entire fanout, including the sender self-copy');

  await c.soul(c.accounts.alice, { op: 'channel-remove', channel: created.channel, to: principalB.credential.principal });
  const posted = await principalA.request({ op: 'channel-post', channel: created.channel,
    key: key(), body: 'self copy' });
  const ownCopy = (await principalA.request({ op: 'read' })).messages.find((m) => m.postId === posted.postId);
  assert.equal(ownCopy?.to.principal, principalA.credential.principal);
  assert.equal(ownCopy?.body, 'self copy');
}));

test('full recipient mailboxes refuse an entire channel post without reserving the key', () => fixture(async (c) => {
  const channel = await channelWithMembers(c, [
    { agentId: c.accounts.alice }, { agentId: c.accounts.bob },
  ]);
  await c.soul(c.accounts.alice, { op: 'send', to: c.accounts.bob, key: key(), body: 'occupy mailbox' });
  const postKey = key();
  const seqBefore = c.broker.state.seq;

  await assert.rejects(c.soul(c.accounts.alice, { op: 'channel-post', channel, key: postKey, body: 'atomic candidate' }),
    { code: 'channel-unavailable' });
  assert.equal(c.broker.state.seq, seqBefore, 'failed fanout committed no mailbox copies');
  assert.equal((await c.soul(c.accounts.alice, { op: 'read' })).messages.some((m) => m.body === 'atomic candidate'), false);

  await c.soul(c.accounts.bob, { op: 'ack', ids: (await c.soul(c.accounts.bob, { op: 'read' })).messages.map((m) => m.id) });
  const retried = await c.soul(c.accounts.alice, { op: 'channel-post', channel, key: postKey, body: 'atomic candidate' });
  assert.equal(retried.accepted, true);
  assert.equal(retried.duplicate, false, 'capacity refusal did not consume the idempotency key');
  const aliceCopy = (await c.soul(c.accounts.alice, { op: 'read' })).messages.find((m) => m.postId === retried.postId);
  const bobCopy = (await c.soul(c.accounts.bob, { op: 'read' })).messages.find((m) => m.postId === retried.postId);
  assert.ok(aliceCopy);
  assert.ok(bobCopy);
}, { brokerOptions: { limits: { unackedPerMailbox: 1 } } }));

test('a joined-soul departure blocks the snapshot without exposing a partial post', () => fixture(async (c) => {
  const channel = await channelWithMembers(c, [{ agentId: c.accounts.alice }, { agentId: c.accounts.bob }]);
  await c.soul(c.accounts.bob, { op: 'leave' });
  const before = c.broker.state.seq;
  const result = await c.soul(c.accounts.alice, { op: 'channel-post', channel, key: key(), body: 'blocked by departure' })
    .then(() => null, (error) => error);
  assert.equal(result?.code, 'channel-unavailable');
  assert.equal(result?.message.includes(c.accounts.bob), false);
  assert.equal(c.broker.state.seq, before);
  assert.equal((await c.soul(c.accounts.alice, { op: 'read' })).messages.some((m) => m.body === 'blocked by departure'), false);
}));

test('accepted post retries preserve the original snapshot through membership changes and broker restart', () => fixture(async (c) => {
  const channel = await channelWithMembers(c, [{ agentId: c.accounts.alice }, { agentId: c.accounts.bob }]);
  const request = { op: 'channel-post', channel, key: key(), body: 'stable snapshot' };
  const original = await c.soul(c.accounts.alice, request);
  const originalCopies = [
    ...(await c.soul(c.accounts.alice, { op: 'read' })).messages,
    ...(await c.soul(c.accounts.bob, { op: 'read' })).messages,
  ].filter((m) => m.postId === original.postId);
  assert.equal(originalCopies.length, 2);
  assert.notEqual(originalCopies[0].id, originalCopies[1].id);
  const snapshot = originalCopies.map((m) => m.to.agentId).sort();

  await c.soul(c.accounts.alice, { op: 'channel-remove', channel, to: c.accounts.bob });
  const duplicate = await c.soul(c.accounts.alice, request);
  assert.equal(duplicate.postId, original.postId);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(originalCopies.map((m) => m.to.agentId).sort(), snapshot);

  await c.broker.stop();
  const restarted = await new Broker({ paths: c.paths, mode: 'group' }).start();
  try {
    const replay = await c.soul(c.accounts.alice, request);
    assert.equal(replay.postId, original.postId);
    assert.equal(replay.duplicate, true);
    const aliceCopies = (await c.soul(c.accounts.alice, { op: 'read' })).messages.filter((m) => m.postId === original.postId);
    const bobCopies = (await c.soul(c.accounts.bob, { op: 'read' })).messages.filter((m) => m.postId === original.postId);
    assert.equal(aliceCopies.length, 1);
    assert.equal(bobCopies.length, 1);
    assert.equal(restarted.state.channels.get(channel).members.some((m) => m.endpoint.agentId === c.accounts.bob), false);
  } finally {
    await restarted.stop();
  }
}));

test('direct sends and channel posts share the sender idempotency namespace', () => fixture(async (c) => {
  const channel = await channelWithMembers(c, [{ agentId: c.accounts.alice }, { agentId: c.accounts.bob }]);
  const sharedKey = key();
  await c.soul(c.accounts.alice, { op: 'send', to: c.accounts.bob, key: sharedKey, body: 'direct use' });
  const error = await c.soul(c.accounts.alice, { op: 'channel-post', channel, key: sharedKey, body: 'post use' })
    .then(() => null, (value) => value);
  assert.equal(error?.code, 'conflict');
  assert.equal((await c.soul(c.accounts.alice, { op: 'read' })).messages.some((m) => m.body === 'post use'), false);
}));
