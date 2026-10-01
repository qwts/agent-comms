import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { admin, call, stream } from '../lib/client.mjs';
import { CommsError } from '../lib/errors.mjs';

const BIN = fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-cli-'));
  const shared = path.join(root, 'shared');
  const client = path.join(root, 'client');
  mkdirSync(shared, { mode: 0o755 });
  mkdirSync(client, { mode: 0o700 });
  const credential = { account: 'test', secret: 'secret', brokerUid: process.getuid() };
  writeFileSync(path.join(client, 'credential.json'), JSON.stringify(credential), { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    paths: { shared, socket: path.join(shared, 'broker.sock'), admin: path.join(root, 'admin.sock') },
    credential,
    env: { ...process.env, AGENT_COMMS_SHARED_DIR: shared, AGENT_COMMS_BROKER_STATE_DIR: root,
      AGENT_COMMS_CLIENT_STATE_DIR: client, QWTS_AGENT_ID: 'test-agent' },
  };
}

async function serve(t, file, handle) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handle(socket);
  });
  server.listen(file);
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
}

function cli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env }, (error, stdout, stderr) => {
      resolve({ exit: error?.code ?? 0, stdout, stderr });
    });
  });
}

for (const args of [
  ['peers', '--bogus'], ['peers', '--body', 'no'], ['inbox', 'watch', '--limit', '1'],
  ['broker', 'approve'], ['broker', 'revoke'], ['skill', 'show'],
  ['send'], ['inbox', 'ack'], ['leave', 'extra'], ['broker', 'approve', 'one', 'two'],
  ['join', '--name'], ['join', '--name', '--harness', 'test'], ['peers', '-x'],
  ['send', 'user/agent_x', '--body', 'hi', '--group', 'staff'], ['broker', 'run', '--body', 'x'],
]) {
  test(`${args.join(' ')} fails with usage before connecting`, async (t) => {
    // Missing sockets would report broker-unreachable if validation reached transport.
    const { env } = fixture(t);
    const result = await cli(args, env);
    assert.equal(result.exit, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, 'usage');
  });
}

for (const args of [['--version'], ['join', '--version'], ['inbox', 'read', '--version']]) {
  test(`${args.join(' ')} prints the version without validating the command`, async (t) => {
    const { env } = fixture(t);
    const result = await cli(args, env);
    assert.equal(result.exit, 0, result.stderr);
    assert.match(result.stdout, /^agent-comms \d+\.\d+\.\d+\n$/);
  });
}

for (const transport of ['call', 'admin']) {
  test(`${transport} deadlines reject with broker-timeout and close a trickling socket`, async (t) => {
    const { paths, credential } = fixture(t);
    // Under load the client deadline can fire before the server has run its
    // connection handler, so wait for the server side rather than assume it.
    let closedByClient;
    const closed = new Promise((resolve) => { closedByClient = resolve; });
    await serve(t, transport === 'call' ? paths.socket : paths.admin, (socket) => {
      // The trickle keeps writing until the client hangs up, so EPIPE is expected.
      socket.on('error', () => {});
      socket.on('close', closedByClient);
      socket.on('data', () => {});
      const timer = setInterval(() => socket.write(' '), 5);
      socket.on('close', () => clearInterval(timer));
    });
    const options = { timeoutMs: 100 };
    const request = transport === 'call'
      ? call(paths, credential, { op: 'peers' }, options)
      : admin(paths, { op: 'pairings' }, options);
    await assert.rejects(request, (error) => error instanceof CommsError && error.code === 'broker-timeout');
    await closed;
  });
}

test('the default request deadline is bounded', async (t) => {
  const { paths } = fixture(t);
  let connected;
  const accepted = new Promise((resolve) => { connected = resolve; });
  await serve(t, paths.admin, (socket) => {
    socket.on('data', () => {});
    connected();
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(admin(paths, { op: 'pairings' }), { code: 'broker-timeout' });
  await accepted;
  t.mock.timers.tick(10_000);
  await rejected;
});

test('a successful response closes even when the broker keeps its side open', async (t) => {
  const { paths } = fixture(t);
  let closed;
  await serve(t, paths.admin, (socket) => {
    closed = once(socket, 'close');
    socket.once('data', () => socket.write('{"ok":true}\n'));
  });
  assert.deepEqual(await admin(paths, { op: 'pairings' }), { ok: true });
  await closed;
});

test('a stream can be cancelled after its acknowledgement', async (t) => {
  const { paths, credential } = fixture(t);
  const controller = new AbortController();
  let closed;
  await serve(t, paths.socket, (socket) => {
    closed = once(socket, 'close');
    socket.once('data', () => socket.write('{"ok":true}\n{"event":"ready"}\n'));
  });
  await stream(paths, credential, { op: 'watch' }, () => controller.abort(), { signal: controller.signal });
  await closed;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`inbox watch closes cleanly on ${signal}`, async (t) => {
    const { paths, env } = fixture(t);
    let closed;
    await serve(t, paths.socket, (socket) => {
      closed = once(socket, 'close');
      socket.once('data', () => socket.write('{"event":"ready"}\n'));
    });
    const child = spawn(process.execPath, [BIN, 'inbox', 'watch'], { env });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await once(child.stdout, 'data');
    child.kill(signal);
    assert.deepEqual(await exited, [0, null], stderr);
    assert.equal(stderr, '');
    await closed;
  });
}
