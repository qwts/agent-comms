// Private, local diagnostics only. Callers supply a fixed token, never an
// Error, request, path, message, or caller-supplied correlation metadata.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createDiagnosticStderr } from './platform/diagnostic-stderr.mjs';

export const DIAGNOSTIC_LIMITS = Object.freeze({ events: 64, bytes: 32 * 1024, eventBytes: 512,
  ratePerSecond: 100, burst: 64, summaryIntervalMs: 1000 });

const EVENTS = Object.freeze({
  'mailbox-admitted': ['agent-comms-broker', 'mailbox.admitted', 'mailbox.send', 'admission', 'admitted', 'succeeded'],
  'mailbox-duplicate': ['agent-comms-broker', 'mailbox.duplicate', 'mailbox.send', 'idempotency', 'duplicate', 'succeeded'],
  'mailbox-read': ['agent-comms-broker', 'mailbox.read', 'mailbox.read', 'page', 'read', 'succeeded'],
  'mailbox-acked': ['agent-comms-broker', 'mailbox.acked', 'mailbox.ack', 'commit', 'acknowledged', 'succeeded'],
  'broker-started': ['agent-comms-broker', 'broker.started', 'broker.lifecycle', 'startup', 'ready', 'succeeded'],
  'broker-start-failed': ['agent-comms-broker', 'broker.start-failed', 'broker.lifecycle', 'startup', 'startup-failed', 'failed'],
  'broker-stopped': ['agent-comms-broker', 'broker.stopped', 'broker.lifecycle', 'shutdown', 'stopped', 'succeeded'],
  'broker-stop-failed': ['agent-comms-broker', 'broker.stop-failed', 'broker.lifecycle', 'shutdown', 'shutdown-failed', 'failed'],
  'transport-ready': ['agent-comms-client', 'transport.ready', 'transport.watch', 'ready', 'ready', 'succeeded'],
  'transport-reconnected': ['agent-comms-client', 'transport.reconnected', 'transport.watch', 'reconnect', 'ready', 'succeeded'],
  'request-internal': ['agent-comms-broker', 'broker.request-failure', 'broker.request', 'handler', 'internal', 'failed'],
  'storage-append': ['agent-comms-broker', 'broker.storage-failure', 'broker.storage', 'append', 'storage-failed', 'recovery-required'],
  'storage-compact': ['agent-comms-broker', 'broker.storage-failure', 'broker.storage', 'compact', 'storage-failed', 'recovery-required'],
  'maintenance-internal': ['agent-comms-broker', 'broker.maintenance-failure', 'broker.maintenance', 'maintenance', 'internal', 'failed'],
  'maintenance-storage': ['agent-comms-broker', 'broker.maintenance-storage', 'broker.maintenance', 'maintenance', 'storage-failed', 'recovery-required'],
  'traceparent-dropped': ['agent-comms-broker', 'broker.traceparent-dropped', 'broker.launch', 'propagation', 'traceparent_dropped', 'dropped'],
  'transport-unreachable': ['agent-comms-client', 'transport.unreachable', 'transport.connect', 'connect', 'broker-unreachable', 'failed'],
  'transport-timeout': ['agent-comms-client', 'transport.timeout', 'transport.request', 'deadline', 'broker-timeout', 'failed'],
  'transport-custody': ['agent-comms-client', 'transport.untrusted', 'transport.connect', 'custody', 'broker-untrusted', 'refused'],
  'transport-proof': ['agent-comms-client', 'transport.untrusted', 'transport.connect', 'proof', 'broker-untrusted', 'refused'],
  'transport-retry': ['agent-comms-client', 'transport.retry', 'transport.watch', 'backoff', 'retry-scheduled', 'succeeded'],
  'diagnostics-dropped': ['agent-comms-broker', 'diagnostics.dropped', 'diagnostics', 'queue', 'diagnostics-dropped', 'dropped'],
});

const BUILD_VERSION = (() => {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (typeof version === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[a-zA-Z0-9.-]{1,32})?$/.test(version)) return version;
  } catch { /* Packaging metadata must never prevent broker startup. */ }
  return null;
})();
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
    const [registeredComponent, event, operation, stage, code, outcome] = EVENTS[token];
    const component = token === 'diagnostics-dropped' ? COMPONENTS[summaryIndex] : registeredComponent;
    sessionId ??= randomUUID();
    const observedAtUnixMs = Date.now();
    if (!Number.isSafeInteger(observedAtUnixMs) || observedAtUnixMs < 0) return null;
    const line = `${JSON.stringify({ v: 1, component, buildVersion: BUILD_VERSION,
      buildSource: BUILD_VERSION === null ? 'unknown' : 'running', event, eventId: randomUUID(),
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
      if (typeof event !== 'string' || event === 'diagnostics-dropped' || !Object.hasOwn(EVENTS, event)) return;
      component = EVENTS[event][0];
      // Only primitive measurements enter the record. Never inspect caller
      // objects, including Error properties or valid-looking peer IDs.
      if (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs < 0)) { countDrop(component); return; }
      let details;
      if (event === 'mailbox-read' || event === 'mailbox-acked') {
        if (![attempt, delayMs].every((value) => Number.isSafeInteger(value) && value >= 0)) { countDrop(component); return; }
        details = event === 'mailbox-read' ? { returnedCount: attempt, remainingCount: delayMs }
          : { acknowledgedCount: attempt, alreadyAcknowledgedCount: delayMs };
      }
      if (event === 'transport-retry') {
        if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000) {
          countDrop(component); return;
        }
        details = { attempt, delayMs };
      }
      if (event === 'traceparent-dropped') {
        if (!Number.isSafeInteger(attempt) || attempt < 1) { countDrop(component); return; }
        details = { traceparentDroppedCount: attempt };
      }
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
export function brokerDiagnostic(event, durationMs, attempt, delayMs) {
  try { (localSink ??= createDiagnosticSink()).report(event, durationMs, attempt, delayMs); } catch { /* Best effort. */ }
}
export const clientDiagnostic = brokerDiagnostic;
