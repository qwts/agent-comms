import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { noChannelCapabilities } from '../lib/channel-state.mjs';
import { admin, callPrincipal, loadCredential, pairPrincipal, loadPrincipalCredential } from '../lib/client.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { readHostConfig } from '../lib/host-config.mjs';
import { withBroker, call } from './helpers/broker.mjs';

const options = { brokerOptions: { mode: 'single-account' } };
function requests(context) {
  const credential = loadCredential(clientPaths(context.env));
  return (soul, op, fields = {}) => call(context.paths, credential, { op, agentId: soul, ...fields });
}
async function host(context, name, grant = null) {
  const env = { ...context.env, AGENT_COMMS_NO_KEYCHAIN: '1', AGENT_COMMS_CREDENTIAL_NAME: `census-${randomUUID()}` };
  const pending = await pairPrincipal(context.paths, clientPaths(env), name, env);
  await admin(context.paths, { op: 'principal-approve', code: pending.code, grant });
  const credential = loadPrincipalCredential(clientPaths(env), readHostConfig(env));
  return { id: credential.principal,
    request: (op, fields = {}) => callPrincipal(context.paths, credential, { op, ...fields }),
    grant: (value) => admin(context.paths, { op: 'channel-grant', principal: credential.principal,
      capabilities: { ...noChannelCapabilities(), ...value } }) };
}
async function subscribe(request, manager, soul, channel) {
  await request(manager, 'channel-invite', { channel, to: soul });
  await request(soul, 'channel-subscribe', { channel });
}

test('channel census requires membership or eligible management; invitations reveal no roster', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'private' });
    const missing = channel.replace(/channel_[^/]+$/, `channel_${randomUUID()}`);
    const inaccessible = async (address) => {
      let refusal;
      await assert.rejects(request(bob, 'channel-census', { channel: address }), (error) => {
        refusal = { code: error.code, message: error.message };
        return error.code === 'unknown-channel';
      });
      return refusal;
    };
    assert.deepEqual(await inaccessible(channel), await inaccessible(missing));
    assert.equal((await request(alice, 'channel-census', { channel })).members.length, 0, 'manager need not subscribe');
    await request(alice, 'channel-invite', { channel, to: bob });
    assert.equal((await request(bob, 'channel-census')).channels.length, 0);
    assert.deepEqual(await inaccessible(channel), await inaccessible(missing));
    await request(bob, 'channel-subscribe', { channel });
    assert.equal((await request(bob, 'channel-census', { channel })).members[0].agentId, bob);
    await request(bob, 'channel-unsubscribe', { channel });
    assert.deepEqual(await inaccessible(channel), await inaccessible(missing));
    assert.equal((await request(bob, 'channel-census')).channels.length, 0);
  }, options);
});

test('soul roster filters peers before paging, hides principals and follows current discovery rules', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'roster' });
    await subscribe(request, alice, alice, channel);
    await subscribe(request, alice, bob, channel);
    await request(bob, 'join', { name: 'hidden-peer', allow: [] });
    const person = await host(context, 'hidden-person');
    await request(alice, 'channel-invite', { channel, to: person.id });
    await person.grant({ subscribe: [channel], census: [channel] });
    await person.request('channel-subscribe', { channel });
    const first = await request(alice, 'channel-census', { channel, limit: 1 });
    assert.deepEqual(first.members.map((row) => row.agentId), [alice]);
    assert.equal(first.cursor, 1);
    assert.equal(first.remaining, 0);
    assert.equal(JSON.stringify(first).includes(bob), false);
    assert.equal(JSON.stringify(first).includes(person.id), false);
    assert.deepEqual((await request(alice, 'peers')).peers, [], 'same receive rule as ordinary peer discovery');
    await request(bob, 'join', { name: 'visible-peer', allow: [alice] });
    const visible = await request(alice, 'channel-census', { channel, limit: 1 });
    const next = await request(alice, 'channel-census', { channel, after: visible.cursor, limit: 1 });
    assert.deepEqual([...visible.members, ...next.members].map((row) => row.agentId).sort(), [alice, bob].sort());
    assert.equal(visible.remaining, 1);
    assert.equal(next.remaining, 0);
    await request(bob, 'leave');
    const left = await request(alice, 'channel-census', { channel });
    assert.deepEqual(left.members.map((row) => row.agentId), [alice]);
    assert.equal(left.cursor, 1);
    assert.equal(left.remaining, 0);
  }, options);
});

test('principal census capability is explicit; roster uses census grants rather than receive permission', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'principal' });
    await subscribe(request, alice, alice, channel);
    await subscribe(request, alice, bob, channel);
    const person = await host(context, 'reader', [alice]);
    const other = await host(context, 'another reader');
    for (const endpoint of [person, other]) {
      await request(alice, 'channel-invite', { channel, to: endpoint.id });
      await endpoint.grant({ subscribe: [channel] });
      await endpoint.request('channel-subscribe', { channel });
    }
    await assert.rejects(person.request('channel-census', { channel }), { code: 'unknown-channel' });
    assert.deepEqual((await person.request('channel-census')).channels, []);
    await person.grant({ subscribe: [channel], census: [channel] });
    await request(alice, 'join', { name: 'not-messageable', allow: [] });
    const page = await person.request('channel-census', { channel });
    assert.deepEqual(page.members.map((row) => row.agentId ?? row.principal).sort(), [alice, person.id].sort());
    assert.equal(page.remaining, 0);
    assert.equal(page.cursor, 2);
    assert.equal(JSON.stringify(page).includes(bob), false);
    assert.equal(JSON.stringify(page).includes(other.id), false);
    await request(alice, 'leave');
    const left = (await person.request('channel-census', { channel })).members.find((row) => row.agentId === alice);
    assert.equal(left.presence, 'left', 'existing principal census includes granted historical souls');
    await person.grant({ subscribe: [channel] });
    await assert.rejects(person.request('channel-census', { channel }), { code: 'unknown-channel' });
  }, options);
});

test('hidden channels do not affect list counts or cursors and manager capability revokes immediately', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const first = await request(alice, 'channel-create', { name: 'one' });
    const second = await request(alice, 'channel-create', { name: 'two' });
    for (const channel of [first.channel, second.channel]) await subscribe(request, alice, bob, channel);
    const before = await request(bob, 'channel-census', { limit: 1 });
    await request(alice, 'channel-create', { name: 'hidden' });
    assert.deepEqual(await request(bob, 'channel-census', { limit: 1 }), before);
    const next = await request(bob, 'channel-census', { after: before.cursor, limit: 1 });
    assert.equal(before.cursor, 1); assert.equal(before.remaining, 1);
    assert.equal(next.cursor, 2); assert.equal(next.remaining, 0);
    assert.deepEqual([before.channels[0].channel, next.channels[0].channel].sort(), [first.channel, second.channel].sort());
    const person = await host(context, 'manager');
    await person.grant({ create: true });
    const managed = await person.request('channel-create', { name: 'managed' });
    await assert.rejects(person.request('channel-census', { channel: managed.channel }), { code: 'unknown-channel' },
      'create-derived management does not grant census');
    assert.deepEqual((await person.request('channel-census')).channels, []);
    await person.grant({ create: true, census: [managed.channel] });
    assert.equal((await person.request('channel-census', { channel: managed.channel })).name, 'managed');
    await person.grant({ census: [managed.channel] });
    await assert.rejects(person.request('channel-census', { channel: managed.channel }), { code: 'unknown-channel' });
    await admin(context.paths, { op: 'channel-manager', channel: first.channel, to: bob });
    await request(bob, 'channel-unsubscribe', { channel: first.channel });
    assert.equal((await request(bob, 'channel-census', { channel: first.channel })).name, 'one');
  }, options);
});

test('channel census rejects malformed selectors and page bounds', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice } = context.accounts;
    for (const fields of [{ channel: 'display-alias' }, { after: -1 }, { after: '1' }, { after: 0.5 },
      { after: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 101 }, { limit: '1' }]) {
      await assert.rejects(request(alice, 'channel-census', fields), { code: 'bad-request' });
    }
    assert.deepEqual(await request(alice, 'channel-census'), { ok: true, channels: [], cursor: 0, remaining: 0 });
  }, options);
});
