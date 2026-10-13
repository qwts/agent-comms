import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url)), 'inbox', 'watch', '--full'], {
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

test('a second broker refuses to take over a live socket', async () => withBroker(async ({ cli, paths }) => {
  await assert.rejects(new Broker({ paths }).start(), (error) => error.code === 'broker-running');
  assert.equal((await cli(['peers'])).exit, 0);
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
      const { stdout } = await runCli(process.execPath, [fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url)),
        'send', recipient, '--body', 'wake me'], { env: { ...env, QWTS_AGENT_ID: sender } });
      const sent = JSON.parse(stdout);
      assert.equal(sent.wake, 'warm');
      await watcher.wait('message wake', (event) => event.event === 'message');
    } finally {
      watcher.child.kill('SIGTERM');
    }
  }, { brokerOptions: { mode: 'single-account' } });
});

test('a lock left by an earlier boot does not keep the broker down', async () => {
  const { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync } = await import('node:fs');
  const { prepare, stop } = await import('../lib/platform/local-channel.mjs');
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ac-lock-')));
  try {
    const broker = { mode: 'single-account', servers: [], connections: new Set(), watchers: new Map(), accountWatchers: new Map(),
      paths: { shared: path.join(root, 'shared'), proofs: path.join(root, 'shared', 'proofs'), state: path.join(root, 'state') } };
    mkdirSync(broker.paths.state, { recursive: true, mode: 0o700 });
    const lock = path.join(broker.paths.state, 'broker.lock');
    // A live process of ours that is not a broker, as after pid reuse.
    writeFileSync(lock, String(process.ppid));
    assert.throws(() => prepare(broker), (error) => error.code === 'broker-running');
    utimesSync(lock, new Date('2001-01-01'), new Date('2001-01-01'));
    prepare(broker);
    assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
    await stop(broker);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
