import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, ReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createDiagnosticSink } from '../lib/diagnostics.mjs';
import { diagnosticTuple, projectDiagnosticRecord } from '../lib/diagnostic-profile.mjs';
import { createDiagnosticExport, diagnosticExportRange, DIAGNOSTIC_EXPORT_LIMITS as LIMITS, writeDiagnosticExport, readDiagnosticExport } from '../lib/diagnostic-export.mjs';

function record(overrides = {}) {
  return { v: 1, component: 'agent-comms-broker', buildVersion: '0.5.3', buildSource: 'running',
    event: 'broker.started', eventId: randomUUID(), sessionId: '12345678-1234-4234-9234-123456789abc',
    operation: 'broker.lifecycle', stage: 'startup', code: 'ready', outcome: 'succeeded', observedAtUnixMs: 100,
    ...overrides };
}
function exportBytes(bytes, options = {}) {
  const parser = createDiagnosticExport({ sourceKind: 'stdin', ...options });
  for (let offset = 0; offset < bytes.length && !parser.stopped(); offset += LIMITS.readBytes) parser.push(bytes.subarray(offset, offset + LIMITS.readBytes));
  return parser.finish({ eof: true });
}
const ndjson = (records) => Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n');

test('real producer records roundtrip closed tuples, exact details, and observed cumulative drops', async (t) => {
  const stream = new EventEmitter(); const lines = [];
  stream.write = (line, done) => { lines.push(line); done(); return true; };
  const sink = createDiagnosticSink(stream); t.after(() => stream.emit('close'));
  const tokens = ['pair-account-pending', 'pair-daemon-pending', 'pair-principal-pending',
    'pair-account-approved', 'pair-daemon-approved', 'pair-principal-approved', 'soul-joined', 'mailbox-admitted', 'mailbox-duplicate', 'mailbox-read', 'mailbox-acked', 'broker-started', 'broker-start-failed',
    'broker-stopped', 'broker-stop-failed', 'transport-ready', 'transport-reconnected', 'request-internal', 'storage-append',
    'storage-compact', 'maintenance-internal', 'maintenance-storage', 'traceparent-dropped', 'transport-unreachable',
    'transport-timeout', 'transport-custody', 'transport-proof', 'transport-retry'];
  sink.report('request-internal', -1);
  for (const token of tokens) sink.report(token, 1, 2, 500);
  for (let i = 0; i < 100 && (sink.stats().queued || sink.stats().inFlight || !lines.length); i += 1) await new Promise((resolve) => setImmediate(resolve));
  const { artifact, output } = exportBytes(Buffer.from(lines.join('')));
  assert.equal(artifact.events.length, tokens.length + 1);
  for (const event of artifact.events.filter(event => event.event.startsWith('pairing.') || event.event === 'membership.joined')) {
    assert.equal(projectDiagnosticRecord({ ...event, details: { account: 'CANARY-private-account' } }), null);
    assert.equal(projectDiagnosticRecord({ ...event, stage: 'CANARY-invalid-stage' }), null);
  }
  assert.deepEqual(artifact.events, lines.map(JSON.parse));
  assert.equal(artifact.status, 'input-processed'); assert.equal(artifact.diagnosticCompleteness, 'unknown');
  assert.deepEqual(artifact.source, { kind: 'stdin', authenticity: 'unverified' });
  assert.ok(Buffer.byteLength(output) <= LIMITS.outputBytes);
  assert.ok(Object.isFrozen(diagnosticTuple('mailbox-read')));
  assert.throws(() => { diagnosticTuple('mailbox-read')[0] = 'secret'; }, TypeError);
});

test('strict reconstruction refuses unknown fields, malformed tuples, unsafe primitives and accessor metadata', () => {
  const canary = 'CANARY-private-path-body-secret';
  const hostile = new Proxy({}, { get() { assert.fail('source metadata coerced'); } });
  const cases = [record({ body: canary }), record({ context: { traceparent: canary } }), record({ v: 2 }),
    record({ event: canary }), record({ stage: canary }), record({ buildVersion: canary }), record({ buildSource: 'unknown' }),
    record({ eventId: hostile }), record({ sessionId: canary }), record({ durationMs: -1 }), record({ observedAtUnixMs: 1.5 }),
    record({ details: { path: canary } }), record({ code: 'internal' })];
  for (const input of cases) assert.equal(projectDiagnosticRecord(input), null);
  const accessors = record(); Object.defineProperty(accessors, 'eventId', { enumerable: true, get() { assert.fail('getter read'); } });
  assert.equal(projectDiagnosticRecord(accessors), null);
  const bytes = ndjson(cases.filter((input) => input.eventId !== hostile));
  const { artifact, output } = exportBytes(Buffer.concat([Buffer.from(`${canary}\n{broken\n`), bytes]));
  assert.equal(artifact.events.length, 0); assert.ok(artifact.coverage.rejectedLines > 0);
  assert.ok(!output.includes(canary));
  const unknown = record({ buildVersion: null, buildSource: 'unknown' });
  assert.deepEqual(projectDiagnosticRecord(unknown), unknown);
});

test('ranges are inclusive/exclusive despite out-of-order clocks; identity accounting is retained/in-range only', () => {
  const shared = record({ observedAtUnixMs: 100 });
  const collision = { ...shared, durationMs: 1 };
  const outside = record({ observedAtUnixMs: 200 });
  const { artifact } = exportBytes(ndjson([outside, shared, shared, collision, record({ observedAtUnixMs: 99 }), record({ observedAtUnixMs: 199 })]),
    { range: diagnosticExportRange(100, 200) });
  assert.equal(artifact.events.length, 2);
  assert.deepEqual(artifact.observedRange, { minUnixMs: 100, maxUnixMs: 199 });
  assert.equal(artifact.coverage.outsideRangeRecords, 2); assert.equal(artifact.coverage.duplicateRecords, 1); assert.equal(artifact.coverage.identityCollisions, 1);
  for (const range of [[-1, 2], [2, 2], [3, 2], [0.5, 2], [0, Infinity]]) assert.throws(() => diagnosticExportRange(...range), { code: 'usage' });
});

test('huge whitespace, malformed UTF8 and partial final line stay bounded and never become records', () => {
  const valid = record();
  const input = Buffer.concat([Buffer.alloc(10000, 32), Buffer.from('\n'), Buffer.from([0xff, 10]), ndjson([valid]), Buffer.from([0xe2, 0x82])]);
  const { artifact } = exportBytes(input);
  assert.deepEqual(artifact.events, [valid]);
  assert.equal(artifact.coverage.oversizedLines, 1); assert.equal(artifact.coverage.rejectedLines, 1); assert.equal(artifact.coverage.partialFinalLines, 1);
  const partial = exportBytes(Buffer.from(JSON.stringify(valid))).artifact;
  assert.equal(partial.events.length, 0); assert.equal(partial.coverage.partialFinalLines, 1);
});

test('exact byte, line and record limits report prefix coverage and bound serialized output', () => {
  const byte = exportBytes(Buffer.alloc(LIMITS.inputBytes + 100, 32)).artifact;
  assert.equal(byte.coverage.inputBytes, LIMITS.inputBytes); assert.deepEqual(byte.coverage.reasons, ['byte-limit']);
  assert.equal(byte.coverage.partialFinalLines, 1); assert.equal(byte.coverage.oversizedLines, 1); assert.equal(byte.coverage.reachedEof, false);
  const lines = exportBytes(Buffer.alloc(LIMITS.inputLines + 10, 10)).artifact;
  assert.equal(lines.coverage.completeLines, LIMITS.inputLines); assert.deepEqual(lines.coverage.reasons, ['line-limit']);
  const records = exportBytes(ndjson(Array.from({ length: LIMITS.records + 1 }, () => record({ durationMs: Number.MAX_SAFE_INTEGER }))));
  assert.equal(records.artifact.events.length, LIMITS.records); assert.deepEqual(records.artifact.coverage.reasons, ['record-limit']);
  assert.equal(records.artifact.coverage.reachedEof, false); assert.ok(Buffer.byteLength(records.output) < LIMITS.outputBytes);
  const parser = createDiagnosticExport({ sourceKind: 'stdin' });
  assert.throws(() => parser.push(Buffer.alloc(LIMITS.readBytes + 1)), { code: 'diagnostic-input-refused' });
  const failed = parser.finish({ inputFailure: 'input-read-failed' });
  assert.equal(failed.exitCode, 1); assert.equal(failed.artifact.status, 'input-failed');
  assert.deepEqual(failed.artifact.coverage.reasons, ['input-read-failed']);
});

test('output requires callback and drain; synchronous failures use fixed errors only', async () => {
  const stream = new EventEmitter(); let complete;
  stream.write = (_, done) => { complete = done; return false; };
  let settled = false;
  const writing = writeDiagnosticExport(stream, '{}\n').then(() => { settled = true; });
  complete(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(settled, false);
  stream.emit('drain'); await writing;
  const failed = new EventEmitter(); failed.write = () => { throw new Error('CANARY-output-secret'); };
  await assert.rejects(writeDiagnosticExport(failed, '{}\n'), { code: 'diagnostic-output-failed', message: 'diagnostic output did not complete' });
});


test('partial input read failure preserves inspected evidence with fixed metadata', async () => {
  const event = record(); const line = ndjson([event]); let produced = false;
  const source = new Readable({ highWaterMark: LIMITS.readBytes, read() {
    if (produced) return; produced = true;
    this.push(Buffer.concat([line, Buffer.alloc(LIMITS.readBytes - line.length, 32)]));
    setImmediate(() => this.destroy(new Error('CANARY-identifying-input-path')));
  } });
  const result = await readDiagnosticExport('-', diagnosticExportRange(), source);
  assert.equal(result.exitCode, 1); assert.equal(result.artifact.status, 'input-failed');
  assert.deepEqual(result.artifact.events, [event]);
  assert.deepEqual(result.artifact.coverage.reasons, ['input-read-failed']);
  assert.ok(!result.output.includes('CANARY')); assert.equal(source.destroyed, true);
});

test('selected regular file mutation is reported without filename or coherent-snapshot claims', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-export-mutation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'CANARY-private-name'); const event = record();
  writeFileSync(file, ndjson([event]));
  const original = ReadStream.prototype._read; let mutated = false;
  const seam = t.mock.method(ReadStream.prototype, '_read', function(size) {
    if (!mutated) { mutated = true; appendFileSync(file, 'CANARY-private-appended-content\n'); }
    return original.call(this, size);
  });
  const result = await readDiagnosticExport(file, diagnosticExportRange()); seam.mock.restore();
  assert.equal(mutated, true); assert.equal(result.artifact.coverage.sourceChanged, true);
  assert.equal(result.artifact.diagnosticCompleteness, 'unknown'); assert.deepEqual(result.artifact.events, [event]);
  assert.ok(!result.output.includes('CANARY')); assert.equal(result.exitCode, 0);
});


test('a 512-byte complete line is accepted and a 513-byte line is drained', () => {
  const valid = record(); const json = JSON.stringify(valid);
  const exact = Buffer.from(json + ' '.repeat(511 - Buffer.byteLength(json)) + '\n');
  const oversized = Buffer.from(json + ' '.repeat(512 - Buffer.byteLength(json)) + '\n');
  assert.equal(exact.length, LIMITS.lineBytes); assert.equal(oversized.length, LIMITS.lineBytes + 1);
  const { artifact } = exportBytes(Buffer.concat([exact, oversized]));
  assert.deepEqual(artifact.events, [valid]); assert.equal(artifact.coverage.oversizedLines, 1);
  assert.equal(artifact.coverage.completeLines, 2);
});
