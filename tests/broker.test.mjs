import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { Broker } from '../lib/broker.mjs';
import { brokerPaths } from '../lib/paths.mjs';
import { checkBrokerCustody } from '../lib/client.mjs';
import { call, pairAccount, withBroker } from './helpers/broker.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runCli = promisify(execFile);

const waitFor = async (description, predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${description}`);
};

const newSoul = () => `agent_${randomUUID()}`;

const watch = (env, soul) => {
  const child = spawn(process.execPath, [new URL('../bin/agent-comms.mjs', import.meta.url).pathname, 'inbox', 'watch', '--full'], {
    env: { ...env, QWTS_AGENT_ID: soul },
  });
  const events = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // stdout can deliver arbitrary chunks; leave malformed fragments for
        // the next event instead of letting a partial line crash the test.
        buffer = `${line}${buffer}`;
      }
    }
  });
  return { child, events, wait: (description, predicate) => waitFor(description, () => events.some(predicate)) };
};

test('the shared directory and socket keep client accounts out', async () => withBroker(({ paths }) => {
  assert.equal(statSync(paths.shared).mode & 0o777, 0o755);
  assert.equal(statSync(paths.socket).mode & 0o777, 0o600);
  assert.equal(statSync(paths.proofs).mode & 0o7777, 0o1777);
  assert.equal(statSync(paths.state).mode & 0o777, 0o700);
}));

test('single-account custody accepts only the owner-owned private rendezvous', async () => withBroker(async ({ paths, broker }) => {
  assert.equal(broker.mode, 'single-account');
  assert.equal(statSync(paths.shared).uid, process.getuid());
  assert.equal(statSync(paths.socket).uid, process.getuid());
  assert.equal(statSync(paths.socket).mode & 0o777, 0o600);
  assert.doesNotThrow(() => checkBrokerCustody(paths, process.getuid(), 'single-account'));
  assert.throws(() => checkBrokerCustody(paths, process.getuid() + 1, 'single-account'), { code: 'broker-untrusted' });
}, { brokerOptions: { mode: 'single-account' } }));

test('peers lists other joined souls by address', async () => withBroker(async ({ cli, accounts }) => {
  const { json } = await cli(['peers']);
  assert.deepEqual(json.peers.map((peer) => peer.name), ['bob']);
  assert.match(json.peers[0].address, new RegExp(`/${accounts.bob}$`));
}));

test('send, read, and ack follow the acknowledgement watermark', async () => withBroker(async ({ cli, accounts }) => {
  const sent = await cli(['send', accounts.bob, '--body', 'hello bob', '--key', 'k1']);
  assert.equal(sent.exit, 0, JSON.stringify(sent.json));
  assert.equal(sent.json.wake, 'waiting');
  const first = await cli(['inbox', 'read'], accounts.bob);
  assert.equal(first.json.messages.length, 1);
  const [message] = first.json.messages;
  assert.equal(message.body, 'hello bob');
  assert.equal(message.from.verification, 'claimed');
  assert.equal((await cli(['inbox', 'read'], accounts.bob)).json.messages[0].id, message.id);
  assert.equal((await cli(['inbox', 'ack', message.id], accounts.bob)).json.acknowledged, 1);
  assert.equal((await cli(['inbox', 'read'], accounts.bob)).json.messages.length, 0);
}));

test('idempotency covers the whole request', async () => withBroker(async ({ cli, accounts }) => {
  const one = await cli(['send', accounts.bob, '--body', 'same', '--key', 'k2']);
  const two = await cli(['send', accounts.bob, '--body', 'same', '--key', 'k2']);
  assert.equal(two.json.duplicate, true);
  assert.equal(two.json.messageId, one.json.messageId);
  const conflict = await cli(['send', accounts.bob, '--body', 'same', '--kind', 'note', '--key', 'k2']);
  assert.equal(conflict.json.error.code, 'conflict');
}));

test('replies carry depth and cannot answer your own message', async () => withBroker(async ({ cli, accounts }) => {
  const sent = await cli(['send', accounts.bob, '--body', 'question', '--key', 'k3']);
  const reply = await cli(['send', accounts.alice, '--body', 'answer', '--key', 'k4', '--reply-to', sent.json.messageId], accounts.bob);
  assert.equal(reply.exit, 0, JSON.stringify(reply.json));
  const ownReply = await cli(['send', accounts.bob, '--body', 'x', '--key', 'k5', '--reply-to', sent.json.messageId]);
  assert.equal(ownReply.json.error.code, 'unknown-message');
  const inbox = await cli(['inbox', 'read'], accounts.alice);
  assert.equal(inbox.json.messages.find((m) => m.id === reply.json.messageId).depth, 1);
}));

test('allowlists hide a soul from senders it does not accept', async () => withBroker(async ({ cli, accounts }) => {
  const carol = newSoul();
  await cli(['join', '--name', 'carol', '--allow', accounts.bob], carol);
  const peers = await cli(['peers']);
  assert.ok(!peers.json.peers.some((peer) => peer.agentId === carol));
  assert.equal((await cli(['send', carol, '--body', 'hi', '--key', 'k6'])).json.error.code, 'unknown-recipient');
  assert.equal((await cli(['send', carol, '--body', 'hi', '--key', 'k7'], accounts.bob)).exit, 0);
}));

test('watch streams backlog and new messages, and send reports a warm wake', async () => withBroker(async ({ cli, env, accounts }) => {
  const backlog = await cli(['send', accounts.bob, '--body', 'sent before the watch', '--key', 'k8-backlog']);
  const watcher = watch(env, accounts.bob);
  try {
    await watcher.wait('watch ready event', (event) => event.event === 'ready');
    await watcher.wait('backlog message', (event) => event.message?.id === backlog.json.messageId);
    const sent = await cli(['send', accounts.bob, '--body', 'are you there', '--key', 'k8']);
    assert.equal(sent.json.wake, 'warm');
    await watcher.wait('new watch message', (event) => event.message?.id === sent.json.messageId);
  } finally {
    watcher.child.kill();
  }
}));

test('a pairing proof from another uid is refused', async () => withBroker(async ({ root, env, cli, accounts }) => {
  const otherPaths = brokerPaths({ ...env, AGENT_COMMS_SHARED_DIR: path.join(root, 's2'), AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'b2') });
  const other = await new Broker({ paths: otherPaths, uidOf: () => process.getuid() + 1 }).start();
  try {
    const result = await cli(['account', 'pair', '--broker', os.userInfo().username], accounts.alice, {
      AGENT_COMMS_SHARED_DIR: otherPaths.shared,
      AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'c2'),
    });
    assert.equal(result.json.error.code, 'pairing-proof-invalid');
  } finally {
    await other.stop();
  }
}));

test('the client refuses a broker directory others can write', async () => withBroker(async ({ cli, paths }) => {
  chmodSync(paths.shared, 0o777);
  try {
    assert.equal((await cli(['peers'])).json.error.code, 'broker-untrusted');
  } finally {
    chmodSync(paths.shared, 0o755);
  }
}));

test('state and wake outcomes survive a restart, and a torn tail is cut off by bytes', async () => withBroker(async ({ cli, env, paths, accounts, broker }) => {
  const watcher = watch(env, accounts.bob);
  await watcher.wait('watch ready before baseline delivery', (event) => event.event === 'ready');
  const warmSent = await cli(['send', accounts.bob, '--body', 'state survives restart', '--key', 'k9-before']);
  assert.equal(warmSent.json.wake, 'warm');
  watcher.child.kill();
  await cli(['send', accounts.alice, '--body', 'baseline for alice', '--key', 'k9-before-alice'], accounts.bob);
  const before = await cli(['inbox', 'read'], accounts.alice);
  const warm = (await cli(['inbox', 'read', '--limit', '100'], accounts.bob)).json.messages.find((message) => message.from.agentId === accounts.alice);
  await broker.stop();
  const snowman = Buffer.from('☃');
  appendFileSync(path.join(paths.state, 'events.jsonl'), Buffer.concat([Buffer.from('{"t":"message","body":"'), snowman.subarray(0, 2)]));
  const restarted = await new Broker({ paths }).start();
  try {
    const afterRestart = await cli(['inbox', 'read'], accounts.alice);
    assert.deepEqual(afterRestart.json.messages.map((m) => m.id), before.json.messages.map((m) => m.id));
    const rewoken = (await cli(['inbox', 'read', '--limit', '100'], accounts.bob)).json.messages.find((m) => m.id === warm.id);
    assert.equal(rewoken.wake, 'warm');
    const sent = await cli(['send', accounts.bob, '--body', 'after restart ☃', '--key', 'k9']);
    await restarted.stop();
    const replayedBroker = await new Broker({ paths }).start();
    try {
      const replayed = (await cli(['inbox', 'read', '--limit', '100'], accounts.bob)).json.messages.find((m) => m.id === sent.json.messageId);
      assert.equal(replayed.body, 'after restart ☃');
    } finally {
      await replayedBroker.stop();
    }
  } finally {
    // withBroker owns the original instance; stop is idempotent after restarts.
    await restarted.stop();
  }
}));

test('send refuses a body that would not fit in a read page once escaped', async () => withBroker(async ({ cli, root, accounts }) => {
  const file = path.join(root, 'nul-body');
  writeFileSync(file, '\0'.repeat(21_500));
  assert.equal((await cli(['send', accounts.bob, '--body-file', file, '--key', 'k-nul'])).json.error.code, 'message-too-large');
}));

test('a second broker refuses to take over a live socket', async () => withBroker(async ({ cli, paths }) => {
  await assert.rejects(new Broker({ paths }).start(), (error) => error.code === 'broker-running');
  assert.equal((await cli(['peers'])).exit, 0);
}));

test('the broker refuses a state directory others can write', async () => withBroker(async ({ root, env }) => {
  const stateDir = path.join(root, 'b3');
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o777);
  const other = new Broker({ paths: brokerPaths({ ...env, AGENT_COMMS_SHARED_DIR: path.join(root, 's3'), AGENT_COMMS_BROKER_STATE_DIR: stateDir }) });
  await assert.rejects(other.start(), (error) => error.code === 'state-dir-untrusted');
  assert.equal(other.state.messages.size, 0);
}));

test('the client refuses a credential directory others can write', async () => withBroker(async ({ cli, env }) => {
  chmodSync(env.AGENT_COMMS_CLIENT_STATE_DIR, 0o777);
  try {
    assert.equal((await cli(['peers'])).json.error.code, 'client-dir-untrusted');
  } finally {
    chmodSync(env.AGENT_COMMS_CLIENT_STATE_DIR, 0o700);
  }
}));

test('a retry gets its original answer after the recipient leaves', async () => withBroker(async ({ cli }) => {
  const dave = newSoul();
  await cli(['join', '--name', 'dave'], dave);
  const first = await cli(['send', dave, '--body', 'before you go', '--key', 'k-dave']);
  await cli(['leave'], dave);
  const retry = await cli(['send', dave, '--body', 'before you go', '--key', 'k-dave']);
  assert.equal(retry.json.duplicate, true);
  assert.equal(retry.json.messageId, first.json.messageId);
  assert.equal((await cli(['send', dave, '--body', 'a new message', '--key', 'k-dave-2'])).json.error.code, 'unknown-recipient');
}));

test('a read page stays within one protocol line', async () => withBroker(async ({ cli }) => {
  const erin = newSoul();
  await cli(['join', '--name', 'erin'], erin);
  const body = 'x'.repeat(30 * 1024);
  for (let i = 0; i < 6; i += 1) assert.equal((await cli(['send', erin, '--body', body, '--key', `k-erin-${i}`])).exit, 0);
  const page = await cli(['inbox', 'read', '--limit', '100'], erin);
  assert.ok(page.json.messages.length >= 1 && page.json.messages.length < 6);
  assert.equal(page.json.remaining, 6 - page.json.messages.length);
}));

test('an unbound caller fails with unbound', async () => withBroker(async ({ env, root }) => {
  const unbound = { ...env };
  delete unbound.QWTS_AGENT_ID;
  const { execFile } = await import('node:child_process');
  const result = await new Promise((resolve) => execFile(process.execPath, [new URL('../bin/agent-comms.mjs', import.meta.url).pathname, 'peers'], { env: unbound, cwd: root }, (error, stdout) => resolve({ exit: error?.code ?? 0, json: JSON.parse(stdout) })));
  assert.notEqual(result.exit, 0);
  assert.equal(result.json.error.code, 'unbound');
}));

test('an oversized line is refused and the connection dropped, newline or not', async () => withBroker(async ({ cli, paths }) => {
  for (const tail of ['\n', '']) {
    const reply = await new Promise((resolve) => {
      const socket = net.createConnection(paths.socket);
      let data = '';
      socket.on('connect', () => socket.write(`${'x'.repeat(200 * 1024)}${tail}`));
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('close', () => resolve(data));
      socket.on('error', (error) => { data += `ERR ${error.code}`; });
    });
    assert.match(reply, /line exceeds the protocol limit|ERR (EPIPE|ECONNRESET)/);
  }
  assert.equal((await cli(['peers'])).exit, 0);
}));

test('the broker refuses a symlinked shared directory', async () => withBroker(async ({ root, env }) => {
  const real = path.join(root, 'elsewhere');
  mkdirSync(real);
  const link = path.join(root, 'linked');
  symlinkSync(real, link);
  const planted = new Broker({ paths: brokerPaths({ ...env, AGENT_COMMS_SHARED_DIR: link, AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'b3') }) });
  await assert.rejects(planted.start(), { code: 'shared-dir-untrusted' });
}));

test('pairing refuses a broker owned by an account other than the named one', async () => withBroker(async ({ cli, root, accounts }) => {
  const result = await cli(['account', 'pair', '--broker', 'root'], accounts.alice, { AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'c3') });
  assert.equal(result.json.error.code, 'broker-untrusted');
}));

test('revoking an account closes its watches and hides its souls at once', async () => withBroker(async ({ cli, env, paths, accounts }) => {
  const secondAccount = 'other';
  const secondSoul = newSoul();
  const otherPairRequest = await pairAccount(paths, secondAccount, process.getuid());
  assert.equal(otherPairRequest.ok, true, JSON.stringify(otherPairRequest));
  const otherApproved = await cli(['broker', 'approve', otherPairRequest.code]);
  assert.equal(otherApproved.exit, 0, JSON.stringify(otherApproved.json));
  const secondCredential = otherPairRequest.credential;
  const joinedSecond = await call(paths, secondCredential, {
    op: 'join', name: 'other', harness: 'test', parent: null, allow: [], agentId: secondSoul,
  });
  assert.equal(joinedSecond.ok, true, JSON.stringify(joinedSecond));
  // Without this, the empty list after revocation would prove nothing.
  const beforeRevoke = await call(paths, secondCredential, { op: 'peers', agentId: secondSoul });
  assert.deepEqual(beforeRevoke.peers.map((peer) => peer.agentId).sort(), [accounts.alice, accounts.bob].sort());

  const watcher = watch(env, accounts.bob);
  try {
    await watcher.wait('watch ready event before revocation', (event) => event.event === 'ready');
    const revoked = await cli(['broker', 'revoke', os.userInfo().username]);
    assert.equal(revoked.json.watchesClosed, 1);
    await new Promise((resolve, reject) => {
      if (watcher.child.exitCode !== null || watcher.child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error('timed out waiting for revoked watch to close')), 3000);
      watcher.child.once('exit', (...args) => { clearTimeout(timer); resolve(args); });
    });
    const fromSecondAccount = await call(paths, secondCredential, { op: 'peers', agentId: secondSoul });
    assert.equal(fromSecondAccount.ok, true, JSON.stringify(fromSecondAccount));
    assert.deepEqual(fromSecondAccount.peers, []);
    assert.equal((await cli(['peers'], accounts.bob)).json.error.code, 'unauthenticated');
  } finally {
    watcher.child.kill();
  }
}, { brokerOptions: { uidOf: (account) => account === 'other' ? process.getuid() : account === os.userInfo().username ? process.getuid() : null } }));

test('single-account mode pairs, joins, sends, and wakes without a group', async () => {
  await withBroker(async ({ env, paths, broker, accounts }) => {
    // This fixture starts through the same Broker mode as `broker run --single-account`.
    assert.equal(statSync(paths.shared).mode & 0o777, 0o700);
    assert.equal(statSync(paths.proofs).mode & 0o777, 0o700);
    assert.equal(statSync(paths.socket).mode & 0o777, 0o600);
    assert.equal(broker.mode, 'single-account');
    const sender = accounts.alice;
    const recipient = accounts.bob;
    // Existing setup pairings already exercise CLI pair+approve+join. Send wakes
    // the recipient account's watch stream, which is the end-to-end wake path.
    const watcher = watch(env, recipient);
    await watcher.wait('ready event', (event) => event.event === 'ready');
    try {
      const { stdout } = await runCli(process.execPath, [new URL('../bin/agent-comms.mjs', import.meta.url).pathname,
        'send', recipient, '--body', 'wake me'], { env: { ...env, QWTS_AGENT_ID: sender } });
      const sent = JSON.parse(stdout);
      assert.equal(sent.wake, 'warm');
      await watcher.wait('message wake', (event) => event.event === 'message');
    } finally {
      watcher.child.kill('SIGTERM');
    }
  }, { brokerOptions: { mode: 'single-account' } });
});
