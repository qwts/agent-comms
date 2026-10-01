import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';
import { test } from 'node:test';

import { Broker, LIMITS } from '../lib/broker.mjs';
import { admin, call, callPrincipal, loadCredential, loadPrincipalCredential, pairPrincipal } from '../lib/client.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { createPrincipalClient } from '../lib/principal-client.mjs';
import { createSecretStore } from '../lib/platform/secret-store.mjs';
import { turnPrompt } from '../lib/worker/prompt.mjs';
import { withBroker } from './helpers/broker.mjs';

const singleAccount = { brokerOptions: { mode: 'single-account' } };

async function setup(context, grant = null) {
  const env = { ...context.env, AGENT_COMMS_NO_KEYCHAIN: '1', AGENT_COMMS_CREDENTIAL_NAME: 'org.example.owner' };
  const pending = await pairPrincipal(context.paths, clientPaths(env), 'Example host', env);
  const client = createPrincipalClient({ env });
  const credential = loadPrincipalCredential(clientPaths(env));
  const account = loadCredential(clientPaths(env));
  assert.equal(credential.mode, 'single-account');
  const approve = () => admin(context.paths, { op: 'principal-approve', code: pending.code, grant });
  return { env, client, credential, account, approve };
}

test('example host: pair, approve, census, send, receive a reply, page and acknowledge', async () => {
  await withBroker(async (context) => {
    const { paths, accounts } = context;
    const { client, approve, account, env } = await setup(context);
    await assert.rejects(client.census(), { code: 'not-approved' });
    await assert.rejects(client.send({ to: accounts.bob, body: 'hello', key: 'hello' }), { code: 'not-approved' });
    await assert.rejects(client.inbox(), { code: 'not-approved' });
    await approve();
    rmSync(clientPaths(env).credential);
    assert.equal(createPrincipalClient({ env }).principal, client.principal, 'an account credential is not needed after setup');
    const { souls } = await client.census();
    assert.deepEqual(souls.map((soul) => soul.agentId).sort(), Object.values(accounts).sort());
    const bob = souls.find((soul) => soul.agentId === accounts.bob);
    const sent = await client.send({ to: `${bob.account}/${bob.agentId}`, body: 'hello', key: 'hello',
      kind: 'task', refs: ['local:example'], correlation: 'conversation' });
    const incoming = await call(paths, account, { op: 'read', agentId: bob.agentId });
    assert.equal(incoming.messages.length, 1);
    const message = incoming.messages[0];
    assert.deepEqual(message.from, { principal: client.principal });
    assert.equal(message.id, sent.messageId);
    assert.equal(message.body, 'hello');
    assert.equal(message.kind, 'task');
    assert.deepEqual(message.refs, ['local:example']);
    assert.equal(message.correlation, 'conversation');
    assert.equal(sent.wake, 'waiting');
    assert.match(turnPrompt(message, { harness: 'example' }), /principal_.*identity: principal credential/);
    for (const key of ['reply-1', 'reply-2']) {
      await call(paths, account, { op: 'send', agentId: bob.agentId, to: message.from.principal,
        body: key, key, replyTo: sent.messageId });
    }
    const first = await client.inbox({ limit: 1 });
    assert.equal(first.messages.length, 1);
    assert.equal(first.remaining, 1);
    assert.deepEqual(first.messages[0].to, { principal: client.principal });
    assert.equal(first.messages[0].replyTo, sent.messageId);
    assert.equal(first.messages[0].depth, 1);
    const second = await client.inbox({ after: first.cursor });
    assert.equal(second.messages[0].body, 'reply-2');
    assert.equal(second.remaining, 0);
    assert.equal((await client.inbox()).messages.length, 2, 'read does not acknowledge');
    const ids = [...first.messages, ...second.messages].map((reply) => reply.id);
    assert.equal((await client.ack(ids)).acknowledged, 2);
    assert.equal((await client.ack(ids)).alreadyAcknowledged, 2);
    assert.deepEqual((await client.inbox()).messages, []);
    assert.equal((await client.census()).souls.length, 2, 'principals never become souls');
  }, singleAccount);
});

test('principal sends obey receive allowlists, leave and account revocation', async () => {
  await withBroker(async (context) => {
    const { paths, accounts, owner } = context;
    const { client, account, approve } = await setup(context);
    await approve();
    const join = (allow) => call(paths, account, { op: 'join', agentId: accounts.bob, allow });
    const send = (key) => client.send({ to: accounts.bob, body: 'hello', key });
    for (const allow of [[], [owner], [accounts.alice], [`${owner}/${accounts.alice}`]]) {
      await join(allow);
      await assert.rejects(send('denied'), { code: 'unknown-recipient' });
    }
    await join([client.principal]);
    assert.equal((await send('explicit')).duplicate, false);
    await join(null);
    assert.equal((await send('open')).duplicate, false);
    await call(paths, account, { op: 'leave', agentId: accounts.bob });
    await assert.rejects(send('left'), { code: 'unknown-recipient' });
    assert.equal((await send('open')).duplicate, true, 'retry returns the committed result');
    await join(null);
    await admin(paths, { op: 'revoke', account: owner });
    await assert.rejects(send('revoked-account'), { code: 'unknown-recipient' });
  }, singleAccount);
});

test('the grant bounds census, principal sends and messages into its inbox', async () => {
  await withBroker(async (context) => {
    const { paths, accounts } = context;
    const { client, account, approve } = await setup(context, [accounts.bob]);
    await approve();
    assert.deepEqual((await client.census()).souls.map((soul) => soul.agentId), [accounts.bob]);
    await assert.rejects(client.send({ to: accounts.alice, body: 'hidden', key: 'hidden' }), { code: 'unknown-recipient' });
    await assert.rejects(call(paths, account, { op: 'send', agentId: accounts.alice, to: client.principal,
      body: 'outside grant', key: 'outside' }), { code: 'unknown-recipient' });
    await client.send({ to: accounts.bob, body: 'allowed', key: 'allowed' });
    await call(paths, account, { op: 'send', agentId: accounts.bob, to: client.principal, body: 'inside', key: 'inside' });
    assert.equal((await client.inbox()).messages[0].body, 'inside');
  }, singleAccount);
});

test('credentials confer only principal authority; no impersonation, admin, or other inbox access', async () => {
  await withBroker(async (context) => {
    const { paths, accounts } = context;
    const { client, credential, account, approve, env } = await setup(context);
    await approve();
    for (const op of ['join', 'leave', 'peers', 'watch', 'account-watch', 'wake-report', 'principal-pair-request']) {
      await assert.rejects(callPrincipal(paths, credential, { op, agentId: accounts.alice }), { code: 'unauthenticated' });
    }
    for (const op of ['approve', 'principal-approve', 'principal-revoke']) {
      await assert.rejects(callPrincipal(paths, credential, { op }), { code: 'unknown-operation' });
    }
    for (const op of ['read', 'ack', 'send']) {
      await assert.rejects(callPrincipal(paths, credential, { op, agentId: accounts.alice }), { code: 'unauthenticated' });
    }
    await assert.rejects(callPrincipal(paths, credential, { op: 'send', sender: accounts.alice,
      to: accounts.bob, body: 'spoof', key: 'spoof' }), { code: 'unauthenticated' });
    const forged = createPrincipalClient({ env, credentialLoader: () => ({ ...credential, secret: 'wrong' }) });
    for (const operation of [() => forged.census(), () => forged.inbox(),
      () => forged.send({ to: accounts.alice, body: 'forged', key: 'forged' })]) {
      await assert.rejects(operation(), { code: 'unauthenticated' });
    }
    const other = await setup(context);
    await other.approve();
    await call(paths, account, { op: 'send', agentId: accounts.bob, to: other.client.principal, body: 'private', key: 'private' });
    const privateMessage = (await other.client.inbox()).messages[0];
    assert.deepEqual((await client.inbox()).messages, []);
    await assert.rejects(client.ack([privateMessage.id]), { code: 'unknown-message' });
    await assert.rejects(client.send({ to: accounts.bob, body: 'steal reply', key: 'steal', replyTo: privateMessage.id }), { code: 'unknown-message' });
    // Extra host fields cannot replace the protocol op, auth, or sender.
    await client.send({ to: accounts.bob, body: 'safe', key: 'safe', op: 'join', auth: account,
      agentId: accounts.alice, sender: accounts.alice });
    assert.deepEqual((await call(paths, account, { op: 'read', agentId: accounts.bob })).messages[0].from,
      { principal: client.principal });
    await admin(paths, { op: 'principal-revoke', principal: client.principal });
    for (const operation of [() => client.census(), () => client.inbox(), () => client.ack([privateMessage.id]),
      () => client.send({ to: accounts.bob, body: 'safe', key: 'safe' })]) {
      await assert.rejects(operation(), { code: 'unauthenticated' });
    }
    await assert.rejects(call(paths, account, { op: 'send', agentId: accounts.bob, to: client.principal,
      body: 'revoked', key: 'revoked' }), { code: 'unknown-recipient' });
  }, singleAccount);
});

test('principal mailboxes, acknowledgements and idempotency survive broker restart', async () => {
  await withBroker(async (context) => {
    const { paths, accounts, broker } = context;
    const { client, approve, account } = await setup(context);
    await approve();
    const payload = { to: accounts.bob, body: 'durable', key: 'shared-key' };
    const sent = await client.send(payload);
    const other = await setup(context);
    await other.approve();
    assert.notEqual((await other.client.send(payload)).messageId, sent.messageId, 'keys are principal scoped');
    for (const key of ['shared-key', 'unread']) {
      await call(paths, account, { op: 'send', agentId: accounts.bob, to: client.principal, body: key, key });
    }
    const inbox = await client.inbox();
    await client.ack([inbox.messages[0].id]);
    await broker.stop();
    const restarted = await new Broker({ paths, mode: 'single-account' }).start();
    try {
      assert.equal((await client.send(payload)).messageId, sent.messageId);
      assert.equal((await client.send(payload)).duplicate, true);
      await assert.rejects(client.send({ ...payload, body: 'different' }), { code: 'conflict' });
      assert.equal((await client.inbox()).messages[0].body, 'unread');
      assert.equal((await client.inbox()).messages.length, 1);
      assert.equal((await client.ack([inbox.messages[0].id])).alreadyAcknowledged, 1);
    } finally { await restarted.stop(); }
  }, singleAccount);
});

test('principal operations retain message validation, paging, custody and rate limits', async () => {
  await withBroker(async (context) => {
    const { accounts, paths } = context;
    const { client, approve } = await setup(context);
    await approve();
    for (const payload of [{ key: '' }, { kind: 'INVALID' }, { refs: [1] }, { correlation: 1 }]) {
      await assert.rejects(client.send({ to: accounts.bob, body: 'hello', key: 'key', ...payload }), { code: 'bad-request' });
    }
    await assert.rejects(client.send({ to: accounts.bob, body: 'x'.repeat(LIMITS.bodyBytes + 1), key: 'large' }), { code: 'message-too-large' });
    await assert.rejects(client.inbox({ limit: 0 }), { code: 'bad-request' });
    await assert.rejects(client.inbox({ after: -1 }), { code: 'bad-request' });
    await assert.rejects(client.ack([]), { code: 'bad-request' });
    await client.send({ to: accounts.bob, body: 'one', key: 'one' });
    await assert.rejects(client.send({ to: accounts.bob, body: 'two', key: 'two' }), { code: 'rate-limited' });
    chmodSync(paths.socket, 0o666);
    try { assert.throws(() => client.census(), { code: 'broker-untrusted' }); }
    finally { chmodSync(paths.socket, 0o600); }
  }, { brokerOptions: { mode: 'single-account', limits: { ...LIMITS, sendsPerAccountPerMinute: 1 } } });
});

test('saved credentials are validated and macOS reads the host-selected secret store', () => {
  const calls = [];
  const saved = { principal: 'principal_00000000-0000-0000-0000-000000000000', secret: 'private', brokerUid: 501 };
  const store = createSecretStore('darwin', { run: (...args) => {
    calls.push(args);
    return { status: 0, stdout: JSON.stringify(saved) + '\n' };
  } });
  const env = { AGENT_COMMS_CREDENTIAL_NAME: 'org.example.owner' };
  const client = createPrincipalClient({ env, credentialLoader: store.readPrincipalCredential });
  assert.equal(client.principal, saved.principal);
  assert.equal(client.secret, undefined);
  assert.deepEqual(calls, [['/usr/bin/security', ['find-generic-password', '-s', 'org.example.owner', '-a', 'principal', '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }]]);
  for (const credential of [null, {}, { ...saved, principal: 'agent_fake' }, { ...saved, secret: '' },
    { ...saved, brokerUid: -1 }, { ...saved, mode: 'anything' }]) {
    assert.throws(() => createPrincipalClient({ env, credentialLoader: () => credential }), { code: 'credential-invalid' });
  }
  for (const [result, code] of [[{ status: 1, stdout: 'secret' }, 'keychain-read-failed'],
    [{ status: 0, stdout: 'not json secret' }, 'credential-invalid']]) {
    const badStore = createSecretStore('darwin', { run: () => result });
    assert.throws(() => createPrincipalClient({ env, credentialLoader: badStore.readPrincipalCredential }), { code });
  }
});


test('principal and soul inboxes share the existing mailbox capacity limit', async () => {
  await withBroker(async (context) => {
    const { paths, accounts } = context;
    const { client, account, approve } = await setup(context);
    await approve();
    await client.send({ to: accounts.bob, body: 'full', key: 'first' });
    await assert.rejects(client.send({ to: accounts.bob, body: 'overflow', key: 'second' }), { code: 'mailbox-full' });
    const reply = { op: 'send', agentId: accounts.bob, to: client.principal, body: 'full', key: 'first' };
    await call(paths, account, reply);
    await assert.rejects(call(paths, account, { ...reply, key: 'second' }), { code: 'mailbox-full' });
    await client.ack((await client.inbox()).messages.map((message) => message.id));
    assert.equal((await call(paths, account, { ...reply, key: 'second' })).duplicate, false);
  }, { brokerOptions: { mode: 'single-account', limits: { ...LIMITS, unackedPerMailbox: 1 } } });
});
