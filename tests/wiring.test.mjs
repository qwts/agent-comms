import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Broker } from '../lib/broker.mjs';
import { resolveParent } from '../lib/client.mjs';
import { watchInbox } from '../lib/worker/watch.mjs';
import { withBroker } from './helpers/broker.mjs';

const BIN = fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url));
const soul = () => `agent_${randomUUID()}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const result = await check();
    if (result) return result;
    assert.ok(Date.now() < deadline, 'timed out');
    await sleep(25);
  }
}

function launch(t, args, env) {
  const child = spawn(process.execPath, [BIN, ...args], { env });
  const events = [];
  let pending = '';
  let document = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      document += line;
      try {
        events.push(JSON.parse(document));
        document = '';
      } catch {
        // The CLI also prints ordinary JSON documents over several lines.
      }
    }
  });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  return { child, events, closed, stderr: () => stderr };
}

test('watch defaults to wake and full watch reconnects without replaying recent messages', async (t) => {
  await withBroker(async ({ env, paths, broker, accounts, cli }) => {
    const watching = launch(t, ['inbox', 'watch', '--full'], { ...env, QWTS_AGENT_ID: accounts.bob });
    const wake = launch(t, ['inbox', 'watch'], { ...env, QWTS_AGENT_ID: accounts.bob });
    await until(() => watching.events.length && wake.events.length);
    const first = await cli(['send', accounts.bob, '--body', 'first']);
    await until(() => watching.events.some((event) => event.message?.id === first.json.messageId));
    await until(() => wake.events.some((event) => event.event === 'wake'));
    assert.ok(!wake.events.some((event) => event.event === 'message'));
    wake.child.kill('SIGTERM');
    assert.deepEqual(await wake.closed, [0, null]);
    await broker.stop();
    await until(() => watching.events.some((event) => event.event === 'disconnected'));
    await sleep(900);
    assert.equal(watching.events.filter((event) => event.event === 'disconnected').length, 1);
    assert.deepEqual(watching.events.find((event) => event.event === 'disconnected'), {
      event: 'disconnected', code: 'broker-unreachable', retryInMs: 250,
    });
    const restarted = await new Broker({ paths }).start();
    try {
      await until(() => watching.events.filter((event) => event.event === 'ready').length === 2);
      const next = await cli(['send', accounts.bob, '--body', 'second']);
      await until(() => watching.events.some((event) => event.message?.id === next.json.messageId));
      assert.deepEqual(watching.events.filter((event) => event.event === 'message').map((event) => event.message.id),
        [first.json.messageId, next.json.messageId]);
      watching.child.kill('SIGTERM');
      assert.deepEqual(await watching.closed, [0, null], watching.stderr());
    } finally {
      await restarted.stop();
    }
  });
});

test('whoami reports the resolved soul, source, and broker verification', async () => {
  await withBroker(async ({ cli, accounts }) => {
    const result = await cli(['whoami'], accounts.alice);
    assert.equal(result.exit, 0, JSON.stringify(result.json));
    assert.equal(result.json.soul, accounts.alice);
    assert.equal(result.json.agentId, accounts.alice);
    assert.equal(result.json.source, 'env');
    assert.equal(result.json.verification, 'claimed');
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`watch exits during backoff on ${signal}`, async (t) => {
    await withBroker(async ({ env, broker, accounts }) => {
      await broker.stop();
      const watching = launch(t, ['inbox', 'watch'], { ...env, QWTS_AGENT_ID: accounts.bob });
      await until(() => watching.events.length);
      watching.child.kill(signal);
      assert.deepEqual(await watching.closed, [0, null]);
    });
  });
}

test('watch exits nonzero on a typed refusal', async () => {
  await withBroker(async ({ cli }) => {
    const result = await cli(['inbox', 'watch'], soul());
    assert.equal(result.exit, 1);
    assert.equal(result.json.error.code, 'not-joined');
  });
});

test('a worker watch sees the refusal as one JSON line and does not respawn', async () => {
  await withBroker(async ({ env }) => {
    const events = [];
    const failures = [];
    const watching = watchInbox({
      soul: soul(), env, onEvent: (event) => events.push(event), log: (...args) => failures.push(args.join(' ')),
    });
    assert.deepEqual(await watching.closed, { code: 1, signal: null });
    assert.deepEqual(failures, []);
    assert.equal(events.length, 1);
    assert.equal(events[0].error.code, 'not-joined');
  });
});

test('principal CLI stores a private credential and applies approvals, grants and revocation', async () => {
  await withBroker(async ({ root, cli, accounts }) => {
    const paired = await cli(['principal', 'pair', '--name', 'GeniusBar'], accounts.alice, { AGENT_COMMS_NO_KEYCHAIN: '1' });
    assert.equal(paired.exit, 0);
    assert.equal(paired.json.state, 'pending');
    assert.equal(paired.json.ok, true);
    const file = path.join(root, 'client', 'principal.json');
    const credential = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(credential.principal, paired.json.principal);
    assert.ok(!JSON.stringify(paired.json).includes(credential.secret));
    assert.equal((await cli(['census'])).json.error.code, 'not-approved');
    const listed = await cli(['admin', 'principals']);
    assert.equal(listed.json.principals[0].name, 'GeniusBar');
    const approved = await cli(['admin', 'principal-approve', paired.json.code, '--grant', accounts.bob]);
    assert.deepEqual(approved.json.grant, [accounts.bob]);
    assert.deepEqual((await cli(['census'])).json.souls.map((entry) => entry.agentId), [accounts.bob]);
    assert.equal((await cli(['health'])).json.pairings.principals, 1);
    assert.equal((await cli(['admin', 'principal-revoke', paired.json.principal])).json.state, 'revoked');
    assert.equal((await cli(['health'])).json.error.code, 'unauthenticated');
  });
});

// #83: a Homebrew CLI and a desktop host in one account share the client state
// directory but pair different principals under different credential names.
test('a principal paired under another credential name leaves the default principal untouched', async () => {
  await withBroker(async ({ root, cli, accounts }) => {
    const local = { AGENT_COMMS_NO_KEYCHAIN: '1' };
    const owner = await cli(['principal', 'pair', '--name', 'owner'], accounts.alice, local);
    assert.equal(owner.exit, 0);
    await cli(['admin', 'principal-approve', owner.json.code]);
    const file = path.join(root, 'client', 'principal.json');
    const before = readFileSync(file, 'utf8');

    // Another host's name has no principal yet: the CLI must not answer as the
    // default one, or a host probing "am I paired?" would never pair.
    const other = { ...local, AGENT_COMMS_CREDENTIAL_NAME: 'org.example.desktop' };
    const unpaired = await cli(['census'], accounts.alice, other);
    assert.notEqual(unpaired.exit, 0);
    assert.equal(unpaired.json.ok, false);

    const desktop = await cli(['principal', 'pair', '--name', 'desktop'], accounts.alice, other);
    assert.equal(desktop.exit, 0);
    assert.notEqual(desktop.json.principal, owner.json.principal);
    assert.equal(readFileSync(file, 'utf8'), before, 'the default principal file must be byte-for-byte unchanged');
    const own = path.join(root, 'client', 'principal.org.example.desktop.json');
    assert.equal(JSON.parse(readFileSync(own, 'utf8')).principal, desktop.json.principal);
    assert.equal(statSync(own).mode & 0o777, 0o600);

    // Each name answers as its own principal.
    assert.equal((await cli(['census'], accounts.alice, local)).exit, 0);
    assert.equal((await cli(['census'], accounts.alice, other)).json.error.code, 'not-approved');
    await cli(['admin', 'principal-approve', desktop.json.code]);
    assert.equal((await cli(['census'], accounts.alice, other)).exit, 0);
  });
});

test('join accepts an explicit parent and never reads agent-bot identity files', async () => {
  await withBroker(async ({ root, cli, accounts }) => {
    const identities = path.join(root, 'identities');
    mkdirSync(identities);
    const child = soul();
    const unjoined = soul();
    for (const id of [child, unjoined]) writeFileSync(path.join(identities, `${id}.json`), JSON.stringify({ parentId: accounts.alice }));
    const env = { AGENT_BOT_IDENTITIES_DIR: identities };
    assert.equal((await cli(['join', '--parent', accounts.alice], child, env)).exit, 0);
    const peers = (await cli(['peers'])).json.peers;
    assert.equal(peers.find((entry) => entry.agentId === child).parent, accounts.alice);
    const paired = await cli(['principal', 'pair'], accounts.alice, { AGENT_COMMS_NO_KEYCHAIN: '1' });
    assert.equal((await cli(['admin', 'principal-approve', paired.json.code])).json.grant, null);
    const census = (await cli(['census'])).json.souls;
    assert.equal(census.find((entry) => entry.agentId === child).parent, accounts.alice);
    assert.ok(!census.some((entry) => entry.agentId === unjoined));
    await cli(['join', '--parent', accounts.bob], child, env);
    assert.equal((await cli(['census'])).json.souls.find((entry) => entry.agentId === child).parent, accounts.bob);
    assert.equal(resolveParent({ ...env, QWTS_AGENT_ID: soul() }), null);
    writeFileSync(path.join(identities, `${child}.json`), 'broken');
    assert.equal(resolveParent({ ...env, QWTS_AGENT_ID: child }), null);
  });
});

test('worker CLI runs a fake harness, replies once, acknowledges and stops on SIGTERM', async (t) => {
  await withBroker(async ({ root, env, accounts, cli }) => {
    const bin = path.join(root, 'fake-bin');
    const workspace = path.join(root, 'workspace');
    mkdirSync(bin);
    mkdirSync(workspace);
    writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf('-o') + 1], 'CLI answer');
`, { mode: 0o755 });
    const workerSoul = soul();
    const metrics = path.join(root, 'metrics.jsonl');
    const config = path.join(root, 'tiers.json');
    writeFileSync(config, JSON.stringify({ tiers: { test: { model: 'fake', effort: 'low' } } }));
    const worker = launch(t, ['worker', 'run', '--harness', 'codex', '--workspace', workspace,
      '--model', 'override', '--effort', 'high', '--sandbox', 'read-only', '--turn-timeout', '5000',
      '--metrics', metrics, '--tier', 'test', '--config', config, '--name', 'cli-worker',
      '--parent', accounts.alice, '--allow', accounts.alice],
    { ...env, QWTS_AGENT_ID: workerSoul, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    await until(() => worker.events.length);
    const sent = await cli(['send', worker.events[0].address, '--body', 'hello']);
    const messages = await until(async () => {
      const messages = (await cli(['inbox', 'read'])).json.messages;
      return messages.some((entry) => entry.replyTo === sent.json.messageId) && messages;
    });
    assert.equal(messages.filter((entry) => entry.replyTo === sent.json.messageId).length, 1);
    assert.equal(messages.find((entry) => entry.replyTo === sent.json.messageId).body, 'CLI answer');
    await until(async () => (await cli(['inbox', 'read'], workerSoul)).json.messages.length === 0);
    worker.child.kill('SIGTERM');
    assert.deepEqual(await worker.closed, [0, null], worker.stderr());
    assert.equal(worker.events.length, 1);
    const rows = readFileSync(metrics, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, 'override');
    assert.equal(rows[0].effort, 'high');
    const peer = (await cli(['peers'])).json.peers.find((entry) => entry.agentId === workerSoul);
    assert.equal(peer.parent, accounts.alice);
  });
});
