import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createDiagnosticSink, DIAGNOSTIC_LIMITS } from '../lib/diagnostics.mjs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Broker, sha256 } from '../lib/broker.mjs';
import { brokerPaths } from '../lib/paths.mjs';
import { PROTOCOL_VERSION } from '../lib/wire.mjs';

const CANARY = 'CANARY-private-body-key-secret';
async function fixture(t, { diagnostic, retention = 10000 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-mailbox-diagnostic-'));
  const paths = brokerPaths({ AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'), AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker') });
  let at = 100000;
  let broker;
  const sockets = new Set();
  const options = { paths, mode: 'single-account', now: () => at, diagnostic, limits: { messageRetentionMs: retention } };
  async function start() { broker = await new Broker(options).start(); }
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    try { await broker?.stop(); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  function request(op, fields = {}, admin = false) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(admin ? paths.admin : paths.socket);
      sockets.add(socket);
      let buffer = '';
      const finish = (error, reply) => { socket.destroy(); error ? reject(error) : resolve(reply); };
      socket.setTimeout(2000, () => finish(new Error('owned mailbox request deadline')));
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, op, ...fields })}\n`));
      socket.on('error', reject);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes('\n')) { try { finish(null, JSON.parse(buffer.split('\n')[0])); } catch (error) { finish(error); } }
      });
    });
  }
  await start();
  const account = os.userInfo().username;
  const secret = randomBytes(32).toString('hex');
  const proof = `${randomBytes(16).toString('hex')}.proof`;
  writeFileSync(path.join(paths.proofs, proof), sha256(secret), { mode: 0o644 });
  const pair = await request('pair-request', { account, secretHash: sha256(secret), proof });
  assert.equal(pair.ok, true, JSON.stringify(pair));
  assert.equal((await request('approve', { code: pair.code }, true)).ok, true);
  const auth = { account, secret };
  const souls = [randomUUID(), randomUUID(), randomUUID()].map((id) => `agent_${id}`);
  for (const agentId of souls) assert.equal((await request('join', { auth, agentId })).ok, true);
  async function principal(grant) {
    const secret = randomBytes(32).toString('hex');
    const pending = await request('principal-pair-request', { auth, secretHash: sha256(secret), name: 'mailbox-test' });
    assert.equal((await request('principal-approve', { code: pending.code, grant }, true)).ok, true);
    return { principal: pending.principal, secret };
  }
  const full = await principal(null);
  const narrow = await principal([souls[1]]);
  const send = (key = CANARY, to = souls[1]) => request('send', { auth, agentId: souls[0], to, key, body: CANARY });
  const read = () => request('read', { auth, agentId: souls[1] });
  const ack = (ids) => request('ack', { auth, agentId: souls[1], ids });
  const census = (credential = full) => request('census', { auth: credential });
  return { request, send, read, ack, census, auth, full, narrow, souls, paths,
    setTime: (value) => { at = value; }, broker: () => broker,
    restart: async () => { await broker.stop(); await start(); } };
}

const mailboxEvents = (reports) => reports.filter(([event]) => event.startsWith('mailbox-'));
const row = (reply, id) => reply.souls.find((soul) => soul.agentId === id);

test('actual admitted/read/ack boundaries preserve idempotency, grant filtering and queue age', { skip: process.platform === 'win32', timeout: 15000 }, async (t) => {
  const reports = [];
  const f = await fixture(t, { diagnostic: (...args) => reports.push(args) });
  assert.equal(row(await f.census(), f.souls[1]).oldestUnackedAgeMs, null);
  const sent = await f.send(); assert.equal(sent.ok, true);
  f.setTime(100750);
  let status = row(await f.census(), f.souls[1]);
  assert.deepEqual([status.unacked, status.oldestUnackedAgeMs], [1, 750]);
  const duplicate = await f.send();
  assert.equal(duplicate.messageId, sent.messageId); assert.equal(duplicate.duplicate, true);
  const read = await f.read(); assert.equal(read.messages.length, 1);
  status = row(await f.census(), f.souls[1]); assert.deepEqual([status.unacked, status.oldestUnackedAgeMs], [1, 750]);
  assert.equal((await f.send('hidden-key', f.souls[2])).ok, true);
  const narrowed = await f.census(f.narrow);
  assert.deepEqual(narrowed.souls.map((soul) => soul.agentId), [f.souls[1]]);
  assert.ok(!JSON.stringify(narrowed).includes(f.souls[2]));
  assert.equal((await f.census({ ...f.full, secret: CANARY })).error.code, 'unauthenticated');
  const before = mailboxEvents(reports).length;
  assert.equal((await f.request('send', { auth: f.auth, agentId: f.souls[0], to: 'nobody', body: CANARY, key: 'refused' })).error.code, 'unknown-recipient');
  assert.equal(mailboxEvents(reports).length, before, 'refusal is not a completed admission');
  assert.deepEqual(await f.ack([sent.messageId]), { ok: true, acknowledged: 1, alreadyAcknowledged: 0 });
  assert.deepEqual(await f.ack([sent.messageId]), { ok: true, acknowledged: 0, alreadyAcknowledged: 1 });
  assert.equal(row(await f.census(), f.souls[1]).oldestUnackedAgeMs, null);
  const events = mailboxEvents(reports);
  assert.deepEqual(events.map(([event]) => event), ['mailbox-admitted', 'mailbox-duplicate', 'mailbox-read', 'mailbox-admitted', 'mailbox-acked', 'mailbox-acked']);
  assert.deepEqual(events.filter(([event]) => event === 'mailbox-acked').map(([, , fresh, repeated]) => [fresh, repeated]), [[1, 0], [0, 1]]);
  assert.ok(events.every(([, duration]) => Number.isSafeInteger(duration) && duration >= 0));
  assert.ok(!JSON.stringify(events).includes(CANARY));
  const journal = readFileSync(f.broker().log.file, 'utf8');
  assert.ok(!journal.includes('mailbox-admitted'));
});

test('canonical queue age survives compaction/restart, clamps rollback, and excludes expiry', { skip: process.platform === 'win32', timeout: 15000 }, async (t) => {
  const f = await fixture(t, { diagnostic: () => {} });
  await f.send();
  f.setTime(100500);
  f.broker().maintain({ compact: true });
  await f.restart();
  assert.equal(row(await f.census(), f.souls[1]).oldestUnackedAgeMs, 500);
  f.setTime(99000);
  // Broker's existing maintenance clock floor is authoritative after rollback.
  assert.equal(row(await f.census(), f.souls[1]).oldestUnackedAgeMs, 500);
  f.setTime(110001);
  const status = row(await f.census(), f.souls[1]);
  assert.deepEqual([status.unacked, status.oldestUnackedAgeMs], [0, null]);
});

test('throwing diagnostic consumer cannot change successful durable mailbox results', { skip: process.platform === 'win32', timeout: 15000 }, async (t) => {
  const f = await fixture(t, { diagnostic: () => { throw new Error(CANARY); } });
  const sent = await f.send(); assert.equal(sent.ok, true);
  assert.equal((await f.send()).messageId, sent.messageId);
  assert.equal((await f.read()).messages[0].id, sent.messageId);
  await f.restart();
  assert.equal((await f.read()).messages[0].id, sent.messageId);
  assert.equal((await f.ack([sent.messageId])).acknowledged, 1);
  await f.restart();
  assert.equal((await f.read()).messages.length, 0);
});


test('real mailbox results survive shared sink overload/failure and serialized records omit canaries', { skip: process.platform === 'win32', timeout: 15000 }, async (t) => {
  const stream = new EventEmitter();
  const lines = [];
  let stalled = false;
  stream.write = (line, complete) => { lines.push(line); if (!stalled) complete(); return !stalled; };
  const sink = createDiagnosticSink(stream);
  t.after(() => stream.emit('close'));
  const f = await fixture(t, { diagnostic: sink.report });
  const sent = await f.send();
  await f.read();
  // Give the healthy writer its event-loop turn before stalling it.
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(lines.some((line) => JSON.parse(line).event === 'mailbox.admitted'));
  assert.ok(lines.some((line) => JSON.parse(line).event === 'mailbox.read'));
  for (const line of lines) {
    assert.ok(!line.includes(CANARY));
    for (const id of f.souls) assert.ok(!line.includes(id));
    assert.ok(!line.includes(f.auth.secret));
  }
  stalled = true;
  for (let i = 0; i < 150; i += 1) assert.equal((await f.read()).messages[0].id, sent.messageId);
  assert.ok(sink.stats().queued <= DIAGNOSTIC_LIMITS.events);
  assert.ok(sink.stats().queuedBytes <= DIAGNOSTIC_LIMITS.bytes);
  assert.ok(sink.stats().dropped > 0);
  stream.emit('error', new Error(CANARY));
  assert.equal(sink.stats().disabled, true);
  assert.equal((await f.ack([sent.messageId])).acknowledged, 1);
  assert.equal((await f.read()).messages.length, 0);
  assert.equal((await f.send()).duplicate, true);
  await f.restart();
  assert.equal((await f.read()).messages.length, 0);
});

test('queue age follows the oldest pending message and clamps age after clock rollback', { skip: process.platform === 'win32', timeout: 15000 }, async (t) => {
  const f = await fixture(t, { diagnostic: () => {} });
  f.setTime(100500);
  const first = await f.send('first');
  f.setTime(100900);
  await f.send('second');
  const page = await f.request('read', { auth: f.auth, agentId: f.souls[1], limit: 1 });
  assert.deepEqual([page.messages.length, page.remaining], [1, 1]);
  assert.equal(row(await f.census(), f.souls[1]).unacked, 2);
  assert.equal(row(await f.census(), f.souls[1]).oldestUnackedAgeMs, 400);
  await f.ack([first.messageId]);
  assert.equal(row(await f.census(), f.souls[1]).oldestUnackedAgeMs, 0);
  f.setTime(100100);
  assert.equal(row(await f.census(), f.souls[1]).oldestUnackedAgeMs, 0);
  f.setTime(101000);
  assert.equal(row(await f.census(), f.souls[1]).oldestUnackedAgeMs, 100);
});

test('failed durable append never emits successful admission or acknowledgment', { skip: process.platform === 'win32', timeout: 15000 }, async (t) => {
  const reports = [];
  const f = await fixture(t, { diagnostic: (...args) => reports.push(args) });
  const append = t.mock.method(f.broker().log, 'append', () => { throw new Error(CANARY); });
  assert.equal((await f.send()).error.code, 'storage-failed');
  assert.deepEqual(mailboxEvents(reports), []);
  append.mock.restore();
  await f.restart();
  const sent = await f.send();
  const before = mailboxEvents(reports).length;
  const ackAppend = t.mock.method(f.broker().log, 'append', () => { throw new Error(CANARY); });
  assert.equal((await f.ack([sent.messageId])).error.code, 'storage-failed');
  assert.equal(mailboxEvents(reports).length, before);
  ackAppend.mock.restore();
  await f.restart();
  assert.equal((await f.read()).messages[0].id, sent.messageId);
});
