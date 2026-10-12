import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { createDiagnosticSink, DIAGNOSTIC_LIMITS } from '../lib/diagnostics.mjs';
import { loadCredential } from '../lib/client.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { EventLog } from '../lib/state.mjs';
import { call, withBroker } from './helpers/broker.mjs';

const SECRET = 'CANARY-bearer-secret-9124';
const PRIVATE_PATH = '/Users/private-canary/account/transcript.jsonl';
const BODY = 'CANARY-message-body-prompts-tool-inputs';
const CANARIES = [SECRET, PRIVATE_PATH, BODY];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function sensitiveError() {
  const error = new Error(CANARIES.join(' '), { cause: new Error(SECRET) });
  Object.assign(error, { code: SECRET, request: { body: BODY, auth: SECRET }, path: PRIVATE_PATH });
  error.toJSON = () => { throw new Error('Error serialization must never run'); };
  return error;
}

class ControlledStream extends EventEmitter {
  lines = [];
  callbacks = [];
  accepted = true;
  write(line, callback) {
    this.lines.push(line);
    this.callbacks.push(callback);
    return this.accepted;
  }
  complete(error) { this.callbacks.shift()(error); }
}

function capture() {
  const lines = [];
  const stream = new Writable({ write(chunk, encoding, callback) { lines.push(chunk.toString()); callback(); } });
  return { stream, lines, sink: createDiagnosticSink(stream) };
}

async function flushed(sink) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await tick();
    if (!sink.stats().queued && !sink.stats().inFlight) return;
  }
  assert.fail('diagnostics did not flush within the bounded test window');
}

function safeLines(lines) {
  const text = lines.join('');
  for (const canary of CANARIES) assert.ok(!text.includes(canary), `diagnostics leaked ${canary}`);
  const records = lines.map((line) => {
    assert.ok(line.endsWith('\n'));
    assert.ok(Buffer.byteLength(line) <= DIAGNOSTIC_LIMITS.eventBytes);
    const record = JSON.parse(line);
    assert.deepEqual(Object.keys(record).sort(), ['v', 'buildVersion', 'buildSource', 'code', 'component', 'event', 'eventId',
      'sessionId', 'operation', 'outcome', 'stage', 'observedAtUnixMs',
      ...(record.durationMs === undefined ? [] : ['durationMs']),
      ...(['diagnostics.dropped', 'mailbox.read', 'mailbox.acked'].includes(record.event) ? ['details'] : [])].sort());
    if (record.event === 'mailbox.read') assert.deepEqual(record.details, { returnedCount: 1, remainingCount: 0 });
    if (record.event === 'mailbox.acked') assert.deepEqual(record.details, { acknowledgedCount: 1, alreadyAcknowledgedCount: 0 });
    assert.equal(record.v, 1);
    assert.equal(record.buildSource, 'running');
    assert.equal(record.component, 'agent-comms-broker');
    assert.match(record.eventId, /^[a-f0-9-]{36}$/);
    assert.equal(record.buildVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    return record;
  });
  assert.equal(new Set(records.map((record) => record.eventId)).size, records.length);
  return records;
}

test('only fixed event tokens become diagnostics; arbitrary objects are never inspected or serialized', async (t) => {
  const { stream, sink, lines } = capture();
  t.after(() => stream.destroy());
  const hostile = new Proxy({}, { get() { assert.fail('diagnostics inspected arbitrary input'); } });
  for (const value of [sensitiveError(), hostile, SECRET, 'toString', '__proto__', 'diagnostics-dropped', null, 42]) sink.report(value);
  sink.report('request-internal', { error: sensitiveError(), request: hostile });
  sink.report('request-internal', 123);
  assert.equal(lines.length, 0, 'request-side reporting must defer the actual stderr write');
  await flushed(sink);
  assert.deepEqual(safeLines(lines).map(({ event, code, stage, outcome }) => ({ event, code, stage, outcome })), [
    { event: 'diagnostics.dropped', code: 'diagnostics-dropped', stage: 'queue', outcome: 'dropped' },
    { event: 'broker.request-failure', code: 'internal', stage: 'handler', outcome: 'failed' },
  ]);
});

test('blocked stderr has one in-flight event, finite pending bytes/count and explicit recovered drop accounting', async () => {
  const stream = new ControlledStream();
  stream.accepted = false;
  let clock = 0;
  const sink = createDiagnosticSink(stream, { clock: () => { clock += 10; return clock; } });
  sink.report('request-internal');
  await tick();
  for (let index = 0; index < 10_000; index += 1) sink.report('storage-append');
  const blocked = sink.stats();
  assert.equal(blocked.inFlight, 1);
  assert.equal(blocked.queued, DIAGNOSTIC_LIMITS.events);
  assert.equal(blocked.dropped, 10_000 - DIAGNOSTIC_LIMITS.events);
  assert.ok(blocked.queuedBytes <= DIAGNOSTIC_LIMITS.bytes);
  assert.ok(blocked.inFlightBytes <= DIAGNOSTIC_LIMITS.eventBytes);
  await tick();
  assert.equal(stream.lines.length, 1);
  stream.complete();
  await tick();
  assert.equal(stream.lines.length, 1, 'write callback alone must not bypass backpressure');
  stream.accepted = true;
  stream.emit('drain');
  for (let attempt = 0; attempt < DIAGNOSTIC_LIMITS.events + 3; attempt += 1) {
    await tick();
    if (stream.callbacks.length) stream.complete();
  }
  assert.equal(sink.stats().queued, 0);
  assert.equal(sink.stats().inFlight, 0);
  assert.equal(sink.stats().written, DIAGNOSTIC_LIMITS.events + 1);
  const records = safeLines(stream.lines);
  assert.deepEqual(records.filter((record) => record.event === 'diagnostics.dropped').map((record) => record.details.droppedCount), [blocked.dropped]);
  stream.emit('close');
  assert.equal(stream.listenerCount('error'), 0);
  assert.equal(stream.listenerCount('drain'), 0);
});

test('drain alone cannot create concurrent writes before the previous write callback', async () => {
  const stream = new ControlledStream();
  stream.accepted = false;
  const sink = createDiagnosticSink(stream);
  sink.report('request-internal'); sink.report('storage-append');
  await tick();
  stream.emit('drain');
  await tick();
  assert.equal(stream.lines.length, 1);
  stream.accepted = true;
  stream.complete();
  await tick();
  assert.equal(stream.lines.length, 2);
  stream.complete();
  stream.emit('close');
});

test('synchronous and asynchronous stream failures discard finite work and contain later stream errors', async () => {
  for (const mode of ['throw', 'callback', 'event', 'close']) {
    const stream = mode === 'callback'
      ? new Writable({ write(chunk, encoding, callback) { callback(sensitiveError()); } })
      : new ControlledStream();
    if (mode === 'throw') stream.write = () => { throw sensitiveError(); };
    const sink = createDiagnosticSink(stream);
    sink.report('request-internal'); sink.report('storage-append');
    await tick();
    if (mode === 'event') stream.emit('error', sensitiveError());
    if (mode === 'close') stream.emit('close');
    await tick();
    assert.equal(sink.stats().disabled, true, mode);
    assert.equal(sink.stats().queued, 0, mode);
    assert.equal(sink.stats().inFlight, 0, mode);
    assert.equal(sink.stats().dropped, 2, mode);
    sink.report('request-internal');
    assert.equal(sink.stats().dropped, 3, mode);
    if (stream.listenerCount('error')) assert.doesNotThrow(() => stream.emit('error', sensitiveError()));
    if (mode !== 'close') stream.emit('close');
    assert.equal(stream.listenerCount('error'), 0, mode);
    assert.equal(stream.listenerCount('drain'), 0, mode);
  }
});

test('a blocked diagnostic pump never keeps a standalone process alive', () => {
  const module = new URL('../lib/diagnostics.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { EventEmitter } from 'node:events';
    import { createDiagnosticSink } from ${JSON.stringify(module)};
    const stream = new EventEmitter();
    stream.write = () => false;
    const sink = createDiagnosticSink(stream);
    sink.report('request-internal');
    setImmediate(() => { for (let i = 0; i < 1000; i++) sink.report('storage-append'); });
  `], { timeout: 3000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('default diagnostics write JSONL to stderr while preserving stdout', () => {
  const module = new URL('../lib/diagnostics.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createDiagnosticSink } from ${JSON.stringify(module)};
    process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
    const sink = createDiagnosticSink();
    sink.report('request-internal');
    for (let i = 0; i < 200 && !sink.stats().written; i++) await new Promise(resolve => setTimeout(resolve, 10));
    if (sink.stats().written !== 1) process.exitCode = 1;
  `], { timeout: 3000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"ok":true}\n');
  assert.equal(safeLines([result.stderr])[0].event, 'broker.request-failure');
});

for (const mode of ['capture', 'blocked', 'throwing', 'callback-error']) {
  test(`real broker outcomes and durable state survive a ${mode} diagnostic sink`, async (t) => {
    const output = capture();
    t.after(() => output.stream.destroy());
    let stream;
    let sink = output.sink;
    if (mode === 'blocked') { stream = new ControlledStream(); stream.accepted = false; sink = createDiagnosticSink(stream); }
    if (mode === 'callback-error') {
      stream = new Writable({ write(chunk, encoding, callback) { callback(sensitiveError()); } });
      sink = createDiagnosticSink(stream);
    }
    const diagnostic = mode === 'throwing' ? () => { throw sensitiveError(); } : sink.report;
    await withBroker(async ({ broker, paths, env, accounts, cli }) => {
      const credential = loadCredential(clientPaths(env));
      const request = { op: 'send', agentId: accounts.alice, to: accounts.bob, body: BODY, key: 'diagnostic-success' };
      const sent = await call(paths, credential, request);
      assert.equal(sent.ok, true);
      const persisted = readFileSync(broker.log.file, 'utf8');
      await assert.rejects(call(paths, { ...credential, secret: SECRET }, request), { code: 'unauthenticated' });
      assert.equal(readFileSync(broker.log.file, 'utf8'), persisted, 'permission refusal must not write state');
      assert.ok(output.lines.every((line) => ['broker.started', 'mailbox.admitted'].includes(JSON.parse(line).event)), 'expected refusals add no implementation diagnostics');

      const now = broker.now;
      broker.now = () => { throw sensitiveError(); };
      await assert.rejects(call(paths, credential, { op: 'read', agentId: accounts.bob }), {
        code: 'internal', message: 'the broker hit an internal error',
      });
      broker.now = now;
      const read = await cli(['inbox', 'read'], accounts.bob);
      assert.equal(read.exit, 0);
      assert.equal(read.json.messages[0].body, BODY, 'successful CLI stdout remains structured and canonical');
      await call(paths, credential, { op: 'ack', agentId: accounts.bob, ids: [sent.messageId] });
      assert.equal(broker.state.acked.get(accounts.bob).has(sent.messageId), true);

      const before = structuredClone(broker.state);
      const io = broker.log.io;
      broker.log.io = { ...io, fsyncSync() { throw sensitiveError(); } };
      const failed = { ...request, key: 'diagnostic-storage-failure' };
      await assert.rejects(call(paths, credential, failed), { code: 'storage-failed',
        message: 'broker storage is uncertain; stop the broker, correct storage and restart to recover before retrying' });
      assert.equal(broker.log.poisoned, true);
      assert.deepEqual(broker.state, before, 'uncertain append must not apply in-memory state');
      const uncertainLog = readFileSync(broker.log.file, 'utf8');
      await assert.rejects(call(paths, credential, { ...failed, key: 'must-refuse' }), { code: 'storage-failed' });
      assert.equal(readFileSync(broker.log.file, 'utf8'), uncertainLog, 'poisoned writer must not append again');
      broker.log.io = io;
      const recovered = new EventLog(paths.state).replay();
      assert.equal(recovered.messages.size, before.messages.size + 1, 'existing complete-line recovery semantics survive');
      assert.ok(!uncertainLog.includes('agent-comms-broker'), 'diagnostics must never enter the durable event log');
      if (mode === 'capture') {
        await flushed(sink);
        assert.deepEqual(safeLines(output.lines).map((record) => [record.event, record.code]), [
          ['broker.started', 'ready'], ['mailbox.admitted', 'admitted'], ['broker.request-failure', 'internal'],
          ['mailbox.read', 'read'], ['mailbox.acked', 'acknowledged'], ['broker.storage-failure', 'storage-failed'],
        ]);
      }
    }, { brokerOptions: { mode: 'single-account', now: () => 1000, diagnostic } });
    if (stream) stream.emit('close');
  });
}

test('maintenance timer and compaction report safe stage/code while preserving recovery refusal', async (t) => {
  const { stream, sink, lines } = capture();
  t.after(() => stream.destroy());
  let clock = 1000;
  await withBroker(async ({ broker, cli }) => {
    const now = broker.now;
    broker.now = () => { throw sensitiveError(); };
    for (let attempt = 0; attempt < 100 && !lines.some((line) => JSON.parse(line).event === 'broker.maintenance-failure'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    broker.now = now;
    assert.equal(broker.log.poisoned, false, 'a clock exception must not imply storage poisoning');
    assert.equal((await cli(['peers'])).exit, 0, 'maintenance diagnostics must not stop subsequent real requests');
    const compact = broker.log.compact;
    broker.log.compact = () => { throw sensitiveError(); };
    broker.limits.compactAfterBytes = 1;
    clock = 2000;
    for (let attempt = 0; attempt < 100 && !lines.some((line) => JSON.parse(line).event === 'broker.maintenance-storage'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(broker.log.poisoned, true);
    assert.throws(() => broker.maintain(), { code: 'storage-failed' });
    broker.log.compact = compact;
    await flushed(sink);
    const records = safeLines(lines);
    assert.ok(records.some((record) => record.event === 'broker.maintenance-failure' && record.code === 'internal'));
    assert.ok(records.some((record) => record.event === 'broker.storage-failure' && record.stage === 'compact'));
    assert.ok(records.some((record) => record.stage === 'maintenance' && record.code === 'storage-failed'));
    assert.ok(records.every((record) => Number.isSafeInteger(record.durationMs) && record.durationMs >= 0));
  }, { brokerOptions: { mode: 'single-account', now: () => clock, diagnostic: sink.report,
    limits: { maintenanceIntervalMs: 20 } } });
});
