// Integration acceptance for the bounded mailbox contract in issue #122.
// Small injected retention windows keep expiry deterministic; these tests
// exercise the real broker protocol and durable event log.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { Broker, LIMITS } from '../lib/broker.mjs';
import { loadCredential, pairPrincipal, admin, loadPrincipalCredential } from '../lib/client.mjs';
import { readHostConfig } from '../lib/host-config.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { PROTOCOL_VERSION } from '../lib/wire.mjs';
import { withBroker } from './helpers/broker.mjs';

const RETENTION_MS = 100;
const DEDUPE_MS = 50;
const startAt = 1_000_000;

function retentionOptions(clock, { maintenanceIntervalMs = 60_000, mode = 'single-account', uidOf } = {}) {
  return {
    brokerOptions: {
      mode,
      now: () => clock.now,
      ...(uidOf ? { uidOf } : {}),
      limits: {
        ...LIMITS,
        messageRetentionMs: RETENTION_MS,
        dedupeRetentionMs: DEDUPE_MS,
        retainedPerMailbox: 10_000,
        mailboxBytes: 64 * 1024 * 1024,
        dedupeEntriesPerSender: 100_000,
        dedupeBytesPerSender: 32 * 1024 * 1024,
        expiredPerMailbox: 10_000,
        expiredBytesPerMailbox: 64 * 1024 * 1024,
        referenceRetentionMs: 30 * 24 * 60 * 60 * 1000,
        maintenanceIntervalMs,
        wakeWindowMs: 10,
        wakeRateMs: 1,
        compactAfterBytes: 4 * 1024 * 1024,
      },
    },
  };
}

async function withRetentionBroker(run, options = {}) {
  const clock = { now: startAt };
  return withBroker((context) => run({ ...context, clock }), retentionOptions(clock, options));
}

function wireCall(paths, auth, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, ...request, auth })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const response = JSON.parse(buffer.slice(0, newline));
      socket.end();
      resolve(response);
    });
    socket.on('error', reject);
    socket.on('close', () => {
      if (!buffer.includes('\n')) reject(new Error('broker closed without a response'));
    });
  });
}

async function read(paths, auth, recipient, after) {
  return wireCall(paths, auth, {
    op: 'read', agentId: recipient,
    ...(after === undefined ? {} : { after }),
  });
}

async function send(paths, auth, from, to, key, body = key) {
  const response = await wireCall(paths, auth, { op: 'send', agentId: from, to, key, body });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response;
}

async function waitFor(predicate, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function openFullWatch(env, soul) {
  const bin = new URL('../bin/agent-comms.mjs', import.meta.url);
  const child = spawn(process.execPath, [bin.pathname, 'inbox', 'watch', '--full'], {
    env: { ...env, QWTS_AGENT_ID: soul },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const events = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) events.push(JSON.parse(line));
  });
  return { child, events };
}

function openAccountWatch(paths, auth) {
  const socket = net.createConnection(paths.socket);
  const events = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) events.push(JSON.parse(line));
  });
  socket.on('connect', () => socket.write(`${JSON.stringify({
    v: PROTOCOL_VERSION, op: 'account-watch', auth: { daemon: auth.daemon, secret: auth.secret },
  })}\n`));
  return { socket, events };
}

async function pairDaemon(paths, accountAuth) {
  const secret = randomBytes(32).toString('hex');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const proof = `${randomUUID()}.proof`;
  const { publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(path.join(paths.proofs, proof), secretHash, { mode: 0o644, flag: 'wx' });
  const requested = await wireCall(paths, accountAuth, {
    op: 'daemon-pair-request', account: accountAuth.account, secretHash, proof,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  const approved = await admin(paths, { op: 'approve', code: requested.code });
  assert.equal(approved.state, 'approved', JSON.stringify(approved));
  return { daemon: accountAuth.account, secret };
}

async function pairSecondaryAccount(paths, account) {
  const secret = randomBytes(32).toString('hex');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const proof = `${randomUUID()}.proof`;
  writeFileSync(path.join(paths.proofs, proof), secretHash, { mode: 0o644, flag: 'wx' });
  const requested = await wireCall(paths, undefined, { op: 'pair-request', account, secretHash, proof });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  const approved = await admin(paths, { op: 'approve', code: requested.code });
  assert.equal(approved.state, 'approved', JSON.stringify(approved));
  return { account, secret };
}

async function principalCredential({ paths, env }) {
  const principalEnv = {
    ...env,
    AGENT_COMMS_NO_KEYCHAIN: '1',
    AGENT_COMMS_CREDENTIAL_NAME: 'org.example.retention-test',
  };
  const client = clientPaths(principalEnv);
  const pending = await pairPrincipal(paths, client, 'Retention test', principalEnv);
  await admin(paths, { op: 'principal-approve', code: pending.code, grant: null });
  return loadPrincipalCredential(client, readHostConfig(principalEnv));
}

test('first read reports unread expiry while global sequence holes stay valid', async () => {
  await withRetentionBroker(async ({ paths, env, accounts, broker, clock }) => {
    const owner = loadCredential(clientPaths(env));
    const first = await send(paths, owner, accounts.alice, accounts.bob, 'target-old');
    clock.now += 25;
    const foreign = await send(paths, owner, accounts.bob, accounts.alice, 'foreign-seq');
    const second = await send(paths, owner, accounts.alice, accounts.bob, 'target-old-two');
    clock.now += 55;
    const retained = await send(paths, owner, accounts.alice, accounts.bob, 'target-current');

    // A global sequence position occupied by another mailbox is not a loss.
    const beforeExpiry = await read(paths, { account: owner.account, secret: owner.secret }, accounts.bob, first.seq);
    assert.equal(beforeExpiry.ok, true, JSON.stringify(beforeExpiry));
    assert.deepEqual(beforeExpiry.messages.map((message) => message.id), [second.messageId, retained.messageId]);
    assert.equal(beforeExpiry.gap, undefined);
    assert.ok(foreign.seq > first.seq && foreign.seq < retained.seq);

    // Expiry is inclusive at sent-at + retention. First read with no cursor
    // returns the explicit loss and the surviving mailbox backlog together.
    clock.now = startAt + RETENTION_MS + 25;
    broker.maintain();
    const firstRead = await read(paths, { account: owner.account, secret: owner.secret }, accounts.bob);
    assert.equal(firstRead.ok, true, JSON.stringify(firstRead));
    assert.deepEqual(firstRead.messages.map((message) => message.id), [retained.messageId]);
    assert.deepEqual(firstRead.gap, {
      through: 2, count: 2, firstSeq: first.seq, lastSeq: second.seq,
    });

    const stale = await read(paths, { account: owner.account, secret: owner.secret }, accounts.bob, first.seq);
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'cursor-expired');
    assert.equal(stale.error.details.earliestAvailableSeq, retained.seq);
    assert.equal(stale.error.details.resumeAfter, retained.seq - 1);
    assert.deepEqual(stale.error.details.gap, firstRead.gap);
    const resumed = await read(paths, { account: owner.account, secret: owner.secret }, accounts.bob,
      stale.error.details.resumeAfter);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.deepEqual(resumed.messages.map((message) => message.id), [retained.messageId]);
  });
});

test('empty mailbox cursor-expired resumeAfter is accepted at high-water', async () => {
  await withRetentionBroker(async ({ paths, env, accounts, broker, clock }) => {
    const owner = loadCredential(clientPaths(env));
    const auth = { account: owner.account, secret: owner.secret };
    const expired = await send(paths, owner, accounts.alice, accounts.bob, 'only-expired-one');
    clock.now += 25;
    const lastExpired = await send(paths, owner, accounts.alice, accounts.bob, 'only-expired-two');
    clock.now += RETENTION_MS;
    broker.maintain();

    const stale = await read(paths, auth, accounts.bob, expired.seq);
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'cursor-expired');
    assert.equal(stale.error.details.earliestAvailableSeq, null);
    assert.equal(stale.error.details.resumeAfter, lastExpired.seq);

    const resumed = await read(paths, auth, accounts.bob, stale.error.details.resumeAfter);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.deepEqual(resumed.messages, []);
    assert.equal(resumed.cursor, lastExpired.seq);
  });
});

test('consecutive retained message can be read from cursor-expired resumeAfter', async () => {
  await withRetentionBroker(async ({ paths, env, accounts, broker, clock }) => {
    const owner = loadCredential(clientPaths(env));
    const auth = { account: owner.account, secret: owner.secret };
    const expired = await send(paths, owner, accounts.alice, accounts.bob, 'expired-before-retained-one');
    clock.now += 25;
    const lastExpired = await send(paths, owner, accounts.alice, accounts.bob, 'expired-before-retained-two');
    clock.now += RETENTION_MS;
    broker.maintain();
    const retained = await send(paths, owner, accounts.alice, accounts.bob, 'retained-next-seq');
    assert.equal(retained.seq, lastExpired.seq + 1);

    const stale = await read(paths, auth, accounts.bob, expired.seq);
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'cursor-expired');
    assert.equal(stale.error.details.earliestAvailableSeq, retained.seq);
    assert.equal(stale.error.details.resumeAfter, lastExpired.seq);

    const resumed = await read(paths, auth, accounts.bob, stale.error.details.resumeAfter);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.deepEqual(resumed.messages.map((message) => message.id), [retained.messageId]);
  });
});

test('loss notices survive reads and restart; an ack racing new expiry is refused', async () => {
  await withRetentionBroker(async ({ paths, env, accounts, broker, clock }) => {
    const owner = loadCredential(clientPaths(env));
    const auth = { account: owner.account, secret: owner.secret };
    const first = await send(paths, owner, accounts.alice, accounts.bob, 'lost-one');
    clock.now += RETENTION_MS;
    broker.maintain();
    const notice = await read(paths, auth, accounts.bob);
    assert.deepEqual(notice.gap, { through: 1, count: 1, firstSeq: first.seq, lastSeq: first.seq });
    assert.deepEqual((await read(paths, auth, accounts.bob)).gap, notice.gap,
      'ordinary read reports but does not acknowledge the loss');

    clock.now += 1;
    const second = await send(paths, owner, accounts.alice, accounts.bob, 'lost-two');
    clock.now += RETENTION_MS;
    broker.maintain();
    const racedAck = await wireCall(paths, auth, {
      op: 'gap-ack', agentId: accounts.bob, through: notice.gap.through,
    });
    assert.equal(racedAck.ok, false);
    assert.equal(racedAck.error.code, 'gap-changed');

    await broker.stop();
    const restarted = await new Broker({
      paths, mode: 'single-account', now: () => clock.now, limits: broker.limits,
    }).start();
    try {
      const afterRestart = await read(paths, auth, accounts.bob);
      assert.deepEqual(afterRestart.gap, {
        through: 2, count: 2, firstSeq: first.seq, lastSeq: second.seq,
      });
      const ack = await wireCall(paths, auth, {
        op: 'gap-ack', agentId: accounts.bob, through: afterRestart.gap.through,
      });
      assert.equal(ack.ok, true, JSON.stringify(ack));
      assert.deepEqual([ack.acknowledged, ack.alreadyAcknowledged], [2, false]);
      const duplicateAck = await wireCall(paths, auth, {
        op: 'gap-ack', agentId: accounts.bob, through: afterRestart.gap.through,
      });
      assert.deepEqual([duplicateAck.acknowledged, duplicateAck.alreadyAcknowledged], [0, true]);
    } finally {
      await restarted.stop();
    }
  });
});

test('full watch emits a pending loss before retained backlog and does not acknowledge it', async () => {
  await withRetentionBroker(async ({ paths, env, accounts, broker, clock }) => {
    const owner = loadCredential(clientPaths(env));
    const expired = await send(paths, owner, accounts.alice, accounts.bob, 'watch-expired');
    clock.now += RETENTION_MS;
    broker.maintain();
    const pending = await send(paths, owner, accounts.alice, accounts.bob, 'watch-retained');
    const watcher = openFullWatch(env, accounts.bob);
    try {
      await waitFor(
        () => watcher.events.find((event) => event.event === 'message' && event.message?.id === pending.messageId),
        'retained watch message',
      );
      const readyAt = watcher.events.findIndex((event) => event.event === 'ready');
      const gapAt = watcher.events.findIndex((event) => event.event === 'gap');
      const messageAt = watcher.events.findIndex((event) => event.event === 'message');
      assert.ok(readyAt >= 0 && gapAt > readyAt && messageAt > gapAt, JSON.stringify(watcher.events));
      assert.deepEqual(watcher.events[gapAt].gap, {
        through: 1, count: 1, firstSeq: expired.seq, lastSeq: expired.seq,
      });
      const stillPending = await read(paths, { account: owner.account, secret: owner.secret }, accounts.bob);
      assert.equal(stillPending.gap.through, 1, 'watch delivery is not implicit gap acknowledgement');
    } finally {
      watcher.child.kill('SIGTERM');
      await once(watcher.child, 'exit');
    }
  });
});

test('idle watch receives a gap from timer maintenance without another request', async () => {
  await withRetentionBroker(async ({ paths, env, accounts, clock }) => {
    const owner = loadCredential(clientPaths(env));
    const watcher = openFullWatch(env, accounts.bob);
    try {
      await waitFor(() => watcher.events.some((event) => event.event === 'ready'), 'watch ready');
      const expired = await send(paths, owner, accounts.alice, accounts.bob, 'idle-timer-expiry');
      await waitFor(
        () => watcher.events.some((event) => event.event === 'message' && event.message?.id === expired.messageId),
        'message delivered before expiry',
      );

      clock.now += RETENTION_MS;
      // Do not call the broker after advancing time; only its maintenance
      // timer can commit the loss and notify this already-connected watch.
      await waitFor(() => watcher.events.some((event) => event.event === 'gap'), 'timer-driven gap');
      const gap = watcher.events.find((event) => event.event === 'gap');
      assert.deepEqual(gap.gap, {
        through: 1, count: 1, firstSeq: expired.seq, lastSeq: expired.seq,
      });
      const persisted = await read(paths, { account: owner.account, secret: owner.secret }, accounts.bob);
      assert.deepEqual(persisted.gap, gap.gap, 'watch delivery does not acknowledge loss');
    } finally {
      watcher.child.kill('SIGTERM');
      await once(watcher.child, 'exit');
    }
  }, { maintenanceIntervalMs: 10 });
});

test('account-watch scopes gap notices to its account and repeats before backlog on reconnect', async () => {
  await withRetentionBroker(async ({ paths, env, accounts, owner, broker, clock }) => {
    const ownerAuth = loadCredential(clientPaths(env));
    const foreignSoul = `agent_${randomUUID()}`;
    const foreignAuth = await pairSecondaryAccount(paths, 'foreign-test');
    const foreignJoined = await wireCall(paths, foreignAuth, { op: 'join', agentId: foreignSoul, name: 'foreign', harness: 'test' });
    assert.equal(foreignJoined.ok, true, JSON.stringify(foreignJoined));

    const daemonAuth = await pairDaemon(paths, ownerAuth);
    const bobExpired = await send(paths, ownerAuth, accounts.alice, accounts.bob, 'account-bob-expired');
    const foreignExpired = await send(paths, ownerAuth, accounts.alice, foreignSoul, 'foreign-mailbox-expired');
    clock.now += RETENTION_MS;
    // No watcher is open yet. Trigger expiry deterministically before adding a
    // current backlog in each account.
    broker.maintain();
    const bobRetained = await send(paths, ownerAuth, accounts.alice, accounts.bob, 'account-bob-backlog');
    const foreignRetained = await send(paths, ownerAuth, accounts.alice, foreignSoul, 'foreign-backlog');

    async function assertAccountStream() {
      const watcher = openAccountWatch(paths, daemonAuth);
      try {
        await waitFor(() => watcher.events.some((event) => event.event === 'gap' && event.agentId === accounts.bob), 'bob gap');
        await waitFor(() => watcher.events.some((event) => event.event === 'wake' && event.agentId === accounts.bob), 'bob backlog wake');
        const bobGapAt = watcher.events.findIndex((event) => event.event === 'gap' && event.agentId === accounts.bob);
        const bobWakeAt = watcher.events.findIndex((event) => event.event === 'wake' && event.agentId === accounts.bob);
        assert.ok(bobGapAt >= 0 && bobWakeAt > bobGapAt, JSON.stringify(watcher.events));
        assert.deepEqual(watcher.events[bobGapAt].gap, {
          through: 1, count: 1, firstSeq: bobExpired.seq, lastSeq: bobExpired.seq,
        });
        assert.equal(watcher.events.some((event) => event.agentId === foreignSoul), false,
          'the owner daemon receives no gap or wake for another account');
        assert.deepEqual(new Set(watcher.events[bobWakeAt].messageIds), new Set([bobRetained.messageId]));
        return watcher;
      } catch (error) {
        watcher.socket.destroy();
        throw error;
      }
    }

    const first = await assertAccountStream();
    const bobMailbox = await read(paths, ownerAuth, accounts.bob);
    assert.deepEqual(bobMailbox.gap, first.events.find((event) => event.event === 'gap' && event.agentId === accounts.bob).gap,
      'account-watch does not acknowledge the gap');
    assert.deepEqual(bobMailbox.messages.map((message) => message.id), [bobRetained.messageId],
      'account-watch does not acknowledge the retained backlog');
    first.socket.destroy();
    await once(first.socket, 'close');

    const second = await assertAccountStream();
    second.socket.destroy();
    await once(second.socket, 'close');
    assert.ok(foreignExpired.seq < foreignRetained.seq);
  }, { mode: 'group', uidOf: () => process.getuid() });
});

test('principal loss notices are mailbox-scoped and cannot acknowledge a soul gap', async () => {
  await withRetentionBroker(async ({ paths, env, accounts, broker, clock }) => {
    const owner = loadCredential(clientPaths(env));
    const principal = await principalCredential({ paths, env });
    const bobLost = await send(paths, owner, accounts.alice, accounts.bob, 'soul-loss');
    const principalLost = await send(paths, owner, accounts.alice, principal.principal, 'principal-loss-one');
    clock.now += 1;
    const principalLost2 = await send(paths, owner, accounts.alice, principal.principal, 'principal-loss-two');
    clock.now += RETENTION_MS;
    broker.maintain();

    const soulNotice = await read(paths, { account: owner.account, secret: owner.secret }, accounts.bob);
    const principalNotice = await wireCall(paths, { principal: principal.principal, secret: principal.secret }, { op: 'read' });
    const ownerNotice = await read(paths, { account: owner.account, secret: owner.secret }, accounts.alice);
    assert.deepEqual(soulNotice.gap, { through: 1, count: 1, firstSeq: bobLost.seq, lastSeq: bobLost.seq });
    assert.deepEqual(principalNotice.gap, {
      through: 2, count: 2, firstSeq: principalLost.seq, lastSeq: principalLost2.seq,
    });
    assert.equal(ownerNotice.gap, undefined, 'another soul mailbox has no inherited loss');

    const forbidden = await wireCall(paths, { principal: principal.principal, secret: principal.secret }, {
      op: 'gap-ack', agentId: accounts.bob, through: 1,
    });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error.code, 'unauthenticated');

    const ownAck = await wireCall(paths, { principal: principal.principal, secret: principal.secret }, {
      op: 'gap-ack', through: principalNotice.gap.through,
    });
    assert.deepEqual([ownAck.acknowledged, ownAck.alreadyAcknowledged], [2, false]);
    assert.deepEqual((await read(paths, { account: owner.account, secret: owner.secret }, accounts.bob)).gap,
      soulNotice.gap, 'acknowledging the principal notice leaves the soul notice untouched');
  });
});

test('expired own ack and reply references are distinguishable from foreign or unknown ids', async () => {
  await withRetentionBroker(async ({ paths, env, accounts, broker, clock }) => {
    const owner = loadCredential(clientPaths(env));
    const auth = { account: owner.account, secret: owner.secret };
    const parent = await send(paths, owner, accounts.alice, accounts.bob, 'reply-parent');
    clock.now += RETENTION_MS;
    broker.maintain();

    const expiredAck = await wireCall(paths, auth, { op: 'ack', agentId: accounts.bob, ids: [parent.messageId] });
    assert.equal(expiredAck.ok, false);
    assert.equal(expiredAck.error.code, 'message-expired');
    assert.equal(expiredAck.error.details, undefined, 'expired-reference errors do not disclose endpoint or body data');

    const expiredReply = await wireCall(paths, auth, {
      op: 'send', agentId: accounts.bob, to: accounts.alice,
      body: 'reply', key: 'reply-to-expired', replyTo: parent.messageId,
    });
    assert.equal(expiredReply.ok, false);
    assert.equal(expiredReply.error.code, 'message-expired');

    const foreignAck = await wireCall(paths, auth, { op: 'ack', agentId: accounts.alice, ids: [parent.messageId] });
    assert.equal(foreignAck.ok, false);
    assert.equal(foreignAck.error.code, 'unknown-message');
    const unknownReply = await wireCall(paths, auth, {
      op: 'send', agentId: accounts.bob, to: accounts.alice,
      body: 'reply', key: 'reply-to-unknown', replyTo: 'msg_never-existed',
    });
    assert.equal(unknownReply.ok, false);
    assert.equal(unknownReply.error.code, 'unknown-message');
  });
});

test('identical retry survives recipient leave within the dedupe window; key is reusable at expiry', async () => {
  await withRetentionBroker(async ({ paths, env, accounts, broker, clock }) => {
    const owner = loadCredential(clientPaths(env));
    const auth = { account: owner.account, secret: owner.secret };
    const original = await send(paths, owner, accounts.alice, accounts.bob, 'retry-after-leave', 'same body');
    const leave = await wireCall(paths, auth, { op: 'leave', agentId: accounts.bob });
    assert.equal(leave.ok, true, JSON.stringify(leave));

    clock.now = startAt + DEDUPE_MS - 1;
    await broker.stop();
    const restarted = await new Broker({
      paths, mode: 'single-account', now: () => clock.now, limits: broker.limits,
    }).start();
    try {
      const retry = await send(paths, owner, accounts.alice, accounts.bob, 'retry-after-leave', 'same body');
      assert.equal(retry.duplicate, true);
      assert.equal(retry.messageId, original.messageId);
      assert.equal(retry.seq, original.seq);
      assert.equal(retry.wake, original.wake);

      clock.now = startAt + DEDUPE_MS;
      restarted.maintain();
      const join = await wireCall(paths, auth, { op: 'join', agentId: accounts.bob, name: 'bob', harness: 'test' });
      assert.equal(join.ok, true, JSON.stringify(join));
      const reused = await send(paths, owner, accounts.alice, accounts.bob, 'retry-after-leave', 'same body');
      assert.equal(reused.duplicate, false);
      assert.notEqual(reused.messageId, original.messageId);
      assert.ok(reused.seq > original.seq);
    } finally {
      await restarted.stop();
    }
  });
});
