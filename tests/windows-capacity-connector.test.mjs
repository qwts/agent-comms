import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { observeConnector, probePinnedConnector, validConnectorObservation } from '../tools/acceptance/windows-capacity-connector.mjs';

function rawStream() {
  const raw = new EventEmitter();
  Object.assign(raw, { destroyed: false, readableEnded: false, writableEnded: false, destroys: 0 });
  raw.destroy = () => { raw.destroys++; raw.destroyed = true; return raw; };
  raw.resume = raw.read = () => { throw new Error('must not consume raw'); };
  return raw;
}

test('actual connector observer retains fixed refusal stage and ordered close without consuming or serializing error details', async () => {
  const raw = rawStream(), phases = [];
  const pending = observeConnector(raw, phase => phases.push(phase));
  raw.emit('error', Object.assign(new Error('CANARY-secret-body-path'), {
    code: 'ECONNREFUSED', windowsPipeStage: 'startup-timeout', cause: { secret: 'CANARY-secret' },
  }));
  raw.destroyed = true; raw.emit('close');
  const result = await pending;
  assert.equal(validConnectorObservation(result), true);
  assert.deepEqual(result.events, ['error','close']);
  assert.equal(result.outcome, 'refused-and-closed'); assert.equal(result.errorStage, 'startup-timeout');
  assert.equal(JSON.stringify({ result, phases }).includes('CANARY'), false);
  assert.equal(raw.destroys, 0, 'caller owns disposal after operation snapshot');
});

test('silent close stays distinct from a refusal and completed observation snapshot survives later cleanup events', async () => {
  const raw = rawStream(); const pending = observeConnector(raw, () => {});
  raw.destroyed = true; raw.emit('close'); const result = await pending;
  raw.emit('error', new Error('CANARY-late-error')); raw.readableEnded = true;
  assert.equal(result.outcome, 'closed-without-refusal'); assert.equal(result.errorCode, null);
  assert.deepEqual(result.events, ['close']); assert.equal(result.readableEnded, false);
  assert.equal(validConnectorObservation(result), true);
});

test('referenced twelve-second observation bounds heartbeats and keeps missing transport events explicit', async t => {
  t.mock.timers.enable({ apis: ['setInterval','setTimeout'] });
  const raw = rawStream(), phases = [];
  const pending = observeConnector(raw, (phase, progress) => phases.push({ phase, progress }));
  t.mock.timers.tick(12_000); const result = await pending;
  assert.equal(result.outcome, 'observation-deadline'); assert.deepEqual(result.events, []);
  assert.equal(result.heartbeatCount, 12); assert.equal(phases.length, 13);
  assert.equal(phases.at(-1).phase, 'connector-observation-finished');
  assert.deepEqual(phases.at(-1).progress, { heartbeatCount: 12, elapsedMs: result.elapsedMs });
  t.mock.timers.tick(30_000); assert.equal(phases.length, 13, 'no timer survives operation completion');
  assert.equal(validConnectorObservation(result), true);
});

test('fixed observation validation refuses extra private fields, arbitrary errors, duplicate events and overbounds', async () => {
  const raw = rawStream(), pending = observeConnector(raw, () => {}); raw.emit('close'); const good = await pending;
  for (const bad of [{ ...good, pipe: 'CANARY-private-pipe' }, { ...good, errorCode: 'CANARY-private-error' },
    { ...good, errorStage: 'CANARY-private-stage' }, { ...good, events: ['close','close'] },
    { ...good, heartbeatCount: 13 }, { ...good, elapsedMs: 90_001 }]) assert.equal(validConnectorObservation(bad), false);
});

test('pinned event discriminant preserves prepare/main prefix, exact pipe derivation and default actual connector arguments', async () => {
  const calls = [], phases = [], raw = rawStream(), owner = 'CANARY-private-owner';
  const paths = { socket: 'CANARY-main', admin: 'CANARY-admin' }; let cleanup, context;
  const ready = await probePinnedConnector(async name => {
    if (name === 'lib/paths.mjs') return { brokerPaths: () => paths };
    if (name === 'lib/platform/local-channel.mjs') return {
      prepare(value) { assert.ok(cleanup); context = value; assert.equal(value.paths, paths); assert.equal(value.mode, 'single-account'); calls.push('prepare'); return owner; },
      async removeStaleSocket(file) { assert.equal(file, paths.socket); calls.push('main-stale'); },
      pipeNameFor(file, options) { assert.equal(file, paths.admin); assert.deepEqual(options, { sid: owner }); calls.push('name'); return 'CANARY-private-pipe'; },
      async stop(value) { assert.equal(value, context); calls.push('stop'); },
    };
    assert.equal(name, 'lib/platform/windows-pipe-client.mjs');
    return { connectWindowsPipe(...args) {
      assert.deepEqual(args, ['CANARY-private-pipe']); calls.push('connector');
      process.nextTick(() => { raw.destroyed = true; raw.emit('close'); }); return raw;
    } };
  }, phase => phases.push(phase), dispose => { cleanup = dispose; });
  assert.deepEqual(calls, ['prepare','main-stale','name','connector']);
  assert.equal(ready.ready, true); assert.equal(ready.startupConnectorChecks, 3);
  assert.equal(ready.connectorObservation.outcome, 'closed-without-refusal'); assert.equal(raw.destroys, 1);
  assert.equal(JSON.stringify({ ready, phases }).includes('CANARY'), false);
  await cleanup(); assert.equal(calls.at(-1), 'stop'); assert.equal(raw.destroys, 2);
});


test('elapsed time beyond the evidence bound refuses with a fixed error instead of clamping a false duration', async t => {
  let clockReads = 0;
  t.mock.method(performance, 'now', () => clockReads++ === 0 ? 0 : 90_001);
  const raw = rawStream(), phases = [], pending = observeConnector(raw, value => phases.push(value));
  raw.emit('close');
  await assert.rejects(pending, { message: 'diagnostic-output-invalid' });
  assert.equal(phases.includes('connector-observation-finished'), false);
});

test('observation completion and owned destroy entry are visible before a disposal failure', async () => {
  const phases = [], raw = rawStream(); let cleanup;
  raw.destroy = () => { throw new Error('CANARY-disposal-error'); };
  await assert.rejects(probePinnedConnector(async name => {
    if (name === 'lib/paths.mjs') return { brokerPaths: () => ({ socket: 'private-main', admin: 'private-admin' }) };
    if (name === 'lib/platform/local-channel.mjs') return {
      prepare() { return 'private-sid'; }, async removeStaleSocket() {}, pipeNameFor() { return 'private-pipe'; }, async stop() {},
    };
    return { connectWindowsPipe() { process.nextTick(() => raw.emit('close')); return raw; } };
  }, (value, progress) => phases.push({ value, progress }), value => { cleanup = value; }), /CANARY-disposal-error/);
  assert.equal(typeof cleanup, 'function');
  assert.deepEqual(phases.slice(-3).map(value => value.value), ['connector-event-close','connector-observation-finished','connector-dispose-admin']);
  assert.equal(phases.some(value => value.value === 'connector-admin-disposed'), false);
  assert.equal(JSON.stringify(phases).includes('CANARY'), false);
});
