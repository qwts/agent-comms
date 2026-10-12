import { performance } from 'node:perf_hooks';

const ERROR_STAGES = new Set(['host-clixml','host-stderr','pipe-refused','process-error','premature-close','startup-timeout','unclassified']);
const OUTCOMES = new Set(['refused-and-closed','closed-without-refusal','connected','observation-deadline']);
const KEYS = ['outcome','events','heartbeatCount','elapsedMs','errorCode','errorStage','destroyed','readableEnded','writableEnded'];
export function validConnectorObservation(value) {
  return value !== null && typeof value === 'object' && Object.keys(value).length === KEYS.length
    && Object.keys(value).every(key => KEYS.includes(key)) && OUTCOMES.has(value.outcome)
    && Array.isArray(value.events) && value.events.length <= 4 && new Set(value.events).size === value.events.length
    && value.events.every(event => ['connect','error','end','close'].includes(event))
    && Number.isSafeInteger(value.heartbeatCount) && value.heartbeatCount >= 0 && value.heartbeatCount <= 12
    && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 90_000
    && [null,'ECONNREFUSED','connection-error'].includes(value.errorCode)
    && (value.errorStage === null || ERROR_STAGES.has(value.errorStage))
    && ['destroyed','readableEnded','writableEnded'].every(key => typeof value[key] === 'boolean');
}

// No read/resume/data listener: preserve the stale probe's unconsumed raw shape.
export async function observeConnector(raw, phase) {
  const started = performance.now(), events = [];
  let heartbeatCount = 0, errorCode = null, errorStage = null, connected = false, done = false;
  let timer, heartbeat;
  try {
    return await new Promise(resolve => {
      function finish(outcome) {
        if (done) return; done = true;
        resolve({ outcome, events: [...events], heartbeatCount, elapsedMs: Math.max(0, Math.floor(performance.now() - started)),
          errorCode, errorStage, destroyed: raw.destroyed, readableEnded: raw.readableEnded, writableEnded: raw.writableEnded });
      }
      raw.once('connect', () => {
        if (done) return; connected = true; events.push('connect'); phase('connector-event-connect');
      });
      // Keep the error listener through the caller's owned destroy after timeout.
      raw.on('error', error => {
        if (done || events.includes('error')) return;
        errorCode = 'connection-error'; errorStage = 'unclassified';
        try {
          if (error?.code === 'ECONNREFUSED') errorCode = 'ECONNREFUSED';
          if (ERROR_STAGES.has(error?.windowsPipeStage)) errorStage = error.windowsPipeStage;
        } catch { /* Never read arbitrary error detail or serialize the Error. */ }
        events.push('error'); phase('connector-event-error');
      });
      raw.once('end', () => { if (!done) { events.push('end'); phase('connector-event-end'); } });
      raw.once('close', () => {
        if (done) return; events.push('close'); phase('connector-event-close');
        finish(connected ? 'connected' : errorCode === 'ECONNREFUSED' ? 'refused-and-closed' : 'closed-without-refusal');
      });
      heartbeat = setInterval(() => {
        if (!done && heartbeatCount < 12) { heartbeatCount++; phase('connector-heartbeat'); }
      }, 1000);
      timer = setTimeout(() => finish('observation-deadline'), 12_000);
    });
  } finally { clearTimeout(timer); clearInterval(heartbeat); }
}

export async function probePinnedConnector(load, phase, registerCleanup) {
  phase('connector-imports');
  const [channel, { brokerPaths }, { connectWindowsPipe }] = await Promise.all([
    load('lib/platform/local-channel.mjs'), load('lib/paths.mjs'), load('lib/platform/windows-pipe-client.mjs'),
  ]);
  const paths = brokerPaths();
  const context = { paths, mode: 'single-account', servers: [], connections: new Set(),
    watchers: new Map(), accountWatchers: new Map() };
  let raw;
  registerCleanup(async () => { raw?.destroy(); await channel.stop(context); });
  phase('channel-prepare');
  const owner = channel.prepare(context);
  phase('channel-prepared');
  phase('channel-stale-main');
  const mainProbe = channel.removeStaleSocket(paths.socket);
  phase('channel-stale-main-returned');
  await mainProbe;
  phase('channel-stale-main-checked');
  // Same public default label, actual prepare SID and admin path; never emitted.
  const pipe = channel.pipeNameFor(paths.admin, { sid: owner });
  phase('connector-create-admin');
  raw = connectWindowsPipe(pipe);
  phase('connector-admin-returned');
  let connectorObservation;
  try { connectorObservation = await observeConnector(raw, phase); }
  finally { raw.destroy(); }
  phase('connector-observed');
  return { ready: true, startupConnectorChecks: 3, connectorObservation };
}
