// account-watch and wake-report (ADR-0008 decision 7). The daemon credential
// is obtained through daemon-pair-request and owner approval.

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Broker, LIMITS, sha256 } from '../lib/broker.mjs';
import { status } from '../lib/broker/launchagent.mjs';
import { brokerPaths } from '../lib/paths.mjs';
import { PROTOCOL_VERSION } from '../lib/wire.mjs';

const windowMs = 500;
const rateMs = 1200;
const limits = { ...LIMITS, wakeWindowMs: windowMs, wakeRateMs: rateMs };
const root = mkdtempSync(path.join(os.tmpdir(), 'ac-account-watch-'));
const paths = brokerPaths({
  AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'),
  AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker'),
});
const uidOf = () => process.getuid();
const luna = `agent_${randomUUID()}`;
const burstSoul = `agent_${randomUUID()}`;
const secondSoul = `agent_${randomUUID()}`;
const warmSoul = `agent_${randomUUID()}`;
const reportSoul = `agent_${randomUUID()}`;
const rateSoul = `agent_${randomUUID()}`;
const backlogSoul = `agent_${randomUUID()}`;
const guest = `agent_${randomUUID()}`;
const ownerDaemonSecret = randomBytes(32).toString('hex');
const personaDaemonSecret = randomBytes(32).toString('hex');
const daemonAuth = { daemon: 'owner', secret: ownerDaemonSecret };
const personaDaemonAuth = { daemon: 'persona', secret: personaDaemonSecret };

let broker;
let owner;
let persona;
let principal;
const openSockets = [];

function request(file, payload, { keep = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, ...payload })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      if (!keep) socket.destroy();
      resolve({ reply: JSON.parse(buffer.slice(0, end)), socket });
    });
    socket.on('error', reject);
  });
}

function openStream(payload) {
  const socket = net.createConnection(paths.socket);
  openSockets.push(socket);
  const events = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line) events.push(JSON.parse(line));
  });
  socket.on('connect', () => socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, ...payload })}\n`));
  return { socket, events };
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once('close', resolve);
    socket.destroy();
  });
}

async function until(predicate, label, ms = windowMs + rateMs + 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const wakesFor = (events, agentId) => events.filter((event) => event.event === 'wake' && event.agentId === agentId);

async function pairAccount(account) {
  const secret = randomBytes(32).toString('hex');
  const secretHash = sha256(secret);
  const proof = `${randomBytes(16).toString('hex')}.proof`;
  writeFileSync(path.join(paths.proofs, proof), secretHash, { mode: 0o644, flag: 'wx' });
  const { reply } = await request(paths.socket, { op: 'pair-request', account, secretHash, proof });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const approved = await request(paths.admin, { op: 'approve', code: reply.code });
  assert.equal(approved.reply.state, 'approved');
  return { account, secret };
}

async function join(auth, agentId, fields = {}) {
  const { reply } = await request(paths.socket, { op: 'join', auth, agentId, ...fields });
  assert.equal(reply.ok, true, JSON.stringify(reply));
}

async function pairDaemon(account, secret, approve = true) {
  const secretHash = sha256(secret);
  const proof = `${randomUUID()}.proof`;
  const { publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(path.join(paths.proofs, proof), secretHash, { mode: 0o644, flag: 'wx' });
  const { reply } = await request(paths.socket, {
    op: 'daemon-pair-request', account, secretHash, proof,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  if (approve) {
    const approved = await request(paths.admin, { op: 'approve', code: reply.code });
    assert.equal(approved.reply.state, 'approved');
  }
}

async function send(body, to, key = `k-${randomUUID()}`) {
  const { reply } = await request(paths.socket, {
    op: 'send', auth: owner, agentId: luna, to, body, key,
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply;
}

async function ack(auth, agentId, ids) {
  const { reply } = await request(paths.socket, { op: 'ack', auth, agentId, ids });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply;
}

const census = async () => (await request(paths.socket, { op: 'census', auth: principal })).reply;
const rowOf = (reply, agentId) => reply.souls.find((row) => row.agentId === agentId);

before(async () => {
  broker = await new Broker({ paths, uidOf, limits }).start();
  owner = await pairAccount('owner');
  persona = await pairAccount('persona');
  await join(owner, luna, { name: 'luna' });
  await join(owner, burstSoul, { name: 'burst' });
  await join(owner, secondSoul, { name: 'second' });
  await join(owner, warmSoul, { name: 'warm' });
  await join(owner, reportSoul, { name: 'report' });
  await join(owner, rateSoul, { name: 'rate' });
  await join(owner, backlogSoul, { name: 'backlog' });
  await join(persona, guest, { name: 'guest' });
  const secret = randomBytes(32).toString('hex');
  const paired = await request(paths.socket, {
    op: 'principal-pair-request', auth: owner, name: 'owner', secretHash: sha256(secret),
  });
  assert.equal(paired.reply.ok, true, JSON.stringify(paired.reply));
  const approved = await request(paths.admin, { op: 'principal-approve', code: paired.reply.code });
  assert.equal(approved.reply.state, 'approved');
  principal = { principal: paired.reply.principal, secret };
  await pairDaemon('owner', ownerDaemonSecret);
  await pairDaemon('persona', personaDaemonSecret);
});

after(async () => {
  for (const socket of openSockets) socket.destroy();
  if (broker) await broker.stop();
  rmSync(root, { recursive: true, force: true });
});

test('the account-watch rate limit defaults to two seconds', () => {
  assert.equal(LIMITS.wakeRateMs, 2000);
  assert.equal(LIMITS.wakeWindowMs, 1000);
});

test('account-watch and wake-report require an approved daemon credential', async () => {
  const asAccount = await request(paths.socket, { op: 'account-watch', auth: owner });
  assert.equal(asAccount.reply.error.code, 'unauthenticated');
  const wrong = await request(paths.socket, {
    op: 'wake-report', auth: { daemon: 'owner', secret: 'nope' }, agentId: reportSoul, messageIds: ['msg_x'], outcome: 'failed',
  });
  assert.equal(wrong.reply.error.code, 'unauthenticated');

  const pendingSecret = 'pending-secret';
  await pairAccount('staged');
  await pairDaemon('staged', pendingSecret, false);
  const pending = await request(paths.socket, {
    op: 'account-watch', auth: { daemon: 'staged', secret: pendingSecret },
  });
  assert.equal(pending.reply.error.code, 'unauthenticated');
});

test('a burst produces one wake per soul, and the census shows the daemon watching', async () => {
  const watcher = openStream({ op: 'account-watch', auth: daemonAuth });
  await until(() => watcher.events.some((event) => event.event === 'ready'), 'ready');
  assert.deepEqual(watcher.events[0], { event: 'ready' });

  const watching = rowOf(await census(), burstSoul);
  assert.equal(watching.daemonWatching, true);
  assert.equal(rowOf(await census(), guest).daemonWatching, false);
  const snapshot = await status({
    paths,
    launchctl: () => { throw new Error('Could not find service "dev.qwts.agent-comms.broker"'); },
    listPairings: async () => (await request(paths.admin, { op: 'pairings' })).reply,
    listDaemonWatches: async () => (await request(paths.admin, { op: 'daemon-watches' })).reply,
  });
  assert.equal(snapshot.daemons.find((row) => row.account === 'owner').watching, true);
  assert.equal(snapshot.daemons.find((row) => row.account === 'persona').watching, false);

  const [batch, other] = await Promise.all([
    Promise.all([0, 1, 2, 3, 4].map((i) => send(`burst ${i}`, burstSoul))),
    Promise.all([0, 1].map((i) => send(`other ${i}`, secondSoul))),
  ]);
  for (const one of [...batch, ...other]) assert.equal(one.wake, 'waiting');
  await until(() => wakesFor(watcher.events, burstSoul).length === 1, 'burst wake');
  await until(() => wakesFor(watcher.events, secondSoul).length === 1, 'second wake');
  const burst = wakesFor(watcher.events, burstSoul)[0];
  assert.equal(burst.count, 5);
  assert.equal(burst.cursor, Math.min(...batch.map((one) => one.seq)));
  assert.deepEqual(new Set(burst.messageIds), new Set(batch.map((one) => one.messageId)));
  const second = wakesFor(watcher.events, secondSoul)[0];
  assert.equal(second.count, 2);
  assert.deepEqual(new Set(second.messageIds), new Set(other.map((one) => one.messageId)));

  // Past the rate window, so a burst that missed the first coalesce would have
  // shown up as a second event rather than hiding inside the hold.
  await new Promise((resolve) => setTimeout(resolve, rateMs));
  assert.equal(wakesFor(watcher.events, burstSoul).length, 1);
  assert.equal(wakesFor(watcher.events, secondSoul).length, 1);

  await closeSocket(watcher.socket);
  assert.equal(rowOf(await census(), burstSoul).daemonWatching, false);
  const quiet = await status({
    paths,
    launchctl: () => { throw new Error('Could not find service "dev.qwts.agent-comms.broker"'); },
    listDaemonWatches: async () => (await request(paths.admin, { op: 'daemon-watches' })).reply,
  });
  assert.equal(quiet.daemons.find((row) => row.account === 'owner').watching, false);

  await ack(owner, burstSoul, batch.map((one) => one.messageId));
  await ack(owner, secondSoul, other.map((one) => one.messageId));
});

test('a soul watch still counts as warm, and the daemon watch does not', async () => {
  const soul = openStream({ op: 'watch', auth: owner, agentId: warmSoul, mode: 'wake' });
  const daemon = openStream({ op: 'account-watch', auth: daemonAuth });
  await until(() => soul.events.some((event) => event.event === 'ready'), 'soul ready');
  await until(() => daemon.events.some((event) => event.event === 'ready'), 'daemon ready');

  const sent = await send('live', warmSoul);
  assert.equal(sent.wake, 'warm');
  await until(() => soul.events.some((event) => event.event === 'wake'), 'soul wake');
  await until(() => wakesFor(daemon.events, warmSoul).length === 1, 'daemon wake');
  assert.deepEqual(soul.events.find((event) => event.event === 'wake'), {
    event: 'wake', count: 1, cursor: sent.seq,
  });
  assert.deepEqual(wakesFor(daemon.events, warmSoul)[0], {
    event: 'wake', agentId: warmSoul, count: 1, cursor: sent.seq, messageIds: [sent.messageId],
  });
  assert.equal(rowOf(await census(), warmSoul).lastWake, 'warm');

  await closeSocket(soul.socket);
  const parked = await send('parked', warmSoul);
  assert.equal(parked.wake, 'waiting');
  await until(() => wakesFor(daemon.events, warmSoul).length === 2, 'parked wake');
  assert.equal(wakesFor(daemon.events, warmSoul)[1].count, 1);
  assert.deepEqual(wakesFor(daemon.events, warmSoul)[1].messageIds, [parked.messageId]);

  await closeSocket(daemon.socket);
  await ack(owner, warmSoul, [sent.messageId, parked.messageId]);
});

test('wake-report records outcomes on the named messages and in lastWake', async () => {
  const key = `k-${randomUUID()}`;
  const first = await send('one', reportSoul, key);
  const second = await send('two', reportSoul);
  const foreign = await send('elsewhere', guest);
  assert.equal(first.wake, 'waiting');
  assert.equal(rowOf(await census(), reportSoul).lastWake, 'waiting');

  const reported = await request(paths.socket, {
    op: 'wake-report',
    auth: daemonAuth,
    agentId: reportSoul,
    messageIds: [first.messageId, second.messageId, foreign.messageId, 'msg_missing', first.messageId],
    outcome: 'cold',
    detail: 'no warm socket',
  });
  assert.deepEqual(reported.reply.recorded, [first.messageId, second.messageId]);
  assert.deepEqual(reported.reply.ignored, [foreign.messageId, 'msg_missing']);

  const page = await request(paths.socket, { op: 'read', auth: owner, agentId: reportSoul });
  assert.deepEqual(page.reply.messages.map((message) => message.wake), ['cold', 'cold']);
  assert.equal(rowOf(await census(), reportSoul).lastWake, 'cold');
  const guestPage = await request(paths.socket, { op: 'read', auth: persona, agentId: guest });
  assert.equal(guestPage.reply.messages[0].wake, 'waiting');

  const duplicate = await send('one', reportSoul, key);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.wake, 'cold');

  const third = await send('three', reportSoul);
  const failed = await request(paths.socket, {
    op: 'wake-report', auth: daemonAuth, agentId: reportSoul, messageIds: [third.messageId], outcome: 'failed',
  });
  assert.deepEqual(failed.reply.recorded, [third.messageId]);
  assert.deepEqual(failed.reply.ignored, []);
  const after = await request(paths.socket, { op: 'read', auth: owner, agentId: reportSoul, limit: 100 });
  const byId = Object.fromEntries(after.reply.messages.map((message) => [message.id, message.wake]));
  assert.equal(byId[first.messageId], 'cold');
  assert.equal(byId[third.messageId], 'failed');
  assert.equal(rowOf(await census(), reportSoul).lastWake, 'failed');

  const bad = await request(paths.socket, {
    op: 'wake-report', auth: daemonAuth, agentId: reportSoul, messageIds: [third.messageId], outcome: 'asleep',
  });
  assert.equal(bad.reply.error.code, 'bad-request');
  const empty = await request(paths.socket, {
    op: 'wake-report', auth: daemonAuth, agentId: reportSoul, messageIds: [], outcome: 'warm',
  });
  assert.equal(empty.reply.error.code, 'bad-request');
  const notMine = await request(paths.socket, {
    op: 'wake-report', auth: daemonAuth, agentId: guest, messageIds: [foreign.messageId], outcome: 'failed',
  });
  assert.equal(notMine.reply.error.code, 'not-joined');
  assert.equal(rowOf(await census(), reportSoul).lastWake, 'failed');
});

test('a wake outcome survives a restart', async () => {
  await broker.stop();
  broker = await new Broker({ paths, uidOf, limits }).start();
  // Daemon credentials are replayed from the event log.
  const page = await request(paths.socket, { op: 'read', auth: owner, agentId: reportSoul, limit: 100 });
  assert.equal(page.reply.messages.at(-1).wake, 'failed');
  assert.equal(rowOf(await census(), reportSoul).lastWake, 'failed');
  assert.equal(rowOf(await census(), reportSoul).daemonWatching, false);
});

test('wake events for one soul are at most one per rate window, with counts merged', async () => {
  const watcher = openStream({ op: 'account-watch', auth: daemonAuth });
  await until(() => watcher.events.some((event) => event.event === 'ready'), 'ready');
  const first = await send('rate-1', rateSoul);
  await until(() => wakesFor(watcher.events, rateSoul).length === 1, 'first rate wake');
  const firstAt = Date.now();
  assert.deepEqual(wakesFor(watcher.events, rateSoul)[0].messageIds, [first.messageId]);

  const more = await Promise.all([0, 1, 2].map((i) => send(`rate-more-${i}`, rateSoul)));
  await new Promise((resolve) => setTimeout(resolve, windowMs + 100));
  assert.equal(wakesFor(watcher.events, rateSoul).length, 1, JSON.stringify(wakesFor(watcher.events, rateSoul)));

  await until(() => wakesFor(watcher.events, rateSoul).length === 2, 'merged rate wake');
  const second = wakesFor(watcher.events, rateSoul)[1];
  assert.equal(second.count, 3);
  assert.deepEqual(new Set(second.messageIds), new Set(more.map((one) => one.messageId)));
  assert.equal(second.cursor, first.seq);
  assert.ok(Date.now() - firstAt >= rateMs - 150, `second wake followed the first by ${Date.now() - firstAt}ms`);
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  assert.equal(wakesFor(watcher.events, rateSoul).length, 2);

  await closeSocket(watcher.socket);
  await ack(owner, rateSoul, [first.messageId, ...more.map((one) => one.messageId)]);
});

test('reconnecting announces the unacked backlog once', async () => {
  const sent = await Promise.all([0, 1, 2].map((i) => send(`back-${i}`, backlogSoul)));
  const first = openStream({ op: 'account-watch', auth: daemonAuth });
  await until(() => wakesFor(first.events, backlogSoul).length === 1, 'first backlog wake');
  assert.equal(first.events[0].event, 'ready');
  assert.equal(wakesFor(first.events, backlogSoul).length, 1);
  assert.equal(wakesFor(first.events, backlogSoul)[0].count, 3);
  assert.deepEqual(new Set(wakesFor(first.events, backlogSoul)[0].messageIds), new Set(sent.map((one) => one.messageId)));
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  assert.equal(wakesFor(first.events, backlogSoul).length, 1);
  await closeSocket(first.socket);

  const second = openStream({ op: 'account-watch', auth: daemonAuth });
  await until(() => wakesFor(second.events, backlogSoul).length === 1, 'reconnect backlog wake', rateMs + windowMs + 2000);
  assert.equal(wakesFor(second.events, backlogSoul).length, 1);
  assert.equal(wakesFor(second.events, backlogSoul)[0].count, 3);
  assert.deepEqual(
    new Set(wakesFor(second.events, backlogSoul)[0].messageIds),
    new Set(sent.map((one) => one.messageId)),
  );
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  assert.equal(wakesFor(second.events, backlogSoul).length, 1);

  await closeSocket(second.socket);
  await ack(owner, backlogSoul, sent.map((one) => one.messageId));
});

test('hardened accounts accept daemon wakes and reports without a soul token', async () => {
  const sent = await send('hardened wake', reportSoul);
  const hardened = await request(paths.admin, { op: 'harden', account: 'owner' });
  assert.equal(hardened.reply.hardened, true);
  try {
    const watcher = openStream({ op: 'account-watch', auth: daemonAuth });
    await until(() => wakesFor(watcher.events, reportSoul).length === 1, 'hardened wake');
    const reported = await request(paths.socket, {
      op: 'wake-report', auth: daemonAuth, agentId: reportSoul,
      messageIds: [sent.messageId], outcome: 'warm',
    });
    assert.deepEqual(reported.reply.recorded, [sent.messageId]);
    assert.equal(rowOf(await census(), reportSoul).lastWake, 'warm');
    await closeSocket(watcher.socket);
  } finally {
    await request(paths.admin, { op: 'harden', account: 'owner', off: true });
  }
});

test('revoking a daemon closes its stream and rejects its credential', async () => {
  const watcher = openStream({ op: 'account-watch', auth: personaDaemonAuth });
  await until(() => watcher.events.some((event) => event.event === 'ready'), 'daemon ready');
  const revoked = await request(paths.admin, { op: 'revoke', account: 'persona', kind: 'daemon' });
  assert.equal(revoked.reply.state, 'revoked');
  assert.equal(revoked.reply.watchesClosed, 1);
  await until(() => watcher.socket.destroyed, 'server closes revoked daemon stream');
  assert.equal(rowOf(await census(), guest).daemonWatching, false);
  for (const op of ['account-watch', 'wake-report']) {
    const denied = await request(paths.socket, {
      op, auth: personaDaemonAuth, agentId: guest, messageIds: ['msg_missing'], outcome: 'waiting',
    });
    assert.equal(denied.reply.error.code, 'unauthenticated');
  }
  // Account membership remains valid; a newly approved daemon can reconnect.
  assert.equal(rowOf(await census(), guest).presence, 'joined');
  await pairDaemon('persona', personaDaemonSecret);
});

test('revoking the account closes its daemon watch', async () => {
  const watcher = openStream({ op: 'account-watch', auth: personaDaemonAuth });
  await until(() => watcher.events.some((event) => event.event === 'ready'), 'persona ready');
  assert.equal(rowOf(await census(), guest).daemonWatching, true);
  const revoked = await request(paths.admin, { op: 'revoke', account: 'persona' });
  assert.equal(revoked.reply.state, 'revoked');
  assert.equal(revoked.reply.watchesClosed, 1);
  await closeSocket(watcher.socket);
  assert.equal(rowOf(await census(), guest).presence, 'left');
  assert.equal(rowOf(await census(), guest).daemonWatching, false);
});
