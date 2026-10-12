import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { admin, call, callPrincipal, stream, watch } from '../lib/client.mjs';
import { createDiagnosticSink } from '../lib/diagnostics.mjs';

const SECRET = 'CANARY-client-secret';
const BODY = 'CANARY-client-body-prompts-tools';
const PEER_ID = 'deadbeefdeadbeefdeadbeefdeadbeef';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function capture(t, mode = 'capture') {
  const output = new EventEmitter();
  const lines = [];
  output.write = (line, complete) => {
    lines.push(line);
    if (mode === 'throwing') throw new Error(SECRET);
    if (mode === 'blocked') return false;
    complete(); return true;
  };
  t.after(() => output.emit('close'));
  const sink = createDiagnosticSink(output);
  return { sink, lines, diagnostic: sink.report };
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-client-private-path-'));
  const shared = path.join(root, 'shared');
  mkdirSync(shared, { mode: 0o755 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { paths: { shared, socket: path.join(shared, 'broker.sock'), admin: path.join(root, 'admin.sock') },
    credential: { account: SECRET, principal: SECRET, secret: SECRET, brokerUid: process.getuid?.() }, root };
}

async function serve(t, file, handler) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    handler(socket);
  });
  server.listen(file);
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
}

async function records(output, root) {
  for (let i = 0; i < 100 && (output.sink.stats().queued || output.sink.stats().inFlight); i += 1) await tick();
  const text = output.lines.join('');
  for (const canary of [SECRET, BODY, PEER_ID, root]) if (canary) assert.ok(!text.includes(canary), `diagnostic leaked canary ${canary}`);
  return output.lines.map(JSON.parse);
}

test('local custody refusal stays synchronous with safe client attribution on every platform', async (t) => {
  const output = capture(t);
  const paths = { shared: BODY, socket: BODY, state: BODY };
  const credential = { account: SECRET, secret: SECRET, brokerUid: SECRET };
  assert.throws(() => call(paths, credential, { op: 'read', body: BODY }, { diagnostic: output.diagnostic }), { code: 'broker-untrusted' });
  const result = await records(output);
  assert.equal(result.length, 1);
  assert.deepEqual([result[0].component, result[0].event, result[0].stage, result[0].outcome],
    ['agent-comms-client', 'transport.untrusted', 'custody', 'refused']);
  assert.ok(Number.isSafeInteger(result[0].durationMs));
});

for (const mode of ['capture', 'blocked', 'throwing']) {
  test(`real local client outcomes survive ${mode} diagnostics without capturing payload or peer context`, { skip: process.platform === 'win32' }, async (t) => {
    const output = capture(t, mode);
    const { paths, credential, root } = fixture(t);
    let response = { ok: true, result: 'canonical-success' };
    await serve(t, paths.socket, (socket) => socket.once('data', () => response === null ? socket.destroy() : socket.write(`${JSON.stringify(response)}\n`)));
    const options = { diagnostic: output.diagnostic, timeoutMs: 40 };
    const request = { op: 'read', body: BODY, traceId: PEER_ID, operationId: PEER_ID };
    assert.deepEqual(await call(paths, credential, request, options), response);
    response = { ok: false, error: { code: 'unauthenticated', message: SECRET, details: { body: BODY, traceId: PEER_ID } } };
    await assert.rejects(call(paths, credential, request, options), { code: 'unauthenticated', message: SECRET });
    response.error.code = 'broker-timeout';
    await assert.rejects(callPrincipal(paths, credential, request, options), { code: 'broker-timeout' });
    assert.equal(output.lines.length, 0, 'remote reply codes must not masquerade as local deadline observations');
    response = { ok: true };
    const controller = new AbortController();
    const watching = stream(paths, credential, request, () => {}, { signal: controller.signal, diagnostic: output.diagnostic });
    controller.abort();
    await watching;
    assert.equal(output.lines.length, 0, 'explicit cancellation is not a transport failure');

    await serve(t, paths.admin, (socket) => socket.on('data', () => {}));
    await assert.rejects(admin(paths, request, options), { code: 'broker-timeout' });
    await tick();
    response = null;
    await assert.rejects(call(paths, credential, request, options), { code: 'broker-unreachable' });
    // An occupied non-socket path must retain the custody refusal.
    const stale = path.join(paths.shared, 'stale.sock');
    writeFileSync(stale, '');
    assert.throws(() => call({ ...paths, socket: stale }, credential, request, options), { code: 'broker-untrusted' });
    rmSync(stale);
    assert.throws(() => call({ ...paths, socket: path.join(paths.shared, 'missing.sock') }, credential, request, options), { code: 'broker-unreachable' });
    if (mode === 'capture') {
      const result = await records(output, root);
      assert.deepEqual(result.map((r) => [r.event, r.stage]), [
        ['transport.timeout', 'deadline'], ['transport.unreachable', 'connect'], ['transport.untrusted', 'custody'], ['transport.unreachable', 'connect'],
      ]);
      assert.ok(result.every((r) => Number.isSafeInteger(r.durationMs) && r.durationMs >= 0));
      assert.ok(result.every((r) => !Object.hasOwn(r, 'context') && !Object.hasOwn(r, 'links')));
    }
  });
}

test('watch retry records scheduling only, preserves backoff/cancellation, and refuses remote failures without retry', { skip: process.platform === 'win32' }, async (t) => {
  const output = capture(t);
  const { paths, credential, root } = fixture(t);
  let attempts = 0;
  let refuse = false;
  await serve(t, paths.socket, (socket) => {
    attempts += 1;
    if (refuse) socket.once('data', () => socket.write(`${JSON.stringify({ ok: false, error: { code: 'unauthenticated', message: SECRET } })}\n`));
    else socket.destroy();
  });
  const controller = new AbortController();
  const events = [];
  const started = performance.now();
  const watching = watch(paths, credential, { op: 'watch', body: BODY, traceId: PEER_ID }, (event) => events.push(event), {
    signal: controller.signal,
    diagnostic: (...args) => {
      output.diagnostic(...args);
      if (args[0] === 'transport-retry' && args[2] === 2) controller.abort();
    },
  });
  await watching;
  assert.equal(attempts, 2);
  assert.ok(performance.now() - started >= 240, 'the existing first backoff must still occur');
  assert.deepEqual(events, [{ event: 'disconnected', code: 'broker-unreachable', retryInMs: 250 }]);
  const result = await records(output, root);
  const retries = result.filter((r) => r.event === 'transport.retry');
  assert.deepEqual(retries.map((r) => r.details), [{ attempt: 1, delayMs: 250 }, { attempt: 2, delayMs: 500 }]);
  assert.ok(retries.every((r) => r.outcome === 'succeeded' && r.durationMs === undefined));
  const cancelledReports = [];
  const throwing = (event) => { cancelledReports.push(event); throw new Error(SECRET); };
  const cancelled = new AbortController();
  await watch(paths, credential, { op: 'watch' }, () => cancelled.abort(), { signal: cancelled.signal, diagnostic: throwing });
  assert.deepEqual(cancelledReports, ['transport-unreachable'], 'cancellation in disconnected callback must prevent retry scheduling evidence');
  refuse = true;
  const before = attempts;
  await assert.rejects(watch(paths, credential, { op: 'watch' }, () => assert.fail('refusal must not become a watch event'), { diagnostic: throwing }), { code: 'unauthenticated' });
  assert.equal(attempts, before + 1);
});
