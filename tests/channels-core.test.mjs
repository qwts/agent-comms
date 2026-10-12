import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Broker, LIMITS } from '../lib/broker.mjs';
import { admin, callPrincipal, loadCredential, pairPrincipal, loadPrincipalCredential } from '../lib/client.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { readHostConfig } from '../lib/host-config.mjs';
import { EventLog, emptyState } from '../lib/state.mjs';
import { noChannelCapabilities, channelMetadataBytes } from '../lib/channel-state.mjs';
import { withBroker, call } from './helpers/broker.mjs';

const options = (clock = { at: 1000 }, limits = {}) => ({ brokerOptions: { mode: 'single-account', now: () => clock.at,
  limits: { ...LIMITS, maintenanceIntervalMs: 60_000, ...limits } } });
function requests(context) {
  const credential = loadCredential(clientPaths(context.env));
  return (soul, op, fields = {}) => call(context.paths, credential, { op, agentId: soul, ...fields });
}
async function principal(context) {
  const env = { ...context.env, AGENT_COMMS_NO_KEYCHAIN: '1', AGENT_COMMS_CREDENTIAL_NAME: 'channel-test' };
  const pending = await pairPrincipal(context.paths, clientPaths(env), 'channel host', env);
  await admin(context.paths, { op: 'principal-approve', code: pending.code });
  const credential = loadPrincipalCredential(clientPaths(env), readHostConfig(env));
  return { id: credential.principal, request: (op, fields = {}) => callPrincipal(context.paths, credential, { op, ...fields }),
    grant: (value) => admin(context.paths, { op: 'channel-grant', principal: credential.principal, capabilities: { ...noChannelCapabilities(), ...value } }) };
}

test('channel consent, private invitations, explicit posting and subscription lifecycle persist', async () => {
  const clock = { at: 1000 };
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'topic' });
    const duplicateName = await request(alice, 'channel-create', { name: 'topic' });
    assert.notEqual(channel, duplicateName.channel);
    assert.equal(context.broker.state.channels.get(channel).members.length, 0);
    await assert.rejects(request(bob, 'channel-subscribe', { channel }), { code: 'unknown-channel' });
    await assert.rejects(request(bob, 'channel-invite', { channel, to: alice }), { code: 'unknown-channel' });
    assert.deepEqual(await request(alice, 'channel-invite', { channel, to: bob }), { ok: true, accepted: true });
    assert.equal((await request(alice, 'channel-invitations')).invitations.length, 0);
    assert.equal((await request(bob, 'channel-invitations')).invitations.length, 1);
    await request(bob, 'channel-subscribe', { channel });
    assert.equal(context.broker.state.channels.get(channel).members[0].wake, false);
    await assert.rejects(request(bob, 'channel-post', { channel, key: 'denied', body: 'no' }), { code: 'unknown-channel' });
    await request(alice, 'channel-permission', { channel, to: bob, canPost: true });
    await request(bob, 'channel-post', { channel, key: 'allowed', body: 'yes' });
    await request(bob, 'channel-unsubscribe', { channel });
    assert.equal((await request(bob, 'read')).messages.length, 1, 'unsubscribe keeps delivered copies');
    assert.equal((await request(bob, 'channel-invitations')).invitations.length, 0);
    await request(alice, 'channel-invite', { channel, to: bob });
    clock.at += 70;
    assert.equal((await request(bob, 'channel-invitations')).invitations.length, 0, 'exact-deadline invitation expiry');
    const origin = context.broker.state.originHubId;
    context.broker.maintain({ compact: true });
    const replay = new EventLog(context.paths.state).replay();
    assert.equal(replay.originHubId, origin);
    assert.equal(replay.channels.get(channel).name, 'topic');
    assert.equal(replay.channels.get(channel).members.length, 0);
  }, options(clock, { channelInvitationMs: 70 }));
});

test('reinvites accurately disclose independent posting rights and only permission changes revoke them', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'independent posting rights' });
    await request(alice, 'channel-invite', { channel, to: bob, canPost: true });
    await request(bob, 'channel-subscribe', { channel });
    await request(bob, 'channel-unsubscribe', { channel });
    await request(alice, 'channel-invite', { channel, to: bob });
    assert.equal((await request(bob, 'channel-invitations')).invitations[0].canPost, true);
    assert.equal((await request(bob, 'channel-post', { channel, key: 'still-a-poster', body: 'no subscribers' })).accepted, true);
    await request(alice, 'channel-permission', { channel, to: bob, canPost: false });
    assert.equal((await request(bob, 'channel-invitations')).invitations[0].canPost, false);
    await assert.rejects(request(bob, 'channel-post', { channel, key: 'revoked-before-accept', body: 'denied' }), { code: 'unknown-channel' });
    await request(bob, 'channel-subscribe', { channel });
    await assert.rejects(request(bob, 'channel-post', { channel, key: 'revoked-after-accept', body: 'denied' }), { code: 'unknown-channel' });
  }, options());
});

test('principal operation grants are separate, create-derived management revokes immediately and owner transfers manager', async () => {
  await withBroker(async (context) => {
    const host = await principal(context);
    const request = requests(context), { alice, bob } = context.accounts;
    await assert.rejects(host.request('channel-create', { name: 'host' }), { code: 'channel-forbidden' });
    await host.grant({ create: true });
    const { channel } = await host.request('channel-create', { name: 'host' });
    await host.request('channel-invite', { channel, to: bob });
    await host.request('channel-invite', { channel, to: host.id });
    await assert.rejects(host.request('channel-subscribe', { channel }), { code: 'unknown-channel' });
    await host.grant({ create: true, subscribe: [channel], post: [channel] });
    await host.request('channel-subscribe', { channel });
    await request(bob, 'channel-subscribe', { channel });
    const post = await host.request('channel-post', { channel, key: 'principal', body: 'hello' });
    assert.equal(post.accepted, true);
    assert.equal((await host.request('read')).messages[0].postId, post.postId);
    await host.grant({ subscribe: [channel], post: [channel] });
    await assert.rejects(host.request('channel-invite', { channel, to: alice }), { code: 'unknown-channel' });
    await admin(context.paths, { op: 'channel-manager', channel, to: alice });
    await request(alice, 'channel-invite', { channel, to: alice });
    await request(alice, 'channel-subscribe', { channel });
    await request(alice, 'channel-permission', { channel, to: alice, canPost: true });
    await host.grant({ post: [channel] });
    await assert.rejects(request(alice, 'channel-post', { channel, key: 'revoked-subscription', body: 'no' }), { code: 'channel-unavailable' });
    await host.request('channel-unsubscribe', { channel });
    assert.equal((await request(alice, 'channel-post', { channel, key: 'after-removal', body: 'yes' })).accepted, true);
  }, options());
});

test('fan-out is atomic at capacity and failed admission spends neither key nor rate clocks', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'atomic' });
    for (const soul of [alice, bob]) { await request(alice, 'channel-invite', { channel, to: soul }); await request(soul, 'channel-subscribe', { channel }); }
    await request(alice, 'send', { to: bob, key: 'fill-bob', body: 'full' });
    const before = { seq: context.broker.state.seq, rates: JSON.stringify([...context.broker.sendTimes]), dedupe: context.broker.state.idempotency.size };
    await assert.rejects(request(alice, 'channel-post', { channel, key: 'fanout', body: 'payload' }), { code: 'channel-unavailable' });
    assert.equal(context.broker.state.seq, before.seq);
    assert.equal(JSON.stringify([...context.broker.sendTimes]), before.rates);
    assert.equal(context.broker.state.idempotency.size, before.dedupe);
    assert.equal((await request(alice, 'read')).messages.length, 0);
    await request(alice, 'channel-remove', { channel, to: bob });
    const accepted = await request(alice, 'channel-post', { channel, key: 'fanout', body: 'payload' });
    const own = (await request(alice, 'read')).messages[0];
    assert.equal(own.postId, accepted.postId);
    assert.equal(own.channel, channel);
    assert.equal(own.channelWake, false);
    const entry = [...context.broker.state.idempotency.values()].find((item) => item.operation === 'channel-post');
    assert.equal(entry.snapshot.length, 1);
    assert.equal(Object.hasOwn(entry, 'body'), false);
    context.broker.maintain({ compact: true });
    const replay = new EventLog(context.paths.state).replay();
    assert.equal(replay.messages.get(own.id).postId, accepted.postId);
    assert.deepEqual(replay.idempotency.get(`${context.owner} fanout`).outcome, { postId: accepted.postId, accepted: true });
  }, options(undefined, { unackedPerMailbox: 1 }));
});

test('stable retry snapshot, cross-operation conflicts, empty snapshots and exact dedupe window', async () => {
  const clock = { at: 1000 };
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'retry' });
    await request(alice, 'channel-invite', { channel, to: bob }); await request(bob, 'channel-subscribe', { channel });
    const payload = { channel, key: 'retry', body: 'same' };
    const first = await request(alice, 'channel-post', payload);
    await request(bob, 'leave');
    assert.deepEqual(await request(alice, 'channel-post', payload), { ...first, duplicate: true });
    await assert.rejects(request(alice, 'channel-post', { ...payload, body: 'changed' }), { code: 'conflict' });
    await assert.rejects(request(alice, 'send', { to: bob, key: 'retry', body: 'same' }), { code: 'conflict' });
    await request(alice, 'channel-remove', { channel, to: bob });
    const empty = await request(alice, 'channel-post', { channel, key: 'empty', body: 'not archived' });
    assert.equal(empty.accepted, true);
    assert.equal(context.broker.state.seq, 1);
    const zero = [...context.broker.state.idempotency.values()].find((entry) => entry.id === empty.postId);
    assert.deepEqual(zero.snapshot, []);
    clock.at += 50;
    const reused = await request(alice, 'channel-post', payload);
    assert.notEqual(reused.postId, first.postId);
    assert.equal(reused.duplicate, false);
    assert.equal(context.broker.state.seq, 1);
  }, options(clock, { dedupeRetentionMs: 50 }));
});

test('authenticated departed senders retain accepted post retries but cannot admit a new post', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'departed sender' });
    await request(alice, 'channel-invite', { channel, to: bob });
    await request(bob, 'channel-subscribe', { channel });
    const payload = { channel, key: 'accepted-before-leave', body: 'durable' };
    const accepted = await request(alice, 'channel-post', payload);
    await request(alice, 'leave');
    assert.deepEqual(await request(alice, 'channel-post', payload), { ...accepted, duplicate: true });
    await assert.rejects(request(alice, 'channel-post', { ...payload, body: 'changed' }), { code: 'conflict' });
    await assert.rejects(request(alice, 'channel-post', { ...payload, key: 'new-after-leave' }), { code: 'not-joined' });
    assert.equal((await request(bob, 'read')).messages.length, 1);
  }, options());
});

test('lowered membership limits refuse growth while preserving consent withdrawal above the new cap', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts, third = `agent_${randomUUID()}`;
    await request(third, 'join', { name: 'third', harness: 'test' });
    const { channel } = await request(alice, 'channel-create', { name: 'lowered membership capacity' });
    for (const soul of [alice, bob, third]) {
      await request(alice, 'channel-invite', { channel, to: soul });
      await request(soul, 'channel-subscribe', { channel });
    }
    context.broker.limits.channelMembers = 1;
    await request(bob, 'channel-unsubscribe', { channel });
    assert.equal(context.broker.state.channels.get(channel).members.length, 2);
    await assert.rejects(request(alice, 'channel-invite', { channel, to: bob }), { code: 'channel-full' });
    await request(alice, 'channel-remove', { channel, to: third });
    assert.equal(context.broker.state.channels.get(channel).members.length, 1);
    assert.equal(context.broker.state.channels.size, 1);
  }, options());
});

test('channel budgets refuse metadata growth and protected dedupe without reclaiming channels', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'bounded' });
    await assert.rejects(request(alice, 'channel-create', { name: 'over' }), { code: 'channel-full' });
    await request(alice, 'channel-invite', { channel, to: bob });
    await assert.rejects(request(alice, 'channel-invite', { channel, to: alice }), { code: 'channel-full' });
    await request(bob, 'channel-subscribe', { channel });
    await request(alice, 'channel-post', { channel, key: 'protected', body: 'ok' });
    await assert.rejects(request(alice, 'channel-post', { channel, key: 'over', body: 'no' }), { code: 'dedupe-full' });
    const before = channelMetadataBytes(context.broker.state);
    context.broker.limits.channelMetadataBytes = before;
    await assert.rejects(request(alice, 'channel-permission', { channel, to: bob, canPost: true }), { code: 'channel-full' });
    await request(alice, 'channel-remove', { channel, to: bob });
    assert.equal(context.broker.state.channels.size, 1);
    await assert.rejects(request(alice, 'channel-create', { name: 'still occupied' }), { code: 'channel-full' });
  }, options(undefined, { channelsPerCreator: 1, channelMembers: 1, dedupeEntriesPerSender: 1 }));
});

test('strict version-one checkpoint migration adds empty channel state and rejects unknown fields', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'channel-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = new EventLog(root), state = emptyState();
  log.compact(state);
  const fixture = JSON.parse(readFileSync(log.file, 'utf8'));
  fixture.version = 1;
  for (const field of ['originHubId', 'channels', 'principalChannelGrants', 'daemonEpochs']) delete fixture.snapshot[field];
  fixture.checksum = createHash('sha256').update(JSON.stringify(fixture.snapshot)).digest('hex');
  writeFileSync(log.file, `${JSON.stringify(fixture)}\n`);
  assert.equal(new EventLog(root).replay().originHubId, null);
  fixture.snapshot.extra = [];
  fixture.checksum = createHash('sha256').update(JSON.stringify(fixture.snapshot)).digest('hex');
  const bad = `${JSON.stringify(fixture)}\n{"t":"torn`;
  writeFileSync(log.file, bad);
  assert.throws(() => new EventLog(root).replay(), /checkpoint fields/);
  assert.equal(readFileSync(log.file, 'utf8'), bad);
});

test('version-one accepted direct retry survives migration and still conflicts with a channel post', async () => {
  const clock = { at: 1000 };
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const sent = await request(alice, 'send', { to: bob, key: 'legacy-key', body: 'legacy' });
    context.broker.maintain({ compact: true });
    await context.broker.stop();
    const fixture = JSON.parse(readFileSync(context.broker.log.file, 'utf8'));
    fixture.version = 1;
    for (const field of ['originHubId', 'channels', 'principalChannelGrants', 'daemonEpochs']) delete fixture.snapshot[field];
    const entry = fixture.snapshot.idempotency[0][1];
    delete entry.operation;
    entry.fingerprint = createHash('sha256').update(JSON.stringify([alice, bob, 'message', 'legacy', [], null, null])).digest('hex');
    fixture.checksum = createHash('sha256').update(JSON.stringify(fixture.snapshot)).digest('hex');
    writeFileSync(context.broker.log.file, `${JSON.stringify(fixture)}\n`);
    const restarted = await new Broker({ paths: context.paths, ...options(clock).brokerOptions }).start();
    try {
      const retry = await request(alice, 'send', { to: bob, key: 'legacy-key', body: 'legacy' });
      assert.deepEqual(retry, { ...sent, duplicate: true });
      const { channel } = await request(alice, 'channel-create', { name: 'new version' });
      await assert.rejects(request(alice, 'channel-post', { channel, key: 'legacy-key', body: 'legacy' }), { code: 'conflict' });
      assert.equal(JSON.parse(readFileSync(restarted.log.file, 'utf8').split('\n')[0]).version, 3);
    } finally { await restarted.stop(); }
  }, options(clock));
});

test('complete fan-out replay, torn-tail recovery and body expiry preserve only bounded post outcomes', async (t) => {
  const clock = { at: 1000 };
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'recover' });
    for (const soul of [alice, bob]) { await request(alice, 'channel-invite', { channel, to: soul }); await request(soul, 'channel-subscribe', { channel }); }
    context.broker.maintain({ compact: true });
    const baseline = readFileSync(context.broker.log.file);
    const accepted = await request(alice, 'channel-post', { channel, key: 'batch', body: 'body ☃' });
    const complete = readFileSync(context.broker.log.file);
    const root = mkdtempSync(path.join(os.tmpdir(), 'channel-torn-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const log = new EventLog(root);
    writeFileSync(log.file, complete.subarray(0, complete.length - 4));
    const torn = log.replay();
    assert.equal(torn.seq, 0);
    assert.equal(torn.messages.size, 0);
    assert.deepEqual(readFileSync(log.file), baseline);
    writeFileSync(log.file, complete);
    const replay = new EventLog(root).replay();
    assert.equal(replay.seq, 2);
    assert.equal(replay.messages.size, 2);
    const own = (await request(alice, 'read')).messages[0];
    const other = (await request(bob, 'read')).messages[0];
    assert.notEqual(own.id, other.id);
    assert.equal(other.seq, own.seq + 1);
    await request(alice, 'ack', { ids: [own.id] });
    assert.equal((await request(bob, 'read')).messages.length, 1);
    clock.at += 10;
    await request(bob, 'read');
    assert.equal(context.broker.state.messages.size, 0);
    assert.equal(context.broker.state.idempotency.size, 1);
    assert.deepEqual(await request(alice, 'channel-post', { channel, key: 'batch', body: 'body ☃' }), { ...accepted, duplicate: true });
    assert.equal(readFileSync(context.broker.log.file, 'utf8').includes('body ☃'), false, 'expired bodies leave no channel archive');
  }, options(clock, { messageRetentionMs: 10, dedupeRetentionMs: 100 }));
});

test('fan-out event byte bound rejects before committing any copy or spending its key', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'byte bound' });
    await request(alice, 'channel-invite', { channel, to: bob }); await request(bob, 'channel-subscribe', { channel });
    await assert.rejects(request(alice, 'channel-post', { channel, key: 'too-big', body: 'payload' }), { code: 'channel-full' });
    assert.equal(context.broker.state.seq, 0);
    assert.equal(context.broker.state.idempotency.size, 0);
    await request(alice, 'channel-remove', { channel, to: bob });
    await assert.rejects(request(alice, 'channel-post', { channel, key: 'too-big', body: 'empty snapshot' }), { code: 'channel-full' });
    assert.equal(context.broker.state.idempotency.size, 0, 'empty snapshots still admit their durable retry envelope');
  }, options(undefined, { channelPostBytes: 1 }));
});

test('fan-out byte admission counts the entire durable event and accepts the exact serialized boundary', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'complete event byte budget' });
    await request(alice, 'channel-invite', { channel, to: bob });
    await request(bob, 'channel-subscribe', { channel });
    const body = 'x'.repeat(256), before = readFileSync(context.broker.log.file);
    const ratesBefore = JSON.stringify([...context.broker.sendTimes]);
    await assert.rejects(request(alice, 'channel-post', { channel, key: 'byte-budget', body }), { code: 'channel-full' });
    assert.deepEqual(readFileSync(context.broker.log.file), before);
    assert.equal(context.broker.state.seq, 0);
    assert.equal(context.broker.state.idempotency.size, 0);
    assert.equal(JSON.stringify([...context.broker.sendTimes]), ratesBefore);
    context.broker.limits.channelPostBytes = 4096;
    await request(alice, 'channel-post', { channel, key: 'byte-budget', body });
    const eventLine = readFileSync(context.broker.log.file, 'utf8').trimEnd().split('\n').at(-1);
    const event = JSON.parse(eventLine), bytes = Buffer.byteLength(`${eventLine}\n`);
    assert.equal(event.t, 'channel-post');
    assert.ok(bytes > 1200, 'snapshot and retry envelope exceed the former message-only estimate');
    context.broker.limits.channelPostBytes = bytes;
    await request(alice, 'channel-post', { channel, key: 'byte-budge2', body });
    const exactLine = readFileSync(context.broker.log.file, 'utf8').trimEnd().split('\n').at(-1);
    assert.equal(Buffer.byteLength(`${exactLine}\n`), bytes);
    context.broker.limits.channelPostBytes = bytes - 1;
    const acceptedBytes = readFileSync(context.broker.log.file), acceptedRates = JSON.stringify([...context.broker.sendTimes]);
    await assert.rejects(request(alice, 'channel-post', { channel, key: 'byte-budge3', body }), { code: 'channel-full' });
    assert.deepEqual(readFileSync(context.broker.log.file), acceptedBytes);
    assert.equal(context.broker.state.seq, 2);
    assert.equal(context.broker.state.idempotency.size, 2);
    assert.equal(JSON.stringify([...context.broker.sendTimes]), acceptedRates);
    context.broker.limits.channelPostBytes = bytes;
    assert.equal((await request(alice, 'channel-post', { channel, key: 'byte-budge3', body })).duplicate, false);
  }, options(undefined, { channelPostBytes: 1200 }));
});

test('version-two channel corruption refuses startup without modifying committed bytes or its torn suffix', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'validate' });
    await request(alice, 'channel-invite', { channel, to: bob }); await request(bob, 'channel-subscribe', { channel });
    await request(alice, 'channel-post', { channel, key: 'validate', body: 'same' });
    context.broker.maintain({ compact: true });
    const original = JSON.parse(readFileSync(context.broker.log.file, 'utf8'));
    const mutations = [
      (record) => { record.snapshot.originHubId = 'forged'; },
      (record) => { record.snapshot.channels[0][1].creatorNamespace = 'other'; },
      (record) => { record.snapshot.channels[0][1].members.push(record.snapshot.channels[0][1].members[0]); },
      (record) => { record.snapshot.channels[0][1].archive = ['body']; },
      (record) => { record.snapshot.idempotency[0][1].snapshot[0].seq += 1; },
      (record) => { record.snapshot.idempotency[0][1].outcome.accepted = false; },
      (record) => { record.snapshot.idempotency[0][1].snapshot[0].to = { principal: 'principal_forged' }; },
    ];
    const root = mkdtempSync(path.join(os.tmpdir(), 'channel-corrupt-'));
    try {
      const log = new EventLog(root);
      for (const mutate of mutations) {
        const record = structuredClone(original);
        mutate(record);
        record.checksum = createHash('sha256').update(JSON.stringify(record.snapshot)).digest('hex');
        const bytes = `${JSON.stringify(record)}\n{"t":"torn`;
        writeFileSync(log.file, bytes);
        assert.throws(() => new EventLog(root).replay(), /invalid channel/);
        assert.equal(readFileSync(log.file, 'utf8'), bytes);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, options());
});

test('ambiguous fan-out append failure poisons the writer and complete replay restores every copy and retry', async () => {
  await withBroker(async (context) => {
    const request = requests(context), { alice, bob } = context.accounts;
    const { channel } = await request(alice, 'channel-create', { name: 'ambiguous' });
    for (const soul of [alice, bob]) { await request(alice, 'channel-invite', { channel, to: soul }); await request(soul, 'channel-subscribe', { channel }); }
    const io = context.broker.log.io;
    context.broker.log.io = { ...io, fsyncSync() { throw new Error('simulated uncertain flush'); } };
    await assert.rejects(request(alice, 'channel-post', { channel, key: 'uncertain', body: 'same' }), { code: 'storage-failed' });
    assert.equal(context.broker.log.poisoned, true);
    assert.equal(context.broker.state.messages.size, 0);
    assert.equal(context.broker.sendTimes.size, 0);
    await assert.rejects(request(alice, 'channel-post', { channel, key: 'another', body: 'no' }), { code: 'storage-failed' });
    context.broker.log.io = io;
    const replay = new EventLog(context.paths.state).replay();
    assert.equal(replay.messages.size, 2);
    assert.equal(replay.idempotency.get(`${context.owner} uncertain`).snapshot.length, 2);
    assert.equal(replay.seq, 2);
  }, options());
});
