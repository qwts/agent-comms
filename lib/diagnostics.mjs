// Private, local diagnostics only. Callers supply a fixed token, never an
// Error, request, path, message, or caller-supplied correlation metadata.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { diagnosticTuple, diagnosticDetails, DIAGNOSTIC_RECORD_VERSION } from './diagnostic-profile.mjs';
import { RUNNING_BUILD } from './build-metadata.mjs';
import { createDiagnosticStderr } from './platform/diagnostic-stderr.mjs';

export const DIAGNOSTIC_LIMITS = Object.freeze({ events: 64, bytes: 32 * 1024, eventBytes: 512,
  ratePerSecond: 100, burst: 64, summaryIntervalMs: 1000 });
// Lazy generation stays inside the guarded report/pump path: unavailable
// randomness can lose diagnostics, never prevent importing the real client.
let sessionId;

const addCount = (count, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, count + amount);
const COMPONENTS = Object.freeze(['agent-comms-broker', 'agent-comms-client']);

export function createDiagnosticSink(stream = createDiagnosticStderr(), { clock = () => performance.now() } = {}) {
  const queue = [];
  let queuedBytes = 0;
  let dropped = 0;
  const componentDrops = [0, 0];
  const reportedDrops = [0, 0];
  let summaryCursor = 0;
  let written = 0;
  let inFlight = null;
  let scheduled = null;
  let disabled = false;
  let listening = false;
  let summaryTimer = null;
  let lastSummaryAt = -Infinity;
  let tokens = DIAGNOSTIC_LIMITS.burst;
  let tokenTime = clock();

  function countDrop(component, amount = 1) {
    const index = COMPONENTS.indexOf(component);
    componentDrops[index] = addCount(componentDrops[index], amount);
    dropped = addCount(dropped, amount);
  }

  const hasUnreportedDrops = () => componentDrops.some((count, index) => count !== reportedDrops[index]);

  function record(token, durationMs, details, summaryIndex) {
    const [registeredComponent, event, operation, stage, code, outcome] = diagnosticTuple(token);
    const component = token === 'diagnostics-dropped' ? COMPONENTS[summaryIndex] : registeredComponent;
    sessionId ??= randomUUID();
    const observedAtUnixMs = Date.now();
    if (!Number.isSafeInteger(observedAtUnixMs) || observedAtUnixMs < 0) return null;
    const line = `${JSON.stringify({ v: DIAGNOSTIC_RECORD_VERSION, component, buildVersion: RUNNING_BUILD.buildVersion,
      buildSource: RUNNING_BUILD.buildSource, event, eventId: randomUUID(),
      sessionId, operation, stage, code, outcome, observedAtUnixMs,
      ...(durationMs === undefined ? {} : { durationMs }), ...(details === undefined ? {} : { details }) })}\n`;
    const bytes = Buffer.byteLength(line);
    return bytes <= DIAGNOSTIC_LIMITS.eventBytes ? { line, bytes, component } : null;
  }

  function discard() {
    disabled = true;
    for (const pending of queue) countDrop(pending.component);
    if (inFlight && !inFlight.summary) countDrop(inFlight.component);
    queue.length = 0;
    queuedBytes = 0;
    inFlight = null;
    if (scheduled) clearImmediate(scheduled);
    if (summaryTimer) clearTimeout(summaryTimer);
    scheduled = null;
    summaryTimer = null;
    if (listening) stream.removeListener('drain', onDrain);
    // Keep the error listener until close: Writable can invoke the write
    // callback with an error before emitting that same error asynchronously.
    // This sink never destroys, ends, or disables the shared stderr stream.
  }

  function onClose() {
    discard();
    if (listening) {
      stream.removeListener('error', discard);
      stream.removeListener('close', onClose);
      listening = false;
    }
  }

  function schedule() {
    if (disabled || scheduled || inFlight || (!queue.length && !hasUnreportedDrops())) return;
    if (!queue.length && clock() - lastSummaryAt < DIAGNOSTIC_LIMITS.summaryIntervalMs) {
      if (!summaryTimer) {
        summaryTimer = setTimeout(() => { summaryTimer = null; schedule(); },
          Math.ceil(DIAGNOSTIC_LIMITS.summaryIntervalMs - (clock() - lastSummaryAt)));
        summaryTimer.unref();
      }
      return;
    }
    scheduled = setImmediate(pump);
    scheduled.unref();
  }

  function finish() {
    if (!inFlight?.returned || !inFlight.completed || !inFlight.drained) return;
    if (inFlight.summary) { reportedDrops[inFlight.summaryIndex] = inFlight.drops; lastSummaryAt = clock(); }
    else written = addCount(written);
    inFlight = null;
    schedule();
  }

  function onDrain() {
    if (!inFlight) return;
    inFlight.drained = true;
    finish();
  }

  function pump() {
    scheduled = null;
    if (disabled || inFlight) return;
    try {
      if (!listening) {
        stream.on('error', discard);
        stream.on('close', onClose);
        stream.on('drain', onDrain);
        listening = true;
      }
      let next;
      if (hasUnreportedDrops() && clock() - lastSummaryAt >= DIAGNOSTIC_LIMITS.summaryIntervalMs) {
        const summaryIndex = componentDrops[summaryCursor] !== reportedDrops[summaryCursor] ? summaryCursor : 1 - summaryCursor;
        summaryCursor = 1 - summaryIndex;
        const drops = componentDrops[summaryIndex];
        const summary = record('diagnostics-dropped', undefined, { droppedCount: drops }, summaryIndex);
        if (!summary) { discard(); return; }
        next = { ...summary, summary: true, drops, summaryIndex };
      } else {
        next = queue.shift();
        if (!next) return;
        queuedBytes -= next.bytes;
      }
      inFlight = { ...next, returned: false, completed: false, drained: false };
      const current = inFlight;
      const accepted = stream.write(current.line, (error) => {
        if (disabled || inFlight !== current) return;
        if (error) { discard(); return; }
        current.completed = true;
        finish();
      });
      if (disabled || inFlight !== current) return;
      current.returned = true;
      current.drained ||= accepted !== false;
      finish();
    } catch { discard(); }
  }

  function report(event, durationMs, attempt, delayMs) {
    let component;
    try {
      // Type-check first so even a hostile object never gets coerced to a key.
      if (typeof event !== 'string' || event === 'diagnostics-dropped' || !diagnosticTuple(event)) return;
      component = diagnosticTuple(event)[0];
      // Only primitive measurements enter the record. Never inspect caller
      // objects, including Error properties or valid-looking peer IDs.
      if (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs < 0)) { countDrop(component); return; }
      const details = diagnosticDetails(event, attempt, delayMs);
      if (details === null) { countDrop(component); return; }
      const at = clock();
      tokens = Math.min(DIAGNOSTIC_LIMITS.burst, tokens + Math.max(0, at - tokenTime) * DIAGNOSTIC_LIMITS.ratePerSecond / 1000);
      tokenTime = Math.max(tokenTime, at);
      if (tokens < 1) { countDrop(component); schedule(); return; }
      tokens -= 1;
      if (disabled || queue.length >= DIAGNOSTIC_LIMITS.events) { countDrop(component); return; }
      const next = record(event, durationMs, details);
      if (!next || queuedBytes + next.bytes > DIAGNOSTIC_LIMITS.bytes) { countDrop(component); return; }
      queue.push(next);
      queuedBytes += next.bytes;
      schedule();
    } catch { if (component) countDrop(component); }
  }

  return Object.freeze({ report, stats: () => ({ queued: queue.length, queuedBytes,
    inFlight: inFlight ? 1 : 0, inFlightBytes: inFlight?.bytes ?? 0, written, dropped, disabled }) });
}

// All local components in one process share one helper and one finite budget.
let localSink;
// Process-start policy: changing the environment later cannot silently change
// an established process's observation policy. Explicit offline export is separate.
const localDiagnosticsEnabled = process.env.AGENT_COMMS_DIAGNOSTICS !== 'off';
export function brokerDiagnostic(event, durationMs, attempt, delayMs) {
  if (!localDiagnosticsEnabled) return;
  try { (localSink ??= createDiagnosticSink()).report(event, durationMs, attempt, delayMs); } catch { /* Best effort. */ }
}
export const clientDiagnostic = brokerDiagnostic;
