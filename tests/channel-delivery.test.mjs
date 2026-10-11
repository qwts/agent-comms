import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { admin, call, loadCredential, pairPrincipal, loadPrincipalCredential, callPrincipal } from '../lib/client.mjs';
import { sha256 } from '../lib/broker.mjs';
import { noChannelCapabilities } from '../lib/channel-state.mjs';
import { readHostConfig } from '../lib/host-config.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { PROTOCOL_VERSION, writeLine } from '../lib/wire.mjs';
import { withBroker } from './helpers/broker.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return; await pause(5); }
  throw new Error(`timed out: ${label}`);
}
const wakes = (stream) => stream.events.filter((event) => event.event === 'wake');
const copies = (stream) => stream.events.filter((event) => event.event === 'message').map((event) => event.message);

async function fixture(run, limits = {}, clock) {
  return withBroker(async (context) => {
    const credential = loadCredential(clientPaths(context.env));
    const streams = [];
    const request = (agentId, op, fields = {}) => call(context.paths, credential, { op, agentId, ...fields });
    const stream = async (fields) => {
      const socket = net.createConnection(context.paths.socket);
      const result = { socket, events: [] };
      streams.push(result);
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) if (line) result.events.push(JSON.parse(line));
      });
      socket.on('error', (error) => { result.error = error; });
      socket.on('connect', () => writeLine(socket, { v: PROTOCOL_VERSION,
        auth: { account: credential.account, secret: credential.secret }, ...fields }));
      await until(() => result.events.length > 0 || result.error, 'stream ready');
      if (result.error) throw result.error;
      assert.equal(result.events[0].event, 'ready', JSON.stringify(result.events));
      return result;
    };
    const channel = async (name, { wake = false } = {}) => {
      const { channel: address } = await request(context.accounts.alice, 'channel-create', { name });
      await request(context.accounts.alice, 'channel-invite', { channel: address, to: context.accounts.bob });
      await request(context.accounts.bob, 'channel-subscribe', { channel: address, wake });
      return address;
    };
    const post = (channel, body) => request(context.accounts.alice, 'channel-post', { channel, body, key: randomUUID() });
    const daemon = async () => {
      const secret = randomBytes(32).toString('hex'), secretHash = sha256(secret), proof = `${randomUUID()}.proof`;
      const { publicKey } = generateKeyPairSync('ed25519');
      writeFileSync(path.join(context.paths.proofs, proof), secretHash, { mode: 0o644, flag: 'wx' });
      const pending = await call(context.paths, credential, { op: 'daemon-pair-request', account: context.owner,
        secretHash, proof, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
      await admin(context.paths, { op: 'approve', code: pending.code });
      return { daemon: context.owner, secret };
    };
    try { return await run({ ...context, request, stream, channel, post, daemon }); }
    finally { for (const { socket } of streams) socket.destroy(); }
  }, { brokerOptions: { mode: 'group', ...(clock ? { now: () => clock.at } : {}),
    limits: { wakeWindowMs: 50, wakeRateMs: 200, maintenanceIntervalMs: 60_000, ...limits } } });
}

test('channel reads page in mailbox order, advance across nonmatches and never acknowledge copies', () => fixture(async (c) => {
  const { alice, bob } = c.accounts;
  const a = await c.channel('A'), b = await c.channel('B');
  await c.request(alice, 'send', { to: bob, key: 'before', body: 'direct before' });
  await c.post(b, 'B before'); await c.post(a, 'A first');
  await c.post(b, 'B middle'); await c.post(a, 'A second');
  await c.request(alice, 'send', { to: bob, key: 'after', body: 'direct after' });
  const first = await c.request(bob, 'read', { channel: a, limit: 1 });
  assert.deepEqual(first.messages.map((m) => m.body), ['A first']);
  assert.equal(first.cursor, 4, 'examines the intervening nonmatching message');
  assert.equal(first.remaining, 1);
  const second = await c.request(bob, 'read', { channel: a, after: first.cursor, limit: 1 });
  assert.deepEqual(second.messages.map((m) => m.body), ['A second']);
  assert.equal(second.cursor, 6); assert.equal(second.remaining, 0);
  assert.equal((await c.request(bob, 'read')).messages.length, 6);
  const empty = await c.request(bob, 'read', { channel: a.replace(/channel_[0-9a-f-]+$/, `channel_${randomUUID()}`) });
  assert.deepEqual(empty.messages, []); assert.equal(empty.cursor, 6); assert.equal(empty.remaining, 0);
  await assert.rejects(c.request(bob, 'read', { channel: 'A' }), { code: 'bad-request' });
}));

test('filtered full streams receive live and reconnect copies with wake disabled and after unsubscribe', () => fixture(async (c) => {
  const { alice, bob } = c.accounts;
  const a = await c.channel('A'), b = await c.channel('B');
  const full = await c.stream({ op: 'watch', agentId: bob, mode: 'full', channel: a });
  const wake = await c.stream({ op: 'watch', agentId: bob, mode: 'wake', channel: a });
  await c.post(b, 'hidden B');
  const direct = await c.request(alice, 'send', { to: bob, key: 'hidden-direct', body: 'hidden direct' });
  assert.equal(direct.wake, 'waiting', 'a nonmatching filtered watch does not claim warm delivery');
  await c.post(a, 'visible A');
  await until(() => copies(full).length === 1, 'live full channel copy');
  await pause(100);
  assert.deepEqual(copies(full).map((m) => m.body), ['visible A']);
  assert.equal(wakes(wake).length, 0);
  assert.equal(copies(full)[0].channelWake, false);
  await c.request(bob, 'channel-unsubscribe', { channel: a });
  full.socket.destroy(); wake.socket.destroy();
  const reopened = await c.stream({ op: 'watch', agentId: bob, channel: a });
  await until(() => copies(reopened).length === 1, 'delivered copy after unsubscribe');
  assert.equal(copies(reopened)[0].body, 'visible A');
  assert.equal((await c.request(bob, 'read', { channel: a })).messages.length, 1);
}));

test('filtered wakes share one coalescer but exclude muted and other-channel copies', () => fixture(async (c) => {
  const bob = c.accounts.bob;
  const a = await c.channel('A'), b = await c.channel('B', { wake: true });
  await c.post(a, 'committed muted');
  await c.request(bob, 'channel-wake', { channel: a, wake: true });
  const aw = await c.stream({ op: 'watch', agentId: bob, mode: 'wake', channel: a });
  const bw = await c.stream({ op: 'watch', agentId: bob, mode: 'wake', channel: b });
  await c.post(a, 'A opted in'); await c.post(b, 'B opted in');
  await until(() => wakes(aw).length === 1 && wakes(bw).length === 1, 'filtered coalesced wakes');
  assert.deepEqual(wakes(aw), [{ event: 'wake', count: 1, cursor: 2 }]);
  assert.deepEqual(wakes(bw), [{ event: 'wake', count: 1, cursor: 3 }]);
  const page = await c.request(bob, 'read');
  assert.equal(page.messages.length, 3); assert.equal(page.messages[0].channelWake, false);
}));

test('buffered wakes recheck opt-in, subscription, sender posting permission and receive allowlists', () => fixture(async (c) => {
  const { alice, bob } = c.accounts;
  const a = await c.channel('A', { wake: true });
  const wake = await c.stream({ op: 'watch', agentId: bob, mode: 'wake', channel: a });
  await c.post(a, 'cancel opt-in');
  await c.request(bob, 'channel-wake', { channel: a, wake: false }); await pause(100);
  assert.equal(wakes(wake).length, 0);
  await c.request(bob, 'channel-wake', { channel: a, wake: true });
  await c.post(a, 'cancel posting');
  await c.request(alice, 'channel-permission', { channel: a, to: alice, canPost: false }); await pause(100);
  assert.equal(wakes(wake).length, 0);
  await c.request(alice, 'channel-permission', { channel: a, to: alice, canPost: true });
  await c.post(a, 'cancel allowlist');
  await c.request(bob, 'join', { allow: [] }); await pause(100);
  assert.equal(wakes(wake).length, 0);
  await c.request(bob, 'join', { allow: null });
  await c.post(a, 'cancel subscription');
  await c.request(bob, 'channel-unsubscribe', { channel: a }); await pause(100);
  assert.equal(wakes(wake).length, 0);
  assert.equal((await c.request(bob, 'read', { channel: a })).messages.length, 4);
  const reconnect = await c.stream({ op: 'watch', agentId: bob, mode: 'wake', channel: a });
  await pause(100); assert.equal(wakes(reconnect).length, 0);
}, { wakeWindowMs: 75 }));

test('account-watch rechecks channel wake eligibility when releasing rate-held IDs and reconnecting', () => fixture(async (c) => {
  const { alice, bob } = c.accounts;
  const a = await c.channel('A', { wake: true }), auth = await c.daemon();
  const account = await c.stream({ op: 'account-watch', auth });
  await c.request(alice, 'send', { to: bob, key: 'account-primer', body: 'direct' });
  await until(() => wakes(account).length === 1, 'first account wake');
  const direct = (await c.request(bob, 'read')).messages[0];
  await c.request(bob, 'ack', { ids: [direct.id] });
  await c.post(a, 'held then muted');
  await pause(50);
  await c.request(bob, 'channel-wake', { channel: a, wake: false });
  await pause(250);
  assert.equal(wakes(account).length, 1, 'held channel ID is rechecked at rate release');
  account.socket.destroy();
  const reopened = await c.stream({ op: 'account-watch', auth });
  await pause(100); assert.equal(wakes(reopened).length, 0);
  assert.equal((await c.request(bob, 'read', { channel: a })).messages[0].body, 'held then muted');
}, { wakeWindowMs: 20, wakeRateMs: 250 }));

test('channel wake timers refuse expired copies even before the next maintenance request', async () => {
  const clock = { at: 1000 };
  await fixture(async (c) => {
    const bob = c.accounts.bob, channel = await c.channel('expires before wake', { wake: true });
    const wake = await c.stream({ op: 'watch', agentId: bob, mode: 'wake', channel });
    await c.post(channel, 'short lived');
    clock.at += 50;
    await pause(125);
    assert.equal(wakes(wake).length, 0);
    assert.equal(c.broker.state.messages.size, 1, 'no maintenance request was used to suppress the side effect');
    const page = await c.request(bob, 'read', { channel });
    assert.equal(page.messages.length, 0); assert.equal(page.gap.count, 1);
  }, { messageRetentionMs: 50, wakeWindowMs: 100 }, clock);
});

test('channel filters retain mailbox-wide gaps before backlog and leave gap and copy receipts independent', async () => {
  const clock = { at: 1000 };
  await fixture(async (c) => {
    const { alice, bob } = c.accounts;
    const a = await c.channel('A'), b = await c.channel('B');
    await c.post(b, 'expires outside filter');
    clock.at += 100;
    await c.post(a, 'retained target');
    const page = await c.request(bob, 'read', { channel: a });
    assert.equal(page.gap.count, 1); assert.equal(page.messages.length, 1);
    const full = await c.stream({ op: 'watch', agentId: bob, mode: 'full', channel: a });
    await until(() => copies(full).length === 1, 'gap before filtered backlog');
    assert.deepEqual(full.events.map((event) => event.event), ['ready', 'gap', 'message']);
    await c.request(bob, 'ack', { ids: [page.messages[0].id] });
    const afterCopyAck = await c.request(bob, 'read', { channel: a });
    assert.equal(afterCopyAck.messages.length, 0); assert.equal(afterCopyAck.gap.count, 1);
    await c.request(bob, 'gap-ack', { through: page.gap.through });
    assert.equal((await c.request(bob, 'read', { channel: a })).gap, undefined);
    assert.equal((await c.request(alice, 'read', { channel: a })).gap, undefined);
  }, { messageRetentionMs: 100 }, clock);
});

test('principal capability revocation suppresses delayed wake without changing committed copies or retries', () => fixture(async (c) => {
  const bob = c.accounts.bob;
  const env = { ...c.env, AGENT_COMMS_NO_KEYCHAIN: '1', AGENT_COMMS_CREDENTIAL_NAME: 'wake-principal' };
  const pending = await pairPrincipal(c.paths, clientPaths(env), 'wake principal', env);
  await admin(c.paths, { op: 'principal-approve', code: pending.code, grant: [bob] });
  const credential = loadPrincipalCredential(clientPaths(env), readHostConfig(env));
  const host = (op, fields = {}) => callPrincipal(c.paths, credential, { op, ...fields });
  const grant = (value) => admin(c.paths, { op: 'channel-grant', principal: credential.principal,
    capabilities: { ...noChannelCapabilities(), ...value } });
  await grant({ create: true });
  const { channel } = await host('channel-create', { name: 'principal wake' });
  await grant({ create: true, post: [channel], subscribe: [channel] });
  await host('channel-invite', { channel, to: credential.principal });
  await host('channel-subscribe', { channel });
  await host('channel-invite', { channel, to: bob });
  await c.request(bob, 'channel-subscribe', { channel, wake: true });
  const wake = await c.stream({ op: 'watch', agentId: bob, mode: 'wake', channel });
  const payload = { channel, key: 'principal-delayed', body: 'committed' };
  const accepted = await host('channel-post', payload);
  await grant({ create: true }); await pause(125);
  assert.equal(wakes(wake).length, 0);
  assert.deepEqual(await host('channel-post', payload), { ...accepted, duplicate: true });
  assert.equal((await c.request(bob, 'read', { channel })).messages[0].body, 'committed');
  await c.request(bob, 'send', { to: credential.principal, key: 'principal-nonmatch', body: 'direct inbox copy' });
  const principalPage = await host('read', { channel });
  assert.deepEqual(principalPage.messages.map((message) => message.body), ['committed']);
  assert.equal(principalPage.cursor, c.broker.state.seq);
  assert.equal((await host('read')).messages.length, 2);
}, { wakeWindowMs: 100 }));
