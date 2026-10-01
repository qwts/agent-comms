import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Broker, LIMITS } from '../lib/broker.mjs';
import { brokerPaths, clientPaths } from '../lib/paths.mjs';
import { PROTOCOL_VERSION, writeLine } from '../lib/wire.mjs';

const BIN = fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'ac-wake-'));
const windowMs = 1500;
const env = {
  ...process.env,
  AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'),
  AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker'),
  AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'client'),
};
const paths = brokerPaths(env);
const alice = `agent_${randomUUID()}`;
const bob = `agent_${randomUUID()}`;
const cara = `agent_${randomUUID()}`;
const erin = `agent_${randomUUID()}`;
const sockets = [];
let broker;

function cli(args, soul = alice) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...env, QWTS_AGENT_ID: soul } }, (error, stdout) => {
      let json;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = stdout;
      }
      resolve({ exit: error?.code ?? 0, json });
    });
  });
}

function until(events, predicate, ms = windowMs + 1000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) resolve();
      else if (Date.now() > deadline) reject(new Error(`timed out; saw ${JSON.stringify(events)}`));
      else setTimeout(check, 20);
    };
    check();
  });
}

function openWatch(agentId, mode) {
  const credential = JSON.parse(readFileSync(clientPaths(env).credential, 'utf8'));
  const socket = net.createConnection(paths.socket);
  sockets.push(socket);
  const events = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line) events.push(JSON.parse(line));
  });
  socket.on('connect', () => {
    writeLine(socket, {
      v: PROTOCOL_VERSION,
      op: 'watch',
      agentId,
      mode,
      auth: { account: credential.account, secret: credential.secret },
    });
  });
  return { socket, events };
}

before(async () => {
  broker = await new Broker({ paths, limits: { ...LIMITS, wakeWindowMs: windowMs } }).start();
  const paired = await cli(['account', 'pair', '--broker', os.userInfo().username]);
  assert.equal(paired.exit, 0, JSON.stringify(paired.json));
  const approved = await cli(['broker', 'approve', paired.json.code]);
  assert.equal(approved.json.state, 'approved');
  for (const [soul, name] of [[alice, 'alice'], [bob, 'bob'], [cara, 'cara'], [erin, 'erin']]) {
    const joined = await cli(['join', '--name', name, '--harness', 'test'], soul);
    assert.equal(joined.exit, 0, JSON.stringify(joined.json));
  }
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  if (broker) await broker.stop();
  rmSync(root, { recursive: true, force: true });
});

test('the wake window is one second unless the broker is given another', () => {
  assert.equal(LIMITS.wakeWindowMs, 1000);
});

test('a burst produces one wake with the count and the first unacked cursor', async () => {
  const watcher = openWatch(bob, 'wake');
  await until(watcher.events, () => watcher.events.some((event) => event.event === 'ready'), 2000);
  const sent = await Promise.all([0, 1, 2, 3, 4].map((i) => cli(['send', bob, '--body', `burst ${i}`, '--key', `burst-${i}`])));
  for (const one of sent) {
    assert.equal(one.exit, 0, JSON.stringify(one.json));
    assert.equal(one.json.wake, 'warm');
  }
  await until(watcher.events, () => watcher.events.some((event) => event.event === 'wake'));
  const cursor = Math.min(...sent.map((one) => one.json.seq));
  assert.deepEqual(watcher.events.filter((event) => event.event === 'wake'), [
    { event: 'wake', count: 5, cursor },
  ]);
  assert.equal(watcher.events.some((event) => event.event === 'message'), false);

  const page = await cli(['inbox', 'read', '--limit', '100'], bob);
  assert.deepEqual(page.json.messages.map((message) => message.body).sort(), [0, 1, 2, 3, 4].map((i) => `burst ${i}`));
  assert.ok(page.json.messages.every((message) => message.wake === 'warm'));
  assert.equal(page.json.messages[0].seq, cursor);

  // The next burst is its own wake. cursor stays on the oldest unacked message.
  const more = await Promise.all([0, 1].map((i) => cli(['send', bob, '--body', `later ${i}`, '--key', `later-${i}`])));
  for (const one of more) assert.equal(one.json.wake, 'warm');
  await until(watcher.events, () => watcher.events.filter((event) => event.event === 'wake').length === 2);
  assert.deepEqual(watcher.events.filter((event) => event.event === 'wake')[1], {
    event: 'wake', count: 2, cursor,
  });
  const after = await cli(['inbox', 'read', '--limit', '100'], bob);
  assert.equal(after.json.messages.length, 7);
  assert.equal(watcher.events.filter((event) => event.event === 'message').length, 0);
  watcher.socket.end();
});

test('a single message produces one wake and keeps its recorded outcome', async () => {
  const parked = await cli(['send', cara, '--body', 'parked', '--key', 'parked']);
  assert.equal(parked.exit, 0, JSON.stringify(parked.json));
  assert.equal(parked.json.wake, 'waiting');
  const stored = await cli(['inbox', 'read'], cara);
  assert.equal(stored.json.messages[0].wake, 'waiting');

  const watcher = openWatch(cara, 'wake');
  await until(watcher.events, () => watcher.events.some((event) => event.event === 'wake'));
  assert.deepEqual(watcher.events.filter((event) => event.event === 'wake'), [
    { event: 'wake', count: 1, cursor: parked.json.seq },
  ]);
  assert.equal(watcher.events.some((event) => event.event === 'message'), false);

  const acked = await cli(['inbox', 'ack', parked.json.messageId], cara);
  assert.equal(acked.json.acknowledged, 1);
  const live = await cli(['send', cara, '--body', 'live', '--key', 'live']);
  assert.equal(live.json.wake, 'warm');
  await until(watcher.events, () => watcher.events.filter((event) => event.event === 'wake').length === 2);
  assert.deepEqual(watcher.events.filter((event) => event.event === 'wake')[1], {
    event: 'wake', count: 1, cursor: live.json.seq,
  });
  const page = await cli(['inbox', 'read'], cara);
  assert.deepEqual(page.json.messages.map((message) => message.body), ['live']);
  assert.equal(page.json.messages[0].wake, 'warm');
  watcher.socket.end();
});

test('full mode keeps one message event per message', async () => {
  const first = await cli(['send', erin, '--body', 'one', '--key', 'full-1']);
  const second = await cli(['send', erin, '--body', 'two', '--key', 'full-2']);
  assert.equal(first.json.wake, 'waiting');
  assert.equal(second.json.wake, 'waiting');
  const watcher = openWatch(erin, 'full');
  await until(watcher.events, () => watcher.events.some((event) => event.event === 'ready'), 2000);
  await until(watcher.events, () => watcher.events.some((event) => event.message?.id === second.json.messageId), 2000);
  const third = await cli(['send', erin, '--body', 'three', '--key', 'full-3']);
  assert.equal(third.json.wake, 'warm');
  await until(watcher.events, () => watcher.events.some((event) => event.message?.id === third.json.messageId), 2000);
  assert.equal(watcher.events.some((event) => event.event === 'wake'), false);
  const messages = watcher.events.filter((event) => event.event === 'message');
  assert.deepEqual(messages.map((event) => event.message.body), ['one', 'two', 'three']);
  assert.equal(messages[0].message.wake, 'waiting');
  assert.equal(messages.at(-1).message.wake, 'warm');
  const page = await cli(['inbox', 'read', '--limit', '100'], erin);
  assert.equal(page.json.messages.length, 3);
  watcher.socket.end();
});

test('a watch mode other than full or wake is refused', async () => {
  const credential = JSON.parse(readFileSync(clientPaths(env).credential, 'utf8'));
  const reply = await new Promise((resolve) => {
    const socket = net.createConnection(paths.socket);
    sockets.push(socket);
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('close', () => resolve(data));
    socket.on('connect', () => writeLine(socket, {
      v: PROTOCOL_VERSION,
      op: 'watch',
      agentId: bob,
      mode: 'sometimes',
      auth: { account: credential.account, secret: credential.secret },
    }));
  });
  const json = JSON.parse(reply);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'bad-request');
});
