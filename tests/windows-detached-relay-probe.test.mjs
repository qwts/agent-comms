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
const AWAIT_STAGES = new Set([
  'fixture-startup', 'supervisor-startup', 'supervisor-attach', 'initial-sample', 'initial-members',
  'fixture-start', 'relay-members', 'relay-sample', 'fixture-stop', 'post-stop-members',
  'after-relay-sample', 'fixture-shutdown', 'fixture-exit', 'fixture-close', 'post-fixture-members',
  'supervisor-close', 'supervisor-exit', 'supervisor-close-event', 'owned-cleanup',
]);
const FIXTURE_STAGES = [
  'fixture-start-requested', 'pipe-listening', 'spawn-request-validated', 'relay-process-spawned',
  'relay-connected', 'relay-stop-requested', 'relay-natural-exit', 'relay-stdio-closed',
  'raw-eof', 'pipe-server-closed', 'fixture-shutdown-requested', 'fixture-shutdown-complete',
];
const SUPERVISOR_PHASES = new Set([
  'bootstrap-ready', 'script-entry', 'compile-supervisor', 'supervisor-compiled', 'module-observation',
  'import-utility', 'utility-imported', 'serialize-ready', 'ready-serialized', 'control-read', 'parse-control',
  'control-parsed', 'cim-module-observation', 'verify-fixture-existence', 'verify-fixture-parent',
  'verify-fixture-executable', 'parse-fixture-command', 'verify-fixture-argument-count',
  'verify-fixture-arguments', 'convert-fixture-creation', 'verify-job-limit', 'cim-module-refused',
  'import-cim', 'cim-imported', 'query-fixture', 'fixture-queried', 'create-private-job',
  'private-job-assigned', 'read-control', 'verify-fixture', 'assign-private-job', 'sample-job',
  'sample-ids-read', 'sample-filter', 'sample-query', 'sample-rows', 'sample-verify', 'sample-classify',
  'sample-observer', 'sample-observer-read', 'sample-reply', 'sample-replied', 'query-members', 'close-job',
]);
const SUPERVISOR_CHECKS = new Set([
  'argv-parse', 'executable', 'compiler-parent', 'compiler-arguments', 'compiler-response', 'owned-parent',
  'argv-count', 'argv-equality', 'pid-reuse', 'history-bound', 'kind-bound',
]);
const FAILURE_CLASSES = new Set([
  'assertion-failed', 'control-deadline', 'control-closed', 'control-invalid', 'job-supervisor-failed',
  'fixture-startup-deadline', 'supervisor-startup-deadline', 'fixture-exit-deadline',
  'fixture-close-deadline', 'supervisor-exit-deadline', 'supervisor-close-deadline',
  'owned-child-exit-unconfirmed', 'owned-child-close-unconfirmed', 'probe-request-failed',
  'probe-operation-failed', 'other-failure',
]);
const CLEANUP_FAILURES = new Set([
  'none', 'owned-terminal-unconfirmed', 'owned-close-unconfirmed',
  'owned-terminal-and-close-unconfirmed', 'kill-request-failed',
  'kill-request-and-owned-terminal-unconfirmed', 'kill-request-and-owned-close-unconfirmed',
  'kill-request-and-owned-terminal-and-close-unconfirmed', 'cleanup-observation-failed',
]);

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

function projectProbeFailure({ awaitStage, fixtureStage, supervisorPhase, supervisorCheck, errorClass }) {
  return {
    awaitStage: AWAIT_STAGES.has(awaitStage) ? awaitStage : 'unknown',
    fixtureStage: FIXTURE_STAGES.includes(fixtureStage) ? fixtureStage : 'unknown',
    supervisorPhase: SUPERVISOR_PHASES.has(supervisorPhase) ? supervisorPhase : 'unknown',
    supervisorCheck: SUPERVISOR_CHECKS.has(supervisorCheck) ? supervisorCheck : 'unknown',
    errorClass: FAILURE_CLASSES.has(errorClass) ? errorClass : 'other-failure',
  };
}

function projectOwnedChildCleanup(value) {
  return {
    spawned: value?.spawned === true,
    terminalConfirmed: value?.terminalConfirmed === true,
    closeConfirmed: value?.closeConfirmed === true,
  };
}

function projectCombinedProbeFailure(primary, cleanup) {
  return {
    primary: primary === null ? null : projectProbeFailure(primary),
    cleanupFailure: CLEANUP_FAILURES.has(cleanup?.failure) ? cleanup.failure : 'cleanup-observation-failed',
    ownedChildren: {
      fixture: projectOwnedChildCleanup(cleanup?.ownedChildren?.fixture),
      supervisor: projectOwnedChildCleanup(cleanup?.ownedChildren?.supervisor),
    },
  };
}

function safeErrorClass(error) {
  if (error?.code === 'ERR_ASSERTION') return 'assertion-failed';
  return FAILURE_CLASSES.has(error?.message) ? error.message : 'other-failure';
}

async function safeRequest(control, operation, fields = {}, timeout = 5000) {
  try { return await control.request(operation, fields, timeout); }
  catch (error) {
    const classification = supervisorClassificationFromError(error);
    lastSupervisorCheck = SUPERVISOR_CHECKS.has(classification?.check) ? classification.check : 'unknown';
    lastSupervisorFailureClass = safeErrorClass(error);
    throw new Error('probe-request-failed');
  }
}

let lastSupervisorCheck = 'unknown';
let lastSupervisorFailureClass = 'other-failure';

test('detached relay failure projection keeps only fixed await, fixture, supervisor and error classes', () => {
  assert.deepEqual(projectProbeFailure({
    awaitStage: 'relay-sample', fixtureStage: 'relay-connected', supervisorPhase: 'sample-classify',
    supervisorCheck: 'executable', errorClass: 'control-deadline',
  }), {
    awaitStage: 'relay-sample', fixtureStage: 'relay-connected', supervisorPhase: 'sample-classify',
    supervisorCheck: 'executable', errorClass: 'control-deadline',
  });
  assert.deepEqual(projectProbeFailure({
    awaitStage: 'private path secret', fixtureStage: 'handle-0xDEADBEEF', supervisorPhase: 'unknown-phase',
    supervisorCheck: 'private-command-line', errorClass: 'secret exception text',
  }), {
    awaitStage: 'unknown', fixtureStage: 'unknown', supervisorPhase: 'unknown',
    supervisorCheck: 'unknown', errorClass: 'other-failure',
  });
});

test('combined primary and cleanup failure projection preserves only owned resolution booleans', () => {
  const primary = {
    awaitStage: 'relay-sample', fixtureStage: 'relay-connected', supervisorPhase: 'sample-classify',
    supervisorCheck: 'executable', errorClass: 'control-deadline',
  };
  const combined = projectCombinedProbeFailure(primary, {
    failure: 'owned-terminal-and-close-unconfirmed',
    ownedChildren: {
      fixture: { spawned: true, terminalConfirmed: true, closeConfirmed: false, pid: 123, path: 'CANARY-path' },
      supervisor: { spawned: true, terminalConfirmed: false, closeConfirmed: false, handle: 'CANARY-handle' },
    },
    message: 'CANARY-error',
  });
  assert.deepEqual(combined, {
    primary: {
      awaitStage: 'relay-sample', fixtureStage: 'relay-connected', supervisorPhase: 'sample-classify',
      supervisorCheck: 'executable', errorClass: 'control-deadline',
    },
    cleanupFailure: 'owned-terminal-and-close-unconfirmed',
    ownedChildren: {
      fixture: { spawned: true, terminalConfirmed: true, closeConfirmed: false },
      supervisor: { spawned: true, terminalConfirmed: false, closeConfirmed: false },
    },
  });
  assert.doesNotMatch(JSON.stringify(combined), /CANARY|123/);
});

test('DETACHED_PROCESS diagnostic probe preserves actual relay argv and remains in the private job without console host', {
  skip: process.platform !== 'win32',
  timeout: 90000,
}, async () => {
  assert.equal(process.version, pinnedNodeVersion, 'Windows diagnostic must use the checked-in Node sidecar tuple');
  assert.equal(process.versions.uv, pinnedLibuvVersion, 'Windows diagnostic must use the checked-in Node sidecar tuple');
  // This test is diagnostic-only: it uses the production connector and worker,
  // but only connects to a local byte-draining pipe server. It does not start
  // either communications application or change production spawn options.
  let shell, relayArgs, fixture, fixtureControl, supervisor, control;
  const start = Date.now();
  const remaining = () => Math.max(1, 60000 - (Date.now() - start));
  let awaitStage = 'fixture-startup';
  let fixtureStage = 'unknown';
  let fixtureStageInvalid = false;
  let fixtureStageIndex = -1;
  let fixtureStageCount = 0;
  let primaryFailure;
  const cleanup = {
    failure: 'none',
    ownedChildren: {
      fixture: { spawned: false, terminalConfirmed: false, closeConfirmed: false },
      supervisor: { spawned: false, terminalConfirmed: false, closeConfirmed: false },
    },
  };
  try {
    shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    relayArgs = captureProductionWindowsRelay().args;
    const pipe = `\\\\.\\pipe\\agent-comms.detached-probe.${process.pid}.${Date.now()}`;
    const fixtureArgs = [fixturePath, pipe];
    fixture = owned(process.execPath, fixtureArgs, ['ignore', 'ignore', 'pipe', 'ipc']);
    fixture.child.on('message', record => {
      if (!record || record.id !== -2) return;
      const keys = record && typeof record === 'object' && !Array.isArray(record) ? Object.keys(record).sort().join(',') : '';
      const index = FIXTURE_STAGES.indexOf(record.stage);
      if (keys !== 'id,stage' || index < 0 || index <= fixtureStageIndex || ++fixtureStageCount > FIXTURE_STAGES.length) {
        fixtureStageInvalid = true;
        return;
      }
      fixtureStageIndex = index;
      fixtureStage = record.stage;
    });
    fixtureControl = createCapacityController(fixture, { ipc: true });
    supervisor = owned(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', supervisorPath], ['pipe', 'pipe', 'pipe']);
    control = capacityControl(supervisor);
    awaitStage = 'fixture-startup';
    assert.equal((await within(fixtureControl.startup, remaining(), 'fixture-startup-deadline')).ready, true);
    awaitStage = 'supervisor-startup';
    assert.equal((await within(control.startup, remaining(), 'supervisor-startup-deadline')).phase, 'ready');
    awaitStage = 'supervisor-attach';
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

    awaitStage = 'initial-sample';
    const initial = await safeRequest(control, 'sample', {}, remaining());
    assertWithinProbeCapacity(initial);
    assert.equal(initial.totals.main.count, 1);
    for (const kind of ['relay', 'diagnostic', 'compiler']) assert.equal(initial.totals[kind].count, 0);
    awaitStage = 'initial-members';
    assert.equal((await safeRequest(control, 'members', {}, remaining())).activeMembers, 1);

    awaitStage = 'fixture-start';
    const connected = await fixtureControl.request('start', { expectedRelayArgs: relayArgs }, remaining());
    assert.deepEqual(connected, {
      id: connected.id, connected: true, detached: true, windowsHide: true,
      stdioPipes: true, productionArgsExact: true,
    });
    awaitStage = 'relay-members';
    const members = await safeRequest(control, 'members', {}, remaining());
    assert.equal(members.activeMembers, 2, 'fixture and one relay must be the only job members');
    awaitStage = 'relay-sample';
    const withRelay = await safeRequest(control, 'sample', {}, remaining());
    assertWithinProbeCapacity(withRelay);
    assert.equal(withRelay.totals.main.count, 1);
    assert.equal(withRelay.totals.relay.count, 1);
    for (const kind of ['diagnostic', 'compiler']) assert.equal(withRelay.totals[kind].count, 0);

    awaitStage = 'fixture-stop';
    const stopped = await fixtureControl.request('stop', {}, remaining());
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.exitCode, 0);
    assert.equal(stopped.signal, null);
    assert.equal(stopped.serverClosed, true);
    assert.equal(stopped.rawReadableEnded, true);
    assert.equal(stopped.rawWritableEnded, true);
    awaitStage = 'post-stop-members';
    assert.equal((await safeRequest(control, 'members', {}, remaining())).activeMembers, 1);
    awaitStage = 'after-relay-sample';
    const afterRelay = await safeRequest(control, 'sample', {}, remaining());
    assertWithinProbeCapacity(afterRelay);
    assert.equal(afterRelay.totals.main.count, 1);
    for (const kind of ['relay', 'diagnostic', 'compiler']) assert.equal(afterRelay.totals[kind].count, 0);

    awaitStage = 'fixture-shutdown';
    assert.equal((await fixtureControl.request('shutdown', {}, 5000)).shutdown, true);
    awaitStage = 'fixture-exit';
    assert.equal((await within(fixture.exited, 5000, 'fixture-exit-deadline')).code, 0);
    awaitStage = 'fixture-close';
    await within(fixture.closed, 5000, 'fixture-close-deadline');
    assert.equal(fixture.stderrBytes(), 0);
    awaitStage = 'post-fixture-members';
    assert.equal((await safeRequest(control, 'members', {}, remaining())).activeMembers, 0);
    awaitStage = 'supervisor-close';
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
    awaitStage = 'supervisor-exit';
    assert.equal((await within(supervisor.exited, 5000, 'supervisor-exit-deadline')).code, 0);
    awaitStage = 'supervisor-close-event';
    await within(supervisor.closed, 5000, 'supervisor-close-deadline');
    assert.equal(supervisor.stderrBytes(), 0);
    assert.equal(fixtureStageInvalid, false);
    assert.deepEqual(FIXTURE_STAGES.slice(0, fixtureStageCount), FIXTURE_STAGES);
  } catch (error) {
    const supervisorPhase = control?.state().phase;
    primaryFailure = {
      awaitStage, fixtureStage, supervisorPhase, supervisorCheck: lastSupervisorCheck,
      errorClass: error?.message === 'probe-request-failed' ? lastSupervisorFailureClass : safeErrorClass(error),
    };
  } finally {
    awaitStage = 'owned-cleanup';
    // Cleanup is limited to the two directly-owned harness children. The job
    // owns the fixture and relay descendants and closes with the supervisor.
    const children = [
      ['supervisor', supervisor], ['fixture', fixture],
    ].filter(([, child]) => Boolean(child));
    let killRequestFailed = false;
    let terminalUnconfirmed = false;
    let closeUnconfirmed = false;
    let observationFailed = false;
    for (const [name, child] of children) {
      cleanup.ownedChildren[name].spawned = Number.isSafeInteger(child.child.pid) && child.child.pid > 0;
      try { if (!child.terminal()) child.child.kill(); }
      catch { killRequestFailed = true; }
    }
    await Promise.all(children.map(async ([name, child]) => {
      const evidence = cleanup.ownedChildren[name];
      try {
        await within(child.exited, 5000, 'owned-child-exit-unconfirmed');
        evidence.terminalConfirmed = true;
      } catch (error) {
        if (error?.message === 'owned-child-exit-unconfirmed') terminalUnconfirmed = true;
        else observationFailed = true;
      }
      try {
        await within(child.closed, 5000, 'owned-child-close-unconfirmed');
        evidence.closeConfirmed = true;
      } catch (error) {
        if (error?.message === 'owned-child-close-unconfirmed') closeUnconfirmed = true;
        else observationFailed = true;
      }
    }));
    if (observationFailed) cleanup.failure = 'cleanup-observation-failed';
    else if (killRequestFailed && terminalUnconfirmed && closeUnconfirmed) cleanup.failure = 'kill-request-and-owned-terminal-and-close-unconfirmed';
    else if (killRequestFailed && terminalUnconfirmed) cleanup.failure = 'kill-request-and-owned-terminal-unconfirmed';
    else if (killRequestFailed && closeUnconfirmed) cleanup.failure = 'kill-request-and-owned-close-unconfirmed';
    else if (killRequestFailed) cleanup.failure = 'kill-request-failed';
    else if (terminalUnconfirmed && closeUnconfirmed) cleanup.failure = 'owned-terminal-and-close-unconfirmed';
    else if (terminalUnconfirmed) cleanup.failure = 'owned-terminal-unconfirmed';
    else if (closeUnconfirmed) cleanup.failure = 'owned-close-unconfirmed';
  }
  if (primaryFailure || cleanup.failure !== 'none') {
    const detail = projectCombinedProbeFailure(primaryFailure, cleanup);
    throw new Error(`detached-probe-failed ${JSON.stringify(detail)}`);
  }
});
