import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createCapacityController, snapshotCapacityPhases } from '../tools/acceptance/windows-capacity-control.mjs';
import { retainCapacityFailure } from '../tools/acceptance/windows-capacity-lifecycle.mjs';
import { capacityTimingMode, capacityTimingProfile, createCapacityPhaseTiming, elapsedCapacityTiming, timeCapacityRequest } from '../tools/acceptance/windows-capacity-timing.mjs';

function fixture() {
  const child = new EventEmitter(); child.send = () => {};
  let close;
  const owned = { child, exited: new Promise(resolve => { close = resolve; }), terminal: () => false };
  return { child, close, control: createCapacityController(owned, { ipc: true, capturePhaseTimings: true }) };
}
test('timing observes the actual request result or original failure without clamping invalid duration', async () => {
  for (const duration of [0, 90_001, 120_000, 120_001, -1, Infinity, NaN]) {
    let timing, tick = 0;
    const now = () => tick++ === 0 ? 10 : 10 + duration;
    const expected = elapsedCapacityTiming(duration);
    const original = new Error('CANARY-original-body');
    await assert.rejects(timeCapacityRequest(() => Promise.reject(original), value => { timing = value; }, now), error => error === original);
    assert.deepEqual(timing, expected);
    assert.equal(JSON.stringify(timing).includes('CANARY'), false);
    tick = 0;
    assert.equal(await timeCapacityRequest(async () => 'ack', value => { timing = value; }, now), 'ack');
    assert.deepEqual(timing, expected);
  }
  const times = [50, 50.9, 170_051];
  const phase = createCapacityPhaseTiming(() => times.shift());
  assert.deepEqual(phase(), { phaseElapsedMs: 0 });
  assert.deepEqual(phase(), { phaseTimingUnavailable: true });
});
test('candidate phase timing keeps order and ties, privately snapshots failure before cleanup and retains unavailable observations', async () => {
  const f = fixture();
  for (const row of [{ phase: 'channel-imports', phaseElapsedMs: 0 },
    { phase: 'channel-prepare', phaseElapsedMs: 0 },
    { phase: 'channel-prepared', phaseTimingUnavailable: true },
    { phase: 'channel-stale-main', phaseElapsedMs: 120_000 }]) f.child.emit('message', { id: -1, ...row });
  const expected = [{ phase: 'channel-imports', elapsedMs: 0 }, { phase: 'channel-prepare', elapsedMs: 0 },
    { phase: 'channel-prepared', timingUnavailable: true }, { phase: 'channel-stale-main', elapsedMs: 120_000 }];
  assert.deepEqual(f.control.state().phaseTimings, expected);
  f.control.state().phaseTimings[0].elapsedMs = 999;
  const snapshot = snapshotCapacityPhases({ state: () => ({ phase: 'private-job-assigned' }) }, f.control);
  f.child.emit('message', { id: -1, phase: 'channel-stale-main-returned', phaseElapsedMs: 120_000 });
  assert.deepEqual(snapshot.phaseTimings, expected);
  const original = { stage: 'channel-prepare-and-stale-probes', check: 'control-deadline', controlTiming: { timingUnavailable: true }, ...snapshot };
  const retained = retainCapacityFailure(original, { revision: 'candidate', preflight: 'channel', fixturePhase: snapshot.fixturePhase }, {});
  original.phaseTimings[0].elapsedMs = 999;
  original.controlTiming.timingUnavailable = false;
  assert.deepEqual(retained.phaseTimings, expected);
  assert.deepEqual(retained.controlTiming, { timingUnavailable: true });
  assert.equal(retained.check, 'control-deadline'); assert.equal(retained.preflight, 'channel');
  f.close();
});
test('candidate timing refuses malformed, out-of-range, regressing, missing or private phase metadata', async () => {
  for (const fields of [{ phaseElapsedMs: -1 }, { phaseElapsedMs: Infinity }, { phaseElapsedMs: NaN },
    { phaseElapsedMs: '2' }, { phaseElapsedMs: 120_001 }, { phaseElapsedMs: 1.2 }, {},
    { phaseTimingUnavailable: false }, { phaseElapsedMs: 3, phaseTimingUnavailable: true },
    { phaseElapsedMs: 3, path: 'CANARY-private' }, { phaseElapsedMs: 1 }]) {
    const f = fixture();
    f.child.emit('message', { id: -1, phase: 'channel-imports', phaseElapsedMs: 2 });
    f.child.emit('message', { id: -1, phase: 'channel-prepare', ...fields });
    await assert.rejects(f.control.startup, { message: 'control-invalid' });
    assert.deepEqual(f.control.state().phaseTimings, [{ phase: 'channel-imports', elapsedMs: 2 }]);
    assert.equal(JSON.stringify(f.control.state()).includes('CANARY'), false); f.close();
  }
});
test('candidate timeline bound stops a live pending request at the sixty-fifth phase', async () => {
  const f = fixture(); f.child.emit('message', { id: 0, paused: true }); await f.control.startup;
  const request = f.control.request('start');
  for (let i = 0; i < 64; i++) f.child.emit('message', { id: -1, phase: 'channel-imports', phaseElapsedMs: i });
  assert.equal(f.control.state().phaseTimings.length, 64);
  f.child.emit('message', { id: -1, phase: 'channel-prepare', phaseElapsedMs: 64 });
  await assert.rejects(request, { message: 'control-invalid' });
  assert.equal(f.control.state().phaseTimings.length, 64); f.close();
});
test('old and new controls keep the original untimed IPC schema', async () => {
  const child = new EventEmitter(); child.send = () => {};
  let close;
  const control = createCapacityController({ child, exited: new Promise(resolve => { close = resolve; }), terminal: () => false }, { ipc: true });
  child.emit('message', { id: -1, phase: 'channel-imports' });
  assert.equal(control.state().phaseTimings, undefined);
  child.emit('message', { id: -1, phase: 'channel-prepare', phaseElapsedMs: 1 });
  await assert.rejects(control.startup, { message: 'control-invalid' }); close();
});
test('failure retention refuses arbitrary timing payloads instead of serializing them', () => {
  const retained = retainCapacityFailure({ stage: 'production-startup', check: 'control-deadline',
    controlTiming: { elapsedMs: 3, path: 'CANARY-private' },
    phaseTimings: [{ phase: 'channel-imports', elapsedMs: 1 }, { phase: 'channel-prepare', elapsedMs: 0 }] }, {}, {});
  assert.equal(retained.controlTiming, undefined); assert.equal(retained.phaseTimings, undefined);
  assert.equal(JSON.stringify(retained).includes('CANARY'), false);
});


test('only the fixed candidate channel receives 180/240; startup, storage and both baselines retain 90/120', () => {
  const channel = capacityTimingMode('candidate', 'channel');
  assert.deepEqual(capacityTimingProfile(channel), { mode: 'candidate-channel', requestDeadlineMs: 180_000, timingCapMs: 240_000 });
  assert.throws(() => { capacityTimingProfile(channel).timingCapMs = 999_999; }, TypeError);
  for (const revision of ['old', 'new', 'candidate']) {
    for (const preflight of ['normal','candidate-startup','storage','channel']) {
      if (revision === 'candidate' && preflight === 'channel') continue;
      assert.deepEqual(capacityTimingProfile(capacityTimingMode(revision, preflight)), { mode: 'default', requestDeadlineMs: 90_000, timingCapMs: 120_000 });
    }
  }
  for (const mode of ['CANARY-private', '__proto__', 240_000, { timingCapMs: 999_999 }]) {
    assert.throws(() => capacityTimingProfile(mode), { message: 'control-invalid' });
  }
});
test('channel timing remains finite/unavailable without clamping or overwriting the original operation failure', async () => {
  for (const elapsed of [180_001, 240_000, 240_001, Infinity, -1]) {
    const mode = 'candidate-channel', original = new Error('control-deadline');
    let timing, tick = 0;
    await assert.rejects(timeCapacityRequest(() => Promise.reject(original), value => { timing = value; },
      () => tick++ ? elapsed : 0, mode), error => error === original);
    assert.deepEqual(timing, elapsedCapacityTiming(elapsed, mode));
    const report = retainCapacityFailure({ stage: 'channel-prepare-and-stale-probes', check: original.message, controlTiming: timing },
      { revision: 'candidate', preflight: 'channel' }, {});
    assert.deepEqual(report.controlTiming, timing); assert.equal(report.check, 'control-deadline');
    assert.equal(report.timingProfile.timingCapMs, 240_000);
  }
  assert.deepEqual(elapsedCapacityTiming(180_001), { timingUnavailable: true });
  const ticks = [0, 240_001], phase = createCapacityPhaseTiming(() => ticks.shift(), 'candidate-channel');
  assert.deepEqual(phase(), { phaseTimingUnavailable: true });
});
test('trusted channel controller accepts bounded larger timing, snapshots it and refuses IPC cap negotiation', async () => {
  const child = new EventEmitter(); child.send = () => {}; let close;
  const control = createCapacityController({ child, exited: new Promise(resolve => { close = resolve; }), terminal: () => false },
    { ipc: true, capturePhaseTimings: true, timingMode: 'candidate-channel' });
  child.emit('message', { id: -1, phase: 'channel-imports', phaseElapsedMs: 180_001 });
  child.emit('message', { id: -1, phase: 'channel-ready', phaseElapsedMs: 240_000 });
  const snapshot = snapshotCapacityPhases({ state: () => ({ phase: 'private-job-assigned' }) }, control);
  assert.deepEqual(snapshot.phaseTimings, [{ phase: 'channel-imports', elapsedMs: 180_001 }, { phase: 'channel-ready', elapsedMs: 240_000 }]);
  const failure = retainCapacityFailure({ stage: 'channel-stop', check: 'control-closed', ...snapshot },
    { revision: 'candidate', preflight: 'channel' }, {});
  assert.deepEqual(failure.phaseTimings, snapshot.phaseTimings);
  assert.equal(retainCapacityFailure({ stage: 'production-startup', check: 'control-closed', ...snapshot },
    { revision: 'old', preflight: 'channel' }, {}).phaseTimings, undefined);
  child.emit('message', { id: -1, phase: 'channel-ready', phaseElapsedMs: 240_000, timingCapMs: 999_999 });
  await assert.rejects(control.startup, { message: 'control-invalid' }); close();
});
