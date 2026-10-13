import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Broker } from '../lib/broker.mjs';
import { brokerPaths } from '../lib/paths.mjs';
import { checkBrokerCustody } from '../lib/client.mjs';
import { withBroker } from './helpers/broker.mjs';

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

test('an unbound caller fails with unbound', async () => withBroker(async ({ env, root }) => {
  const unbound = { ...env };
  delete unbound.QWTS_AGENT_ID;
  const { execFile } = await import('node:child_process');
  const result = await new Promise((resolve) => execFile(process.execPath, [fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url)), 'peers'], { env: unbound, cwd: root }, (error, stdout) => resolve({ exit: error?.code ?? 0, json: JSON.parse(stdout) })));
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
