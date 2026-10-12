import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { admin, call } from '../lib/client.mjs';
import { writeDiagnosticLine } from '../lib/diagnostic-fd.mjs';
import { brokerPaths } from '../lib/paths.mjs';
import { pairAccount } from './helpers/broker.mjs';

const moduleUrl = (file) => JSON.stringify(new URL(`../lib/${file}`, import.meta.url).href);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function copiedTransport(root) {
  mkdirSync(path.join(root, 'platform'));
  const transport = path.join(root, 'platform', 'diagnostic-stderr.mjs');
  copyFileSync(new URL('../lib/platform/diagnostic-stderr.mjs', import.meta.url), transport);
  return transport;
}

test('fd transport acknowledges only a complete line after bounded partial progress', async () => {
  const line = '{"event":"safe","value":"☃"}\n';
  const expected = Buffer.from(line);
  const chunks = [];
  let active = false;
  let writes = 0;
  await new Promise((resolve) => writeDiagnosticLine(line, (fd, bytes, offset, length, position, callback) => {
    assert.equal(fd, 2);
    assert.equal(active, false, 'only one fd write may be outstanding');
    active = true;
    writes += 1;
    const count = Math.min(3, length);
    chunks.push(bytes.subarray(offset, offset + count));
    setImmediate(() => { active = false; callback(null, count); });
  }, (ok) => {
    assert.equal(ok, true);
    assert.equal(active, false);
    assert.deepEqual(Buffer.concat(chunks), expected, 'no partial prefix may be acknowledged as a complete event');
    resolve();
  }));
  assert.ok(writes > 1 && writes <= expected.length);
});

test('fd transport contains throws, errors and zero/invalid progress without retries or arbitrary serialization', () => {
  const error = new Error('CANARY-secret /Users/private-canary/body');
  error.toJSON = () => assert.fail('must not serialize fd errors');
  for (const result of ['throw', error, 0, -1, Infinity, 1000]) {
    let writes = 0;
    const outcomes = [];
    writeDiagnosticLine('safe\n', (fd, bytes, offset, length, position, callback) => {
      writes += 1;
      if (result === 'throw') throw error;
      if (result === error) callback(error);
      else callback(null, result);
    }, (ok) => outcomes.push(ok));
    assert.equal(writes, 1);
    assert.deepEqual(outcomes, [false]);
  }
  for (const line of ['', '☃'.repeat(171), null]) {
    const outcomes = [];
    writeDiagnosticLine(line, () => assert.fail('invalid/oversized event reached fd'), (ok) => outcomes.push(ok));
    assert.deepEqual(outcomes, [false]);
  }
});

test('helper does not inherit NODE_OPTIONS or a secret-bearing environment', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-diagnostic-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const preload = path.join(root, 'canary.cjs');
  writeFileSync(preload, 'process.stderr.write("CANARY-secret-preload\\n");');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createDiagnosticSink } from ${moduleUrl('diagnostics.mjs')};
    process.env.NODE_OPTIONS = '--require ' + ${JSON.stringify(preload)};
    process.env.DIAGNOSTIC_SECRET_CANARY = 'CANARY-secret-preload';
    const sink = createDiagnosticSink(); sink.report('request-internal');
    for (let i = 0; i < 200 && !sink.stats().written; i++) await new Promise(resolve => setTimeout(resolve, 10));
    if (sink.stats().written !== 1) process.exitCode = 1;
  `], { timeout: 3000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).event, 'broker.request-failure');
  assert.ok(!result.stderr.includes('CANARY'));
});

test('missing and syntax-broken helper startup stay silent, disable diagnostics and never restart', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-private-path-canary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transport = copiedTransport(root);
  for (const broken of ['missing', 'syntax']) {
    if (broken === 'syntax') writeFileSync(path.join(root, 'diagnostic-writer.mjs'), 'this is invalid javascript !');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createDiagnosticStderr } from ${JSON.stringify(pathToFileURL(transport).href)};
    import { createDiagnosticSink } from ${moduleUrl('diagnostics.mjs')};
    const stream = createDiagnosticStderr(); const sink = createDiagnosticSink(stream);
    sink.report('request-internal');
    for (let i = 0; i < 200 && !sink.stats().disabled; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const pid = stream.pid;
    for (let i = 0; i < 1000; i++) sink.report('storage-append');
    if (!sink.stats().disabled || stream.pid !== pid || sink.stats().dropped !== 1001) process.exitCode = 1;
  `], { timeout: 3000, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '', 'Node loader errors must not disclose module paths');
  }
});

test('helper environment excludes caller credentials as well as preload hooks', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-diagnostic-secret-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transport = copiedTransport(root);
  writeFileSync(path.join(root, 'diagnostic-writer.mjs'), `
    if (process.env.DIAGNOSTIC_SECRET_CANARY || process.env.NODE_OPTIONS) process.stderr.write('CANARY-credential-leak');
    process.on('disconnect', () => process.exit(0));
    process.on('message', () => process.send({ ok: true }));
  `);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createDiagnosticStderr } from ${JSON.stringify(pathToFileURL(transport).href)};
    import { createDiagnosticSink } from ${moduleUrl('diagnostics.mjs')};
    process.env.DIAGNOSTIC_SECRET_CANARY = 'CANARY-credential-leak';
    const sink = createDiagnosticSink(createDiagnosticStderr()); sink.report('request-internal');
    for (let i = 0; i < 200 && !sink.stats().written; i++) await new Promise(resolve => setTimeout(resolve, 10));
    if (sink.stats().written !== 1) process.exitCode = 1;
  `], { timeout: 3000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('natural parent exit kills an unacknowledging helper on every supported platform', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-diagnostic-stalled-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const transport = copiedTransport(root);
  writeFileSync(path.join(root, 'diagnostic-writer.mjs'), `
    process.on('message', () => {});
    process.on('disconnect', () => process.exit(0));
    setInterval(() => {}, 1000);
  `);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createDiagnosticStderr } from ${JSON.stringify(pathToFileURL(transport).href)};
    import { createDiagnosticSink } from ${moduleUrl('diagnostics.mjs')};
    const stream = createDiagnosticStderr(); const sink = createDiagnosticSink(stream);
    sink.report('request-internal');
    await new Promise(resolve => setTimeout(resolve, 200));
    for (let i = 0; i < 10000; i++) sink.report('storage-append');
    process.stdout.write(JSON.stringify({ helper: stream.pid, ...sink.stats() }) + '\\n');
  `], { timeout: 3000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const stats = JSON.parse(result.stdout);
  assert.ok(stats.helper);
  t.after(() => { try { process.kill(stats.helper, 'SIGKILL'); } catch {} });
  assert.equal(stats.inFlight, 1);
  assert.equal(stats.queued, 64);
  assert.equal(stats.dropped, 10000 - 64);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(stats.helper, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(10);
  }
  assert.fail('unacknowledging helper survived natural parent exit');
});

function send(child, command) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error(`child command ${command} timed out`)); }, 3000);
    const receive = (message) => {
      if (message.command !== command) return;
      clearTimeout(timer); child.off('message', receive); resolve(message);
    };
    child.on('message', receive);
    child.send({ command });
  });
}

for (const mode of ['unread-stderr', 'stopped-helper', 'killed-helper']) {
  test(`spawned broker delivers and exits naturally with ${mode} and leaves no helper`, { skip: process.platform === 'win32' }, async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ac-diagnostic-broker-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = { ...process.env, AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'), AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker') };
    const paths = brokerPaths(env);
    const source = `
      import { Broker } from ${moduleUrl('broker.mjs')};
      import { brokerPaths } from ${moduleUrl('paths.mjs')};
      import { createDiagnosticSink } from ${moduleUrl('diagnostics.mjs')};
      import { createDiagnosticStderr } from ${moduleUrl('platform/diagnostic-stderr.mjs')};
      const stream = createDiagnosticStderr(); const sink = createDiagnosticSink(stream);
      const broker = await new Broker({ paths: brokerPaths(), mode: 'single-account', now: () => 1000, diagnostic: sink.report }).start();
      let flood;
      process.on('message', async ({ command }) => {
        if (command === 'flood') {
          flood = setInterval(() => { for (let i = 0; i < 100; i++) broker.reportDiagnostic('request-internal'); }, 1);
        }
        if (command === 'stats' || command === 'flood') process.send({ command, ...sink.stats(), helper: stream.pid });
        if (command === 'stop') {
          clearInterval(flood); await broker.stop();
          process.send({ command, helper: stream.pid }, () => process.disconnect());
        }
      });
      process.send({ command: 'ready' });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    // Deliberately never read/resume the stderr pipe. A data listener or
    // communicate() here would invalidate the saturation acceptance test.
    let helper;
    t.after(() => { child.kill('SIGKILL'); if (helper) { try { process.kill(helper, 'SIGKILL'); } catch {} } });
    const exited = once(child, 'exit');
    await Promise.race([once(child, 'message'), delay(3000).then(() => { throw new Error('broker startup timed out'); })]);
    const paired = await pairAccount(paths, os.userInfo().username, process.getuid());
    await admin(paths, { op: 'approve', code: paired.code }, { timeoutMs: 1000 });
    const alice = `agent_${randomUUID()}`, bob = `agent_${randomUUID()}`;
    const request = (body, credential = paired.credential) => call(paths, credential, body, { timeoutMs: 1000 });
    for (const agentId of [alice, bob]) await request({ op: 'join', agentId });
    await send(child, 'flood');
    let stats;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(10); stats = await send(child, 'stats');
      if (stats.helper && stats.written > 0) break;
    }
    helper = stats.helper;
    assert.ok(helper && stats.written > 0, 'the actual production helper must have started and written');
    if (mode === 'stopped-helper') process.kill(helper, 'SIGSTOP');
    if (mode === 'killed-helper') {
      process.kill(helper, 'SIGKILL');
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await delay(10); stats = await send(child, 'stats');
        if (stats.disabled) break;
      }
      assert.equal(stats.disabled, true, 'actual helper exit must disable the sink');
      let gone = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { process.kill(helper, 0); } catch (error) { if (error.code === 'ESRCH') { gone = true; break; } throw error; }
        await delay(10);
      }
      assert.equal(gone, true, 'killed helper must actually disappear before delivery');
    }
    let previous = stats.written;
    let stalledChecks = 0;
    // The production rate cap is 100 events/s. Allow a finite ten-second
    // fill window so the test still proves an actually blocked destination,
    // rather than disabling the cap or mistaking rate drops for backpressure.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      await delay(20); stats = await send(child, 'stats');
      stalledChecks = stats.inFlight && stats.queued === 64 && stats.written === previous ? stalledChecks + 1 : 0;
      if (stats.disabled || stalledChecks >= 5) break;
      previous = stats.written;
    }
    assert.ok(stats.disabled || stalledChecks >= 5, 'stderr or the isolated helper must actually be saturated/stalled');
    assert.ok(stats.dropped > 0);
    assert.ok(stats.queuedBytes <= 32 * 1024 && stats.inFlightBytes <= 512);
    const sent = await request({ op: 'send', agentId: alice, to: bob, body: 'delivery survives diagnostic backpressure', key: mode });
    const page = await request({ op: 'read', agentId: bob });
    assert.equal(page.messages[0].id, sent.messageId);
    await request({ op: 'ack', agentId: bob, ids: [sent.messageId] });
    if (mode === 'killed-helper') {
      assert.deepEqual((await request({ op: 'read', agentId: bob })).messages, []);
      const after = await send(child, 'stats');
      assert.equal(after.disabled, true); assert.equal(after.helper, helper, 'no replacement helper');
      assert.equal(after.written, stats.written); assert.ok(after.dropped > stats.dropped);
      assert.equal(after.queued, 0); assert.equal(after.inFlight, 0);
      assert.throws(() => process.kill(helper, 0), { code: 'ESRCH' });
    }
    await assert.rejects(request({ op: 'read', agentId: bob }, { ...paired.credential, secret: 'CANARY-secret' }), { code: 'unauthenticated' });
    await send(child, 'stop');
    const result = await Promise.race([exited, delay(3000).then(() => { throw new Error('natural broker exit timed out'); })]);
    assert.deepEqual(result, [0, null], 'no explicit process.exit should be needed by the embedded broker');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { process.kill(helper, 0); } catch (error) { if (error.code === 'ESRCH') { helper = null; break; } throw error; }
      await delay(10);
    }
    assert.equal(helper, null, 'a blocked/stopped helper must not survive its parent');
  });
}
