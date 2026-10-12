// Explicit local inspection only. No credentials, network, persistence or raw
// input excerpts. The CLI owns its input and output handles and terminal exit.
import { spawnDiagnosticExportHelper } from './platform/diagnostic-export-process.mjs';
import { performance } from 'node:perf_hooks';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { projectDiagnosticRecord, diagnosticBuildVersion, DIAGNOSTIC_EXPORT_VERSION } from './diagnostic-profile.mjs';
import { RUNNING_BUILD } from './build-metadata.mjs';
import { CommsError } from './errors.mjs';

export const DIAGNOSTIC_EXPORT_LIMITS = Object.freeze({ inputBytes: 1024 * 1024, inputLines: 4096,
  records: 512, lineBytes: 512, outputBytes: 320 * 1024, metadataBytes: 8192,
  readBytes: 4096, stdinHighWaterMark: 65536, inputDeadlineMs: 5000, outputDeadlineMs: 2000 });
const add = (value, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, value + amount);
const safeTime = (value) => Number.isSafeInteger(value) && value >= 0;
const failure = (code) => new CommsError(code, ({
  'diagnostic-input-refused': 'diagnostic input must be a readable regular file or explicit stdin',
  'diagnostic-output-failed': 'diagnostic output did not complete',
  'diagnostic-output-timeout': 'diagnostic output exceeded its deadline',
})[code]);

export function diagnosticExportRange(from = null, until = null) {
  if ((from !== null && !safeTime(from)) || (until !== null && !safeTime(until))
    || (from !== null && until !== null && from >= until)) throw new CommsError('usage', 'diagnostic time range must use nonnegative safe integers with from before until');
  return { fromUnixMsInclusive: from, untilUnixMsExclusive: until };
}

export function createDiagnosticExport({ sourceKind, range = diagnosticExportRange(), exporter = { buildVersion: null, buildSource: 'unknown' } }) {
  if (!['selected-file', 'stdin'].includes(sourceKind)) throw failure('diagnostic-input-refused');
  range = diagnosticExportRange(range.fromUnixMsInclusive, range.untilUnixMsExclusive);
  const events = [];
  const identities = new Map();
  const coverage = { inputBytes: 0, completeLines: 0, acceptedRecords: 0, rejectedLines: 0,
    oversizedLines: 0, outsideRangeRecords: 0, duplicateRecords: 0, identityCollisions: 0,
    partialFinalLines: 0, reachedEof: false, sourceChanged: null, reasons: [] };
  const line = Buffer.alloc(DIAGNOSTIC_EXPORT_LIMITS.lineBytes);
  let lineBytes = 0;
  let oversized = false;
  let stopped = false;
  let ended = false;
  let eventBytes = 0;
  let minTime = null;
  let maxTime = null;
  function stop(reason) { if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason); stopped = true; }
  function completeLine() {
    coverage.completeLines = add(coverage.completeLines);
    if (oversized) { coverage.oversizedLines = add(coverage.oversizedLines); return; }
    let record;
    try { record = projectDiagnosticRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line.subarray(0, lineBytes - 1)))); }
    catch { /* Only aggregate rejection is retained. */ }
    if (!record) { coverage.rejectedLines = add(coverage.rejectedLines); return; }
    const at = record.observedAtUnixMs;
    if ((range.fromUnixMsInclusive !== null && at < range.fromUnixMsInclusive)
      || (range.untilUnixMsExclusive !== null && at >= range.untilUnixMsExclusive)) {
      coverage.outsideRangeRecords = add(coverage.outsideRangeRecords); return;
    }
    const identity = `${record.component}:${record.sessionId}:${record.eventId}`;
    const canonical = JSON.stringify(record);
    if (identities.has(identity)) {
      const key = identities.get(identity) === canonical ? 'duplicateRecords' : 'identityCollisions';
      coverage[key] = add(coverage[key]); return;
    }
    const bytes = Buffer.byteLength(canonical) + (events.length ? 1 : 0);
    if (eventBytes + bytes > DIAGNOSTIC_EXPORT_LIMITS.outputBytes - DIAGNOSTIC_EXPORT_LIMITS.metadataBytes) { stop('output-limit'); return; }
    identities.set(identity, canonical);
    events.push(record);
    eventBytes += bytes;
    coverage.acceptedRecords = add(coverage.acceptedRecords);
    minTime = minTime === null ? at : Math.min(minTime, at);
    maxTime = maxTime === null ? at : Math.max(maxTime, at);
    if (events.length >= DIAGNOSTIC_EXPORT_LIMITS.records) stop('record-limit');
  }
  function push(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length > DIAGNOSTIC_EXPORT_LIMITS.readBytes) throw failure('diagnostic-input-refused');
    if (ended) throw failure('diagnostic-input-refused');
    for (const byte of chunk) {
      if (stopped) break;
      coverage.inputBytes = add(coverage.inputBytes);
      if (lineBytes < line.length) line[lineBytes] = byte;
      lineBytes += 1;
      if (lineBytes > line.length) oversized = true;
      if (byte === 10) {
        completeLine(); lineBytes = 0; oversized = false;
        if (coverage.completeLines >= DIAGNOSTIC_EXPORT_LIMITS.inputLines) stop('line-limit');
      }
      if (coverage.inputBytes >= DIAGNOSTIC_EXPORT_LIMITS.inputBytes) stop('byte-limit');
    }
    return !stopped;
  }
  function finish({ eof = false, inputFailure = null, sourceChanged = null } = {}) {
    if (ended) throw failure('diagnostic-input-refused');
    ended = true;
    if (lineBytes) { coverage.partialFinalLines = 1; if (oversized) coverage.oversizedLines = add(coverage.oversizedLines); }
    coverage.reachedEof = eof && !stopped;
    coverage.sourceChanged = typeof sourceChanged === 'boolean' ? sourceChanged : null;
    if (inputFailure !== null) {
      if (!['input-read-failed', 'input-timeout'].includes(inputFailure)) throw failure('diagnostic-input-refused');
      if (!coverage.reasons.includes(inputFailure)) coverage.reasons.push(inputFailure);
    }
    const exportedAt = Date.now();
    const artifact = { schema: 'agent-comms.diagnostic-export', v: DIAGNOSTIC_EXPORT_VERSION,
      exportedAtUnixMs: safeTime(exportedAt) ? exportedAt : null,
      exporter: exporter.buildSource === 'running' && diagnosticBuildVersion(exporter.buildVersion)
        ? { buildVersion: exporter.buildVersion, buildSource: 'running' } : { buildVersion: null, buildSource: 'unknown' },
      source: { kind: sourceKind, authenticity: 'unverified' },
      requestedRange: range, observedRange: { minUnixMs: minTime, maxUnixMs: maxTime },
      status: inputFailure ? 'input-failed' : coverage.reasons.length ? 'limited' : 'input-processed',
      diagnosticCompleteness: 'unknown', coverage, limits: DIAGNOSTIC_EXPORT_LIMITS, events };
    const output = `${JSON.stringify(artifact)}\n`;
    if (Buffer.byteLength(output) > DIAGNOSTIC_EXPORT_LIMITS.outputBytes) throw failure('diagnostic-output-failed');
    return { artifact, output, exitCode: inputFailure ? 1 : 0 };
  }
  return { push, finish, stopped: () => stopped };
}

const fingerprint = (stat) => `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

// A deadline owns the whole open/read phase. Named opens are nonblocking so a
// FIFO cannot occupy a blocking open before the regular-file check.
export async function readDiagnosticExport(input, range, stdin = process.stdin) {
  if (typeof input !== 'string' || !input.length) throw failure('diagnostic-input-refused');
  const exporter = RUNNING_BUILD;
  const parser = createDiagnosticExport({ sourceKind: input === '-' ? 'stdin' : 'selected-file', range, exporter });
  let handle;
  let stream;
  let initial;
  let timer;
  let settled = false;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    async function end(inputFailure, eof = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stream) {
        stream.removeListener('readable', consume);
        stream.removeListener('end', onEnd);
        stream.removeListener('error', onError);
        stream.on('error', () => {}); // Suppress late owned-disposal errors.
        stream.pause();
      }
      let changed = null;
      if (handle) {
        const cleanup = (async () => {
          try { changed = fingerprint(initial) !== fingerprint(await handle.stat({ bigint: true })); }
          catch { inputFailure ??= 'input-read-failed'; }
          try {
            if (stream && !stream.closed) {
              const closed = new Promise((done) => stream.once('close', done));
              stream.destroy();
              await closed;
            }
            if (handle.fd >= 0) await handle.close();
          } catch { inputFailure ??= 'input-read-failed'; }
        })();
        let cleanupTimer;
        const remaining = Math.max(0, DIAGNOSTIC_EXPORT_LIMITS.inputDeadlineMs - (performance.now() - started));
        const closed = await Promise.race([cleanup.then(() => true), new Promise((done) => {
          cleanupTimer = setTimeout(() => done(false), remaining);
        })]);
        clearTimeout(cleanupTimer);
        if (!closed) { inputFailure = 'input-timeout'; changed = null; }
      }
      stream?.destroy();
      resolve(parser.finish({ eof, inputFailure, sourceChanged: changed }));
    }
    function onError() { void end('input-read-failed'); }
    function onEnd() { void end(null, true); }
    function consume() {
      try {
        let chunk;
        while (!settled) {
          if (performance.now() - started >= DIAGNOSTIC_EXPORT_LIMITS.inputDeadlineMs) { void end('input-timeout'); break; }
          chunk = stream.read(DIAGNOSTIC_EXPORT_LIMITS.readBytes);
          if (chunk === null) break;
          if (!parser.push(chunk)) { void end(null); break; }
        }
      } catch { void end('input-read-failed'); }
    }
    timer = setTimeout(() => { void end('input-timeout'); }, DIAGNOSTIC_EXPORT_LIMITS.inputDeadlineMs);
    void (async () => {
      try {
        if (input === '-') {
          stream = stdin;
          if (!Number.isInteger(stream.readableHighWaterMark) || stream.readableHighWaterMark > DIAGNOSTIC_EXPORT_LIMITS.stdinHighWaterMark) throw failure('diagnostic-input-refused');
        } else {
          handle = await open(input, constants.O_RDONLY | constants.O_NONBLOCK);
          if (settled) { await handle.close(); return; }
          initial = await handle.stat({ bigint: true });
          if (!initial.isFile()) throw failure('diagnostic-input-refused');
          stream = handle.createReadStream({ highWaterMark: DIAGNOSTIC_EXPORT_LIMITS.readBytes, autoClose: false });
        }
        if (settled) { stream.destroy(); return; }
        stream.on('readable', consume);
        stream.once('end', onEnd);
        stream.once('error', onError);
        consume();
      } catch {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { await handle?.close(); } catch { /* Fixed refusal only. */ }
        reject(failure('diagnostic-input-refused'));
      }
    })();
  });
}

// Actual callback completion AND drain are required. After failure the CLI
// owns terminal disposal; it must never append a second document to stdout.
export function writeDiagnosticExport(stream, output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > DIAGNOSTIC_EXPORT_LIMITS.outputBytes) return Promise.reject(failure('diagnostic-output-failed'));
  return new Promise((resolve, reject) => {
    let returned = false;
    let completed = false;
    let drained = false;
    let settled = false;
    const timer = setTimeout(() => done(failure('diagnostic-output-timeout')), DIAGNOSTIC_EXPORT_LIMITS.outputDeadlineMs);
    function cleanup() { clearTimeout(timer); stream.removeListener('drain', onDrain); stream.removeListener('error', onError); stream.removeListener('close', onClose); }
    function done(error) { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(); }
    function finish() { if (returned && completed && drained) done(); }
    function onDrain() { drained = true; finish(); }
    function onError() { done(failure('diagnostic-output-failed')); }
    function onClose() { done(failure('diagnostic-output-failed')); }
    stream.on('drain', onDrain); stream.on('error', onError); stream.on('close', onClose);
    try {
      const accepted = stream.write(output, (error) => { if (error) onError(); else { completed = true; finish(); } });
      returned = true; drained ||= accepted !== false; finish();
    } catch { onError(); }
  });
}

// stdout may use synchronous OS writes. Isolate that work in one owned helper,
// never rely on a timer on the writer's potentially blocked event loop.
export function writeDiagnosticExportOwned(output, { onOwnedChild = () => {}, onOwnedWriter = () => {} } = {}) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > DIAGNOSTIC_EXPORT_LIMITS.outputBytes) return Promise.reject(failure('diagnostic-output-failed'));
  return new Promise((resolve, reject) => {
    let child;
    let acknowledged = false;
    let error = null;
    let cleanupTimer;
    let settled = false;
    function fail(code = 'diagnostic-output-failed') {
      error ??= failure(code);
      try { if (child?.connected) child.send({ cancel: true }, () => {}); } catch { /* No OS text. */ }
      cleanupTimer ??= setTimeout(() => {
        // Leave the unblocked supervisor to its own watchdog/IPC cleanup.
        // Killing it now could strand its writer; no all-gone claim on timeout.
        finish(error);
      }, DIAGNOSTIC_EXPORT_LIMITS.outputDeadlineMs);
    }
    function finish(reason) {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(cleanupTimer);
      reason ? reject(reason) : resolve();
    }
    const timer = setTimeout(() => fail('diagnostic-output-timeout'), DIAGNOSTIC_EXPORT_LIMITS.outputDeadlineMs);
    try {
      const writer = new URL('./diagnostic-export-supervisor.mjs', import.meta.url).href;
      child = spawnDiagnosticExportHelper(writer);
      child.on('error', () => fail());
      child.on('message', (message) => {
        if (message?.stage === 'writer-started' && Number.isSafeInteger(message.pid) && message.pid > 0) {
          try { onOwnedWriter(message.pid); } catch { fail(); }
        } else if (message?.ok === true && !acknowledged) acknowledged = true;
        else fail(message?.timeout === true ? 'diagnostic-output-timeout' : 'diagnostic-output-failed');
      });
      child.on('close', (code, signal) => {
        finish(error ?? (acknowledged && code === 0 && signal === null ? null : failure('diagnostic-output-failed')));
      });
      onOwnedChild(child);
      child.send({ output }, (sendError) => { if (sendError) fail(); });
    } catch { fail(); }
  });
}
