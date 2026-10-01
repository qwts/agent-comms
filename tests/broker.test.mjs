import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Broker } from '../lib/broker.mjs';
import { brokerPaths } from '../lib/paths.mjs';

const BIN = fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'ac-'));
const env = {
  ...process.env,
  AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'),
  AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker'),
  AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'client'),
};
const paths = brokerPaths(env);
const alice = `agent_${randomUUID()}`;
const bob = `agent_${randomUUID()}`;
let broker;

function cli(args, soul = alice, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...env, QWTS_AGENT_ID: soul, ...extraEnv } }, (error, stdout) => {
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

const expectCode = async (args, code, soul) => {
  const { exit, json } = await cli(args, soul);
  assert.notEqual(exit, 0, `${args.join(' ')} should fail`);
  assert.equal(json.error.code, code);
};

before(async () => {
  broker = await new Broker({ paths }).start();
  const paired = await cli(['account', 'pair', '--broker', os.userInfo().username]);
  assert.equal(paired.exit, 0, JSON.stringify(paired.json));
  await expectCode(['join'], 'not-approved');
  const approved = await cli(['broker', 'approve', paired.json.code]);
  assert.equal(approved.json.state, 'approved');
  for (const [soul, name] of [[alice, 'alice'], [bob, 'bob']]) {
    const joined = await cli(['join', '--name', name, '--harness', 'test'], soul);
    assert.equal(joined.json.verification, 'claimed');
  }
});

after(async () => {
  await broker.stop();
  rmSync(root, { recursive: true, force: true });
});

test('the shared directory and socket keep client accounts out', () => {
  assert.equal(statSync(paths.shared).mode & 0o777, 0o755);
  assert.equal(statSync(paths.socket).mode & 0o777, 0o600);
  assert.equal(statSync(paths.proofs).mode & 0o7777, 0o1777);
  assert.equal(statSync(paths.state).mode & 0o777, 0o700);
});

test('peers lists other joined souls by address', async () => {
  const { json } = await cli(['peers']);
  assert.deepEqual(json.peers.map((peer) => peer.name), ['bob']);
  assert.match(json.peers[0].address, new RegExp(`/${bob}$`));
});

test('send, read, and ack follow the acknowledgement watermark', async () => {
  const sent = await cli(['send', bob, '--body', 'hello bob', '--key', 'k1']);
  assert.equal(sent.exit, 0, JSON.stringify(sent.json));
  assert.equal(sent.json.wake, 'waiting');

  const first = await cli(['inbox', 'read'], bob);
  assert.equal(first.json.messages.length, 1);
  const [message] = first.json.messages;
  assert.equal(message.body, 'hello bob');
  assert.equal(message.from.verification, 'claimed');

  // A crash before ack: the next read starts at the same message again.
  const again = await cli(['inbox', 'read'], bob);
  assert.equal(again.json.messages[0].id, message.id);

  const acked = await cli(['inbox', 'ack', message.id], bob);
  assert.equal(acked.json.acknowledged, 1);
  const empty = await cli(['inbox', 'read'], bob);
  assert.equal(empty.json.messages.length, 0);
});

test('idempotency covers the whole request', async () => {
  const one = await cli(['send', bob, '--body', 'same', '--key', 'k2']);
  const two = await cli(['send', bob, '--body', 'same', '--key', 'k2']);
  assert.equal(two.json.duplicate, true);
  assert.equal(two.json.messageId, one.json.messageId);
  await expectCode(['send', bob, '--body', 'same', '--kind', 'note', '--key', 'k2'], 'conflict');
});

test('replies carry depth and cannot answer your own message', async () => {
  const sent = await cli(['send', bob, '--body', 'question', '--key', 'k3']);
  const reply = await cli(['send', alice, '--body', 'answer', '--key', 'k4', '--reply-to', sent.json.messageId], bob);
  assert.equal(reply.exit, 0, JSON.stringify(reply.json));
  await expectCode(['send', bob, '--body', 'x', '--key', 'k5', '--reply-to', sent.json.messageId], 'unknown-message');
  const inbox = await cli(['inbox', 'read'], alice);
  const answer = inbox.json.messages.find((m) => m.id === reply.json.messageId);
  assert.equal(answer.depth, 1);
});

test('allowlists hide a soul from senders it does not accept', async () => {
  const carol = `agent_${randomUUID()}`;
  await cli(['join', '--name', 'carol', '--allow', bob], carol);
  const peers = await cli(['peers']);
  assert.ok(!peers.json.peers.some((peer) => peer.agentId === carol));
  await expectCode(['send', carol, '--body', 'hi', '--key', 'k6'], 'unknown-recipient');
  const fromBob = await cli(['send', carol, '--body', 'hi', '--key', 'k7'], bob);
  assert.equal(fromBob.exit, 0);
});

test('watch streams unacknowledged and new messages, and send reports a warm wake', async () => {
  const watcher = spawn(process.execPath, [BIN, 'inbox', 'watch'], { env: { ...env, QWTS_AGENT_ID: bob } });
  const events = [];
  const seen = (predicate) => new Promise((resolve) => {
    const check = () => {
      if (events.some(predicate)) resolve();
      else setTimeout(check, 20);
    };
    check();
  });
  let buffer = '';
  watcher.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    events.push(...lines.filter(Boolean).map((line) => JSON.parse(line)));
  });
  await seen((event) => event.event === 'ready');
  const sent = await cli(['send', bob, '--body', 'are you there', '--key', 'k8']);
  assert.equal(sent.json.wake, 'warm');
  await seen((event) => event.message?.id === sent.json.messageId);
  watcher.kill();
});

test('a pairing proof from another uid is refused', async () => {
  const other = await new Broker({
    paths: brokerPaths({ ...env, AGENT_COMMS_SHARED_DIR: path.join(root, 's2'), AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'b2') }),
    uidOf: () => process.getuid() + 1,
  }).start();
  try {
    const { json } = await cli(['account', 'pair', '--broker', os.userInfo().username], alice, {
      AGENT_COMMS_SHARED_DIR: path.join(root, 's2'), AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'c2'),
    });
    assert.equal(json.error.code, 'pairing-proof-invalid');
  } finally {
    await other.stop();
  }
});

test('the client refuses a broker directory others can write', async () => {
  chmodSync(paths.shared, 0o777);
  try {
    await expectCode(['peers'], 'broker-untrusted');
  } finally {
    chmodSync(paths.shared, 0o755);
  }
});

test('state survives a restart, and a torn tail is cut off', async () => {
  const before = await cli(['inbox', 'read'], alice);
  await broker.stop();
  appendFileSync(path.join(paths.state, 'events.jsonl'), '{"t":"message","mess');
  broker = await new Broker({ paths }).start();
  const afterRestart = await cli(['inbox', 'read'], alice);
  assert.deepEqual(afterRestart.json.messages.map((m) => m.id), before.json.messages.map((m) => m.id));
  const sent = await cli(['send', bob, '--body', 'after restart', '--key', 'k9']);
  assert.equal(sent.exit, 0, JSON.stringify(sent.json));
});

test('an unbound caller fails with unbound', async () => {
  const { exit, json } = await new Promise((resolve) => {
    const rest = { ...env };
    delete rest.QWTS_AGENT_ID;
    execFile(process.execPath, [BIN, 'peers'], { env: rest, cwd: root }, (error, stdout) => {
      resolve({ exit: error?.code ?? 0, json: JSON.parse(stdout) });
    });
  });
  assert.notEqual(exit, 0);
  assert.equal(json.error.code, 'unbound');
});

test('an oversized line is refused and the connection dropped, newline or not', async () => {
  for (const tail of ['\n', '']) {
    const reply = await new Promise((resolve) => {
      const socket = net.createConnection(paths.socket);
      let data = '';
      socket.on('connect', () => socket.write(`${'x'.repeat(200 * 1024)}${tail}`));
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('close', () => resolve(data));
      socket.on('error', (error) => {
        data += `ERR ${error.code}`;
      });
    });
    // The broker refuses and drops the connection, usually while the client is
    // still writing, so the client sees either the refusal or a broken pipe.
    assert.match(reply, /line exceeds the protocol limit|ERR (EPIPE|ECONNRESET)/);
  }
  const stillUp = await cli(['peers']);
  assert.equal(stillUp.exit, 0);
});

test('the broker refuses a symlinked shared directory', async () => {
  const real = path.join(root, 'elsewhere');
  mkdirSync(real);
  const link = path.join(root, 'linked');
  symlinkSync(real, link);
  const planted = new Broker({
    paths: brokerPaths({ ...env, AGENT_COMMS_SHARED_DIR: link, AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'b3') }),
  });
  await assert.rejects(planted.start(), { code: 'shared-dir-untrusted' });
});

test('pairing refuses a broker owned by an account other than the named one', async () => {
  const { json } = await cli(['account', 'pair', '--broker', 'root'], alice, { AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'c3') });
  assert.equal(json.error.code, 'broker-untrusted');
});

test('revoking an account closes its watches and hides its souls at once', async () => {
  const watcher = spawn(process.execPath, [BIN, 'inbox', 'watch'], { env: { ...env, QWTS_AGENT_ID: bob } });
  const closed = new Promise((resolve) => watcher.on('exit', resolve));
  await new Promise((resolve) => watcher.stdout.once('data', resolve));
  const revoked = await cli(['broker', 'revoke', os.userInfo().username]);
  assert.equal(revoked.json.watchesClosed, 1);
  await closed;
  await expectCode(['peers'], 'unauthenticated');
});
