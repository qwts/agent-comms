// Closed private profile shared by local producer and explicit offline export.
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
for (const tuple of Object.values(EVENTS)) Object.freeze(tuple);

export const diagnosticTuple = (token) => typeof token === 'string' && Object.hasOwn(EVENTS, token) ? EVENTS[token] : undefined;
export const diagnosticBuildVersion = (value) => typeof value === 'string'
  && /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[a-zA-Z0-9.-]{1,32})?$/.test(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;

// Only primitive local measurements are accepted, never arbitrary objects.
// null means invalid; undefined means this tuple has no details.
export function diagnosticDetails(token, first, second) {
  if (token === 'mailbox-read' || token === 'mailbox-acked') {
    if (!count(first) || !count(second)) return null;
    return token === 'mailbox-read' ? { returnedCount: first, remainingCount: second }
      : { acknowledgedCount: first, alreadyAcknowledgedCount: second };
  }
  if (token === 'transport-retry') {
    if (!count(first) || first < 1 || !Number.isInteger(second) || second < 0 || second > 10000) return null;
    return { attempt: first, delayMs: second };
  }
  if (token === 'traceparent-dropped') return count(first) && first >= 1 ? { traceparentDroppedCount: first } : null;
  if (token === 'diagnostics-dropped') return count(first) ? { droppedCount: first } : null;
  return undefined;
}

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Descriptor reads avoid invoking accessors at the optional programmatic seam.
function data(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value')) return null;
    result[key] = descriptors[key].value;
  }
  return result;
}
const keysEqual = (value, keys) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');

// Reconstruct, never pass through source fields. File claims are not authority.
export function projectDiagnosticRecord(input) {
  try {
    const value = data(input);
    if (!value || value.v !== 1 || typeof value.eventId !== 'string' || !UUID4.test(value.eventId)
      || typeof value.sessionId !== 'string' || !UUID4.test(value.sessionId)
      || !count(value.observedAtUnixMs) || (value.durationMs !== undefined && !count(value.durationMs))) return null;
    if (!(value.buildSource === 'running' && diagnosticBuildVersion(value.buildVersion))
      && !(value.buildSource === 'unknown' && value.buildVersion === null)) return null;
    const token = Object.keys(EVENTS).find((token) => {
      const [component, event, operation, stage, code, outcome] = EVENTS[token];
      return (value.component === component || token === 'diagnostics-dropped' && value.component === 'agent-comms-client')
        && value.event === event && value.operation === operation && value.stage === stage && value.code === code && value.outcome === outcome;
    });
    if (!token) return null;
    let details;
    if (value.details !== undefined) {
      const supplied = data(value.details);
      if (!supplied) return null;
      if (token === 'mailbox-read') details = diagnosticDetails(token, supplied.returnedCount, supplied.remainingCount);
      else if (token === 'mailbox-acked') details = diagnosticDetails(token, supplied.acknowledgedCount, supplied.alreadyAcknowledgedCount);
      else if (token === 'transport-retry') details = diagnosticDetails(token, supplied.attempt, supplied.delayMs);
      else if (token === 'traceparent-dropped') details = diagnosticDetails(token, supplied.traceparentDroppedCount);
      else if (token === 'diagnostics-dropped') details = diagnosticDetails(token, supplied.droppedCount);
      if (!details || !keysEqual(supplied, Object.keys(details))) return null;
    } else if (diagnosticDetails(token) !== undefined) return null;
    const keys = ['v', 'component', 'buildVersion', 'buildSource', 'event', 'eventId', 'sessionId', 'operation', 'stage', 'code', 'outcome', 'observedAtUnixMs',
      ...(value.durationMs === undefined ? [] : ['durationMs']), ...(details === undefined ? [] : ['details'])];
    if (!keysEqual(value, keys)) return null;
    const result = {};
    for (const key of keys) result[key] = key === 'details' ? details : value[key];
    return result;
  } catch { return null; }
}
