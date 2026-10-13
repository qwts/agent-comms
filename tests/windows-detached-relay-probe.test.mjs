import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCapacityController } from '../tools/acceptance/windows-capacity-control.mjs';
import { supervisorClassificationFromError, supervisorClassificationFromFailure } from '../tools/acceptance/windows-capacity-classification.mjs';
import { captureProductionWindowsRelay } from './helpers/capture-production-windows-relay.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/windows-detached-relay-probe.mjs', import.meta.url));
const supervisorPath = fileURLToPath(new URL('../tools/acceptance/windows-capacity-job.ps1', import.meta.url));
const hostComponents = JSON.parse(readFileSync(new URL('./fixtures/windows-host-components.json', import.meta.url), 'utf8'));
const pinnedNodeVersion = `v${hostComponents.node.version}`;
const jobCommitLimitBytes = 536870912;
const jobProcessLimit = 128;
// Upstream Node v24.21.0 embeds libuv 1.52.1 (deps/uv/include/uv/version.h).
// The protected Mac owner's v24.19.0 reference is not the Windows harness pin.
const pinnedLibuvVersion = '1.52.1';

test('detached relay probe uses the checked-in Node 24.21.0/libuv 1.52.1 diagnostic tuple', () => {
  assert.equal(hostComponents.node.version, '24.21.0');
  assert.equal(pinnedLibuvVersion, '1.52.1');
});

function owned(file, args, stdio, env = process.env) {
  const child = spawn(file, args, { env, stdio, windowsHide: true });
  let terminal = false;
  let stderrBytes = 0;
  child.stderr?.on('data', chunk => { stderrBytes = Math.min(65535, stderrBytes + chunk.length); });
  const exited = new Promise(resolve => {
    child.once('error', () => { terminal = true; resolve({ code: null, signal: null }); });
    child.once('exit', (code, signal) => { terminal = true; resolve({ code, signal }); });
  });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, exited, closed, terminal: () => terminal, stderrBytes: () => stderrBytes };
}

async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function capacityControl(supervisor) {
  return createCapacityController(supervisor, {
    classifyFailure(record) {
      const error = new Error('job-supervisor-failed');
      const classification = supervisorClassificationFromFailure(record);
      if (classification) Object.defineProperty(error, 'supervisorClassification', { value: classification });
      return error;
    },
  });
}

function assertWithinProbeCapacity(sample) {
  assert.ok(Number.isSafeInteger(sample.jobPeakCommitBytes) && sample.jobPeakCommitBytes >= 0);
  assert.ok(sample.jobPeakCommitBytes <= jobCommitLimitBytes);
  for (const kind of ['main', 'relay', 'diagnostic', 'compiler']) {
    assert.ok(Number.isSafeInteger(sample.totals[kind].count) && sample.totals[kind].count <= jobProcessLimit);
  }
}

async function safeRequest(control, operation, fields = {}, timeout = 5000) {
  try { return await control.request(operation, fields, timeout); }
  catch (error) {
    const classification = supervisorClassificationFromError(error);
    assert.fail(`${operation}-refused ${classification ? JSON.stringify(classification) : 'classification-unavailable'}`);
  }
}

test('DETACHED_PROCESS diagnostic probe preserves actual relay argv and remains in the private job without console host', {
  skip: process.platform !== 'win32',
  timeout: 90000,
}, async () => {
  assert.equal(process.version, pinnedNodeVersion, 'Windows diagnostic must use the checked-in Node sidecar tuple');
  assert.equal(process.versions.uv, pinnedLibuvVersion, 'Windows diagnostic must use the checked-in Node sidecar tuple');
  // This test is diagnostic-only: it uses the production connector and worker,
  // but only connects to a local byte-draining pipe server. It does not start
  // either communications application or change production spawn options.
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { args: relayArgs } = captureProductionWindowsRelay();
  const pipe = `\\\\.\\pipe\\agent-comms.detached-probe.${process.pid}.${Date.now()}`;
  const fixtureArgs = [fixturePath, pipe];
  const fixture = owned(process.execPath, fixtureArgs, ['ignore', 'ignore', 'pipe', 'ipc']);
  const fixtureControl = createCapacityController(fixture, { ipc: true });
  const supervisor = owned(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', supervisorPath], ['pipe', 'pipe', 'pipe']);
  const control = capacityControl(supervisor);
  const start = Date.now();
  const remaining = () => Math.max(1, 60000 - (Date.now() - start));
  try {
    assert.equal((await within(fixtureControl.startup, remaining(), 'fixture-startup-deadline')).ready, true);
    assert.equal((await within(control.startup, remaining(), 'supervisor-startup-deadline')).phase, 'ready');
    const attached = await safeRequest(control, 'attach', {
      pid: fixture.child.pid,
      parentPid: process.pid,
      nodeExecutable: realpathSync(process.execPath),
      shellExecutable: shell,
      fixtureArgs,
      relayArgs,
      diagnosticArgs: [],
      compilerExecutables: [],
      compilerTemp: realpathSync(process.env.TEMP),
      commitLimitBytes: jobCommitLimitBytes,
    }, remaining());
    assert.equal(attached.attached, true);

    const initial = await safeRequest(control, 'sample', {}, remaining());
    assertWithinProbeCapacity(initial);
    assert.equal(initial.totals.main.count, 1);
    for (const kind of ['relay', 'diagnostic', 'compiler']) assert.equal(initial.totals[kind].count, 0);
    assert.equal((await safeRequest(control, 'members', {}, remaining())).activeMembers, 1);

    const connected = await fixtureControl.request('start', { expectedRelayArgs: relayArgs }, remaining());
    assert.deepEqual(connected, {
      id: connected.id, connected: true, detached: true, windowsHide: true,
      stdioPipes: true, productionArgsExact: true,
    });
    const members = await safeRequest(control, 'members', {}, remaining());
    assert.equal(members.activeMembers, 2, 'fixture and one relay must be the only job members');
    const withRelay = await safeRequest(control, 'sample', {}, remaining());
    assertWithinProbeCapacity(withRelay);
    assert.equal(withRelay.totals.main.count, 1);
    assert.equal(withRelay.totals.relay.count, 1);
    for (const kind of ['diagnostic', 'compiler']) assert.equal(withRelay.totals[kind].count, 0);

    const stopped = await fixtureControl.request('stop', {}, remaining());
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.exitCode, 0);
    assert.equal(stopped.signal, null);
    assert.equal(stopped.serverClosed, true);
    assert.equal(stopped.rawReadableEnded, true);
    assert.equal(stopped.rawWritableEnded, true);
    assert.equal((await safeRequest(control, 'members', {}, remaining())).activeMembers, 1);
    const afterRelay = await safeRequest(control, 'sample', {}, remaining());
    assertWithinProbeCapacity(afterRelay);
    assert.equal(afterRelay.totals.main.count, 1);
    for (const kind of ['relay', 'diagnostic', 'compiler']) assert.equal(afterRelay.totals[kind].count, 0);

    assert.equal((await fixtureControl.request('shutdown', {}, 5000)).shutdown, true);
    assert.equal((await within(fixture.exited, 5000, 'fixture-exit-deadline')).code, 0);
    await within(fixture.closed, 5000, 'fixture-close-deadline');
    assert.equal(fixture.stderrBytes(), 0);
    assert.equal((await safeRequest(control, 'members', {}, remaining())).activeMembers, 0);
    const closed = await safeRequest(control, 'close', {}, remaining());
    assert.deepEqual(Object.keys(closed).sort(), [
      'id', 'ok', 'closed', 'jobEmptyConfirmed', 'finalJobCpu100ns', 'peakJobCommitBytes',
    ].sort());
    assert.ok(Number.isSafeInteger(closed.id) && closed.id > 0);
    assert.equal(closed.ok, true);
    assert.equal(closed.closed, true);
    assert.equal(closed.jobEmptyConfirmed, true);
    assert.ok(Number.isSafeInteger(closed.finalJobCpu100ns) && closed.finalJobCpu100ns >= 0);
    assert.ok(Number.isSafeInteger(closed.peakJobCommitBytes) && closed.peakJobCommitBytes <= jobCommitLimitBytes);
    assert.equal((await within(supervisor.exited, 5000, 'supervisor-exit-deadline')).code, 0);
    await within(supervisor.closed, 5000, 'supervisor-close-deadline');
    assert.equal(supervisor.stderrBytes(), 0);
  } finally {
    // Cleanup is limited to the two directly-owned harness children. The job
    // owns the fixture and relay descendants and closes with the supervisor.
    for (const child of [supervisor, fixture]) if (!child.terminal()) child.child.kill();
    await Promise.all([supervisor, fixture].map(async child => {
      await within(child.exited, 5000, 'owned-child-exit-unconfirmed');
      await within(child.closed, 5000, 'owned-child-close-unconfirmed');
    }));
  }
});
