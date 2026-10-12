// Private, local diagnostics only. Callers supply a fixed token, never an
// Error, request, path, message, or caller-supplied correlation metadata.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDiagnosticStderr } from './diagnostic-stderr.mjs';

export const DIAGNOSTIC_LIMITS = Object.freeze({ events: 64, bytes: 32 * 1024, eventBytes: 512 });

const EVENTS = Object.freeze({
  'request-internal': { stage: 'request', code: 'internal', outcome: 'failed' },
  'storage-append': { stage: 'append', code: 'storage-failed', outcome: 'recovery-required' },
  'storage-compact': { stage: 'compact', code: 'storage-failed', outcome: 'recovery-required' },
  'maintenance-internal': { stage: 'maintenance', code: 'internal', outcome: 'failed' },
  'maintenance-storage': { stage: 'maintenance', code: 'storage-failed', outcome: 'recovery-required' },
  'diagnostics-dropped': { stage: 'diagnostics', code: 'diagnostics-dropped', outcome: 'dropped' },
});

const BUILD_VERSION = (() => {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (typeof version === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[a-zA-Z0-9.-]{1,32})?$/.test(version)) return version;
  } catch { /* Packaging metadata must never prevent broker startup. */ }
  return 'unknown';
})();

const addCount = (count, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, count + amount);

export function createDiagnosticSink(stream = createDiagnosticStderr()) {
  const queue = [];
  let queuedBytes = 0;
  let dropped = 0;
  let reportedDrops = 0;
  let written = 0;
  let inFlight = null;
  let scheduled = null;
  let disabled = false;
  let listening = false;

  function record(event, droppedCount) {
    const line = `${JSON.stringify({ component: 'agent-comms-broker', buildVersion: BUILD_VERSION,
      event, eventId: randomUUID(), ...EVENTS[event], ...(droppedCount === undefined ? {} : { droppedCount }) })}\n`;
    const bytes = Buffer.byteLength(line);
    return bytes <= DIAGNOSTIC_LIMITS.eventBytes ? { line, bytes } : null;
  }

  function discard() {
    disabled = true;
    dropped = addCount(dropped, queue.length + (inFlight && !inFlight.summary ? 1 : 0));
    queue.length = 0;
    queuedBytes = 0;
    inFlight = null;
    if (scheduled) clearImmediate(scheduled);
    scheduled = null;
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
    if (disabled || scheduled || inFlight || (!queue.length && dropped === reportedDrops)) return;
    scheduled = setImmediate(pump);
    scheduled.unref();
  }

  function finish() {
    if (!inFlight?.returned || !inFlight.completed || !inFlight.drained) return;
    if (inFlight.summary) reportedDrops = inFlight.drops;
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
      if (dropped !== reportedDrops) {
        next = { ...record('diagnostics-dropped', dropped), summary: true, drops: dropped };
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

  function report(event) {
    try {
      // Type-check first so even a hostile object never gets coerced to a key.
      if (typeof event !== 'string' || event === 'diagnostics-dropped' || !Object.hasOwn(EVENTS, event)) return;
      if (disabled || queue.length >= DIAGNOSTIC_LIMITS.events) { dropped = addCount(dropped); return; }
      const next = record(event);
      if (!next || queuedBytes + next.bytes > DIAGNOSTIC_LIMITS.bytes) { dropped = addCount(dropped); return; }
      queue.push(next);
      queuedBytes += next.bytes;
      schedule();
    } catch { dropped = addCount(dropped); }
  }

  return Object.freeze({ report, stats: () => ({ queued: queue.length, queuedBytes,
    inFlight: inFlight ? 1 : 0, inFlightBytes: inFlight?.bytes ?? 0, written, dropped, disabled }) });
}

// Brokers in one process share one stderr subscription and one finite budget.
let localSink;
export function brokerDiagnostic(event) {
  try { (localSink ??= createDiagnosticSink()).report(event); } catch { /* Best effort. */ }
}
