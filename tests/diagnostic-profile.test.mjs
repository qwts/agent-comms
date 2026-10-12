import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createDiagnosticSink, DIAGNOSTIC_LIMITS } from '../lib/diagnostics.mjs';

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function capture(options) {
  const stream = new EventEmitter();
  const lines = [];
  stream.write = (line, complete) => { lines.push(line); complete(); return true; };
  return { stream, lines, sink: createDiagnosticSink(stream, options) };
}

async function flush(sink) {
  for (let i = 0; i < 200; i += 1) {
    await tick();
    if (!sink.stats().queued && !sink.stats().inFlight) return;
  }
  assert.fail('bounded diagnostic fixture did not flush');
}

test('local producer emits the reviewed exact profile subset and every finite broker/client tuple', async (t) => {
  const { stream, lines, sink } = capture();
  t.after(() => stream.emit('close'));
  const fixtures = [
    ['broker-started', 'broker.started', 'broker.lifecycle', 'startup', 'ready', 'succeeded'],
    ['broker-start-failed', 'broker.start-failed', 'broker.lifecycle', 'startup', 'startup-failed', 'failed'],
    ['broker-stopped', 'broker.stopped', 'broker.lifecycle', 'shutdown', 'stopped', 'succeeded'],
    ['broker-stop-failed', 'broker.stop-failed', 'broker.lifecycle', 'shutdown', 'shutdown-failed', 'failed'],
    ['transport-ready', 'transport.ready', 'transport.watch', 'ready', 'ready', 'succeeded'],
    ['transport-reconnected', 'transport.reconnected', 'transport.watch', 'reconnect', 'ready', 'succeeded'],
    ['request-internal', 'broker.request-failure', 'broker.request', 'handler', 'internal', 'failed'],
    ['storage-append', 'broker.storage-failure', 'broker.storage', 'append', 'storage-failed', 'recovery-required'],
    ['storage-compact', 'broker.storage-failure', 'broker.storage', 'compact', 'storage-failed', 'recovery-required'],
    ['maintenance-internal', 'broker.maintenance-failure', 'broker.maintenance', 'maintenance', 'internal', 'failed'],
    ['maintenance-storage', 'broker.maintenance-storage', 'broker.maintenance', 'maintenance', 'storage-failed', 'recovery-required'],
    ['traceparent-dropped', 'broker.traceparent-dropped', 'broker.launch', 'propagation', 'traceparent_dropped', 'dropped'],
    ['transport-unreachable', 'transport.unreachable', 'transport.connect', 'connect', 'broker-unreachable', 'failed'],
    ['transport-timeout', 'transport.timeout', 'transport.request', 'deadline', 'broker-timeout', 'failed'],
    ['transport-custody', 'transport.untrusted', 'transport.connect', 'custody', 'broker-untrusted', 'refused'],
    ['transport-proof', 'transport.untrusted', 'transport.connect', 'proof', 'broker-untrusted', 'refused'],
    ['transport-retry', 'transport.retry', 'transport.watch', 'backoff', 'retry-scheduled', 'succeeded'],
  ];
  const before = Date.now();
  for (const [token] of fixtures) sink.report(token, 17, 2, 500);
  await flush(sink);
  assert.equal(lines.length, fixtures.length);
  const records = lines.map((line, index) => {
    assert.ok(Buffer.byteLength(line) <= DIAGNOSTIC_LIMITS.eventBytes);
    const record = JSON.parse(line);
    const [token, event, operation, stage, code, outcome] = fixtures[index];
    assert.deepEqual(Object.keys(record).sort(), ['v', 'component', 'buildVersion', 'buildSource', 'event', 'eventId',
      'sessionId', 'operation', 'stage', 'code', 'outcome', 'observedAtUnixMs', 'durationMs',
      ...(['transport-retry','traceparent-dropped'].includes(token) ? ['details'] : [])].sort());
    assert.equal(record.v, 1);
    assert.equal(record.component, token.startsWith('transport-') ? 'agent-comms-client' : 'agent-comms-broker');
    assert.match(record.buildVersion, /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/);
    assert.equal(record.buildSource, 'running');
    assert.match(record.eventId, UUID4);
    assert.match(record.sessionId, UUID4);
    assert.deepEqual([record.event, record.operation, record.stage, record.code, record.outcome], [event, operation, stage, code, outcome]);
    assert.equal(record.durationMs, 17);
    assert.ok(record.observedAtUnixMs >= before && record.observedAtUnixMs <= Date.now());
    if (token === 'transport-retry') assert.deepEqual(record.details, { attempt: 2, delayMs: 500 });
    if (token === 'traceparent-dropped') assert.deepEqual(record.details, { traceparentDroppedCount: 2 });
    return record;
  });
  assert.equal(new Set(records.map((record) => record.sessionId)).size, 1);
  assert.equal(new Set(records.map((record) => record.eventId)).size, fixtures.length);
});

test('launch context drop counter accepts only bounded local integers and never serializes peer context', async (t) => {
  const { stream, lines, sink } = capture(); t.after(() => stream.emit('close'));
  const hostile = new Proxy({}, { get() { assert.fail('counter inspected peer metadata'); } });
  for (const count of [hostile, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) sink.report('traceparent-dropped', undefined, count);
  sink.report('traceparent-dropped', undefined, Number.MAX_SAFE_INTEGER, hostile);
  await flush(sink);
  const counter = lines.map(JSON.parse).find((record) => record.event === 'broker.traceparent-dropped');
  assert.ok(counter); assert.equal(counter.durationMs, undefined);
  assert.deepEqual(counter.details, { traceparentDroppedCount: Number.MAX_SAFE_INTEGER });
  assert.equal(sink.stats().dropped, 7);
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line) <= DIAGNOSTIC_LIMITS.eventBytes);
    const record = JSON.parse(line);
    assert.ok(!Object.hasOwn(record, 'context') && !Object.hasOwn(record, 'links') && !Object.hasOwn(record, 'traceparent'));
  }
});

test('primitive-only measurements discard hostile data without getters, coercion, context or links', async (t) => {
  const { stream, lines, sink } = capture();
  t.after(() => stream.emit('close'));
  const hostile = new Proxy({}, { get() { assert.fail('producer inspected untrusted data'); } });
  for (const duration of [hostile, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) sink.report('transport-timeout', duration);
  for (const [attempt, delay] of [[hostile, 0], [0, 0], [1, hostile], [1, 10001], [1, 0.5]]) sink.report('transport-retry', undefined, attempt, delay);
  sink.report(hostile);
  sink.report('transport-timeout', 0, hostile, hostile);
  await flush(sink);
  assert.equal(sink.stats().dropped, 11);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]).details, { droppedCount: 11 });
  assert.equal(JSON.parse(lines[0]).component, 'agent-comms-client');
  const event = JSON.parse(lines[1]);
  assert.equal(event.durationMs, 0);
  assert.ok(!Object.hasOwn(event, 'context') && !Object.hasOwn(event, 'links') && !Object.hasOwn(event, 'details'));
});

test('event rate and recovered summaries have separate finite limits without recursive drop events', async (t) => {
  let clock = 0;
  const { stream, lines, sink } = capture({ clock: () => clock });
  t.after(() => stream.emit('close'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < 1000; i += 1) sink.report('transport-timeout');
  await flush(sink);
  assert.equal(sink.stats().written, 64);
  assert.equal(sink.stats().dropped, 936);
  assert.equal(lines.length, 65);
  for (let i = 0; i < 1000; i += 1) sink.report('transport-timeout');
  await tick();
  assert.equal(lines.length, 65, 'drop reporting must not bypass its one-second cap');
  clock = 999;
  t.mock.timers.tick(999);
  await tick();
  assert.equal(lines.length, 65);
  clock = 1000;
  t.mock.timers.tick(1);
  await flush(sink);
  assert.equal(lines.length, 66);
  assert.deepEqual(lines.map(JSON.parse).filter((r) => r.event === 'diagnostics.dropped').map((r) => r.details.droppedCount), [936, 1936]);
  for (let i = 0; i < 65; i += 1) sink.report('transport-timeout');
  await flush(sink);
  assert.equal(sink.stats().written, 128, 'refill cannot accumulate more than burst64');
  assert.equal(sink.stats().dropped, 1937);
});

test('invalid or missing build metadata has explicit unknown provenance without copying its text', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-diagnostic-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'lib', 'platform'), { recursive: true });
  copyFileSync(new URL('../lib/diagnostics.mjs', import.meta.url), path.join(root, 'lib', 'diagnostics.mjs'));
  copyFileSync(new URL('../lib/platform/diagnostic-stderr.mjs', import.meta.url), path.join(root, 'lib', 'platform', 'diagnostic-stderr.mjs'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: 'CANARY-private-version/path' }));
  const { createDiagnosticSink: copiedSink } = await import(pathToFileURL(path.join(root, 'lib', 'diagnostics.mjs')));
  const { stream, lines } = capture();
  const sink = copiedSink(stream);
  sink.report('request-internal');
  await flush(sink);
  assert.equal(JSON.parse(lines[0]).buildVersion, null);
  assert.equal(JSON.parse(lines[0]).buildSource, 'unknown');
  assert.ok(!lines.join('').includes('CANARY'));
  stream.emit('close');
});

test('embedded broker and client losses retain separate attribution under one global summary interval', async (t) => {
  let clock = 0;
  const { stream, lines, sink } = capture({ clock: () => clock });
  t.after(() => stream.emit('close'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sink.report('transport-timeout', -1);
  sink.report('request-internal', -1);
  sink.report('request-internal', -1);
  sink.report('request-internal');
  await flush(sink);
  assert.equal(sink.stats().dropped, 3);
  assert.deepEqual(lines.map(JSON.parse).filter((r) => r.event === 'diagnostics.dropped').map((r) => [r.component, r.details.droppedCount]), [
    ['agent-comms-broker', 2],
  ]);
  clock = 1000;
  t.mock.timers.tick(1000);
  await flush(sink);
  assert.deepEqual(lines.map(JSON.parse).filter((r) => r.event === 'diagnostics.dropped').map((r) => [r.component, r.details.droppedCount]), [
    ['agent-comms-broker', 2], ['agent-comms-client', 1],
  ]);
  assert.equal(sink.stats().dropped, 3, 'summaries must not recursively increment loss');
});

test('UUID failure cannot prevent module import or escape best-effort reporting', () => {
  const module = new URL('../lib/diagnostics.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import crypto from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    import { EventEmitter } from 'node:events';
    crypto.randomUUID = () => { throw new Error('CANARY-randomness-secret'); };
    syncBuiltinESMExports();
    const { createDiagnosticSink, brokerDiagnostic, clientDiagnostic } = await import(${JSON.stringify(module)});
    const stream = new EventEmitter();
    stream.write = () => { throw new Error('must not reach stderr'); };
    const sink = createDiagnosticSink(stream);
    sink.report('request-internal');
    brokerDiagnostic('request-internal');
    clientDiagnostic('transport-timeout');
    process.stdout.write(JSON.stringify(sink.stats()));
  `], { timeout: 3000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).dropped, 1);
});

test('direct mailbox completions use exact bounded count projectors, never caller metadata', async (t) => {
  const { stream, lines, sink } = capture(); t.after(() => stream.emit('close'));
  const hostile = new Proxy({}, { get() { assert.fail('mailbox projector inspected metadata'); } });
  for (const token of ['mailbox-read', 'mailbox-acked']) {
    for (const value of [hostile, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) sink.report(token, 0, value, 0);
    sink.report(token, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  }
  sink.report('mailbox-admitted', 0, hostile, hostile);
  sink.report('mailbox-duplicate', 0, hostile, hostile);
  await flush(sink);
  const records = lines.map(JSON.parse).filter((record) => record.event.startsWith('mailbox.'));
  assert.deepEqual(records.map((record) => record.event), ['mailbox.read', 'mailbox.acked', 'mailbox.admitted', 'mailbox.duplicate']);
  assert.deepEqual(records[0].details, { returnedCount: Number.MAX_SAFE_INTEGER, remainingCount: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(records[1].details, { acknowledgedCount: Number.MAX_SAFE_INTEGER, alreadyAcknowledgedCount: Number.MAX_SAFE_INTEGER });
  assert.equal(records[2].details, undefined); assert.equal(records[3].details, undefined);
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= DIAGNOSTIC_LIMITS.eventBytes);
  assert.equal(sink.stats().dropped, 12);
});
