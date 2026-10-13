// Opt-in standard-user Windows capacity pilot. Never imported by production.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { admissionStage, RATES } from './windows-capacity-policy.mjs';
import { projectWindowsPipeStage } from '../../lib/platform/windows-pipe-stage.mjs';
import { connectWindowsPipe } from '../../lib/platform/windows-pipe-client.mjs';
import { supervisorClassificationFromError, supervisorClassificationFromFailure } from './windows-capacity-classification.mjs';
import { captureCompilerPrefix, compilerControlArgs, observeCompilerControl, projectCompilerObservation, collectCompilerControls, sampleCompilerControl, COMPILER_SOURCE, COMPILER_DEADLINE_MS } from './windows-capacity-compiler.mjs';
import { collectSupervisorProbes, createCapacityController, encodingSignature, FIXTURE_PHASES, snapshotCapacityPhases } from './windows-capacity-control.mjs';

import { capacityTimingMode, capacityTimingProfile, createCapacityPhaseTiming, timeCapacityRequest } from './windows-capacity-timing.mjs';

import { cleanupCapacityRun, retainCapacityFailure } from './windows-capacity-lifecycle.mjs';

import { probePinnedStorage } from './windows-capacity-storage.mjs';
import { probePinnedCustody } from './windows-capacity-custody.mjs';
import { probePinnedChannel } from './windows-capacity-channel.mjs';
import { probePinnedConnector, validConnectorObservation } from './windows-capacity-connector.mjs';
import { readOwnedDesktopContext, isOwnedDesktopContext } from './windows-desktop-context.mjs';
import { CORRECTED_STARTUP_SOURCE, canonicalCandidateArchiveArgs, verifyCandidateComponent, verifyCorrectedStartupSource, boundedBrokerCode, classifyFixtureFailure } from './windows-corrected-startup.mjs';

const exec = promisify(execFile), SELF = fileURLToPath(import.meta.url);
const JOB = fileURLToPath(new URL('./windows-capacity-job.ps1', import.meta.url));
const PINS = { old: '25dfa8362401489503f704c7322ad1314b7e6ddb', new: 'e648d71277da72fc50c70ebcbb94c3c8f53c7cf3' };
const CANARY = 'CANARY-windows-capacity-body-secret';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let desktopContext;
const scratchParent = () => desktopContext?.root ?? process.env.LOCALAPPDATA;
const childTemp = () => desktopContext?.temp ?? process.env.TEMP;
let output, activeStage = 'arguments', fixtureCleanup, fixtureRequestId;
const supervisorPhases = new Set(['script-entry','compile-supervisor','supervisor-compiled','module-observation','import-utility','utility-imported','serialize-ready','ready-serialized','control-read','parse-control','control-parsed','cim-module-observation','verify-fixture-existence','verify-fixture-parent','verify-fixture-executable','parse-fixture-command','verify-fixture-argument-count','verify-fixture-arguments','convert-fixture-creation','verify-job-limit','cim-module-refused','import-cim','cim-imported','query-fixture','fixture-queried','create-private-job','private-job-assigned','read-control','verify-fixture','assign-private-job','sample-job','sample-ids-read','sample-filter','sample-query','sample-rows','sample-verify','sample-classify','sample-observer','sample-observer-read','sample-reply','sample-replied','query-members','close-job']);
const checks = new Set(['fixture-terminal', 'fixture-deadline', 'control-deadline', 'control-closed',
  'control-output-bound', 'control-invalid', 'job-supervisor-failed', 'natural-exit-unconfirmed',
  'relay-exit-unconfirmed', 'scratch-retained', 'job-exit-unconfirmed', 'diagnostic-output-invalid',
  'compiler-source-mismatch', 'compiler-control-failed', 'compiler-deadline', 'compiler-terminal', 'owned-startup-fault', 'owned-forced-cleanup', 'policy-failed', 'memory-headroom-insufficient', 'candidate-source-mismatch', 'operation-failed', 'assertion-failed', 'timing-unavailable']);
function failure(error) {
  const windowsPipeStage = projectWindowsPipeStage(error);
  const supervisorClassification = supervisorClassificationFromError(error);
  return { stage: activeStage, check: checks.has(error?.message) ? error.message : error?.code === 'ERR_ASSERTION' ? 'assertion-failed' : 'operation-failed',
    ...(boundedBrokerCode(error?.brokerCode ?? error?.code) ? { brokerCode: boundedBrokerCode(error.brokerCode ?? error.code) } : {}),
    ...(windowsPipeStage === undefined ? {} : { windowsPipeStage }),
    ...(supervisorPhases.has(error?.supervisorPhase) ? { supervisorPhase: error.supervisorPhase } : {}),
    ...(supervisorClassification ? {supervisorClassification} : {}) };
}
function supervisorFailure(record) {
  const error = new Error('job-supervisor-failed');
  if (supervisorPhases.has(record?.failure?.phase)) error.supervisorPhase = record.failure.phase;
  const classification = supervisorClassificationFromFailure(record);
  if (classification) Object.defineProperty(error,'supervisorClassification',{value:classification});
  return error;
}
async function deadline(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}
function environment(extra = {}) {
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'userprofile', 'localappdata', 'appdata',
    'temp', 'tmp', 'username', 'userdomain', 'userdnsdomain', 'processor_architecture', 'programdata',
    'programfiles', 'programfiles(x86)', 'commonprogramfiles', 'commonprogramfiles(x86)']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase()))), ...(desktopContext ? { TEMP: desktopContext.temp, TMP: desktopContext.temp } : {}), ...extra };
}
function ownedChild(file, args, options) {
  const child = spawn(file, args, options);
  let terminal = false;
  const exited = new Promise((resolve) => {
    child.once('error', () => { if (!child.pid) { terminal = true; resolve({ code: null, signal: null }); } });
    child.once('exit', (code, signal) => { terminal = true; resolve({ code, signal }); });
  });
  const stdioClosed = new Promise((resolve) => child.once('close', resolve));
  return { child, exited, stdioClosed, terminal: () => terminal };
}

async function compilerFixture(source, variant) {
  assert.ok(['implicit','explicit'].includes(variant));
  process.send({ id: 0, paused: true });
  const start = await new Promise(resolve => process.once('message', resolve));
  assert.equal(start.op, 'start'); fixtureRequestId = start.id;
  // Assignment to the private job precedes this pinned import and child spawn.
  const pinned = await import(pathToFileURL(path.join(source, 'lib/platform/windows-pipe-client.mjs')).href);
  const prefix = captureCompilerPrefix(pinned.connectWindowsPipe, process.env);
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = ownedChild(shell, compilerControlArgs(prefix, variant), {
    env: environment(), stdio: ['ignore','pipe','pipe'], windowsHide: true });
  const receipt = await observeCompilerControl(child, variant);
  process.send({ id: start.id, ok: true, compilerObservation: receipt });
  process.once('message', ({ id, op }) => {
    if (op !== 'stop') { process.exitCode = 1; process.disconnect(); return; }
    process.send({ id, ok: true, stopped: true }, () => { if (process.connected) process.disconnect(); });
  });
}

async function fixture(source, timingMode = 'default') {
  // No production imports or descendants until the parent has assigned the job.
  process.send({ id: 0, paused: true });
  const start = await new Promise((resolve) => process.once('message', resolve));
  assert.equal(start.op, 'start');
  fixtureRequestId = start.id;
  if (timingMode === 'candidate-channel') assert.equal(start.probe, 'channel');
  if (timingMode === 'candidate-startup') assert.equal(start.probe, undefined);
  activeStage = 'fixture-startup';
  const phaseTiming = start.phaseTimings === true ? createCapacityPhaseTiming(undefined, timingMode) : () => ({});
  const phase = (value, progress) => {
    if (process.connected) process.send({ id: -1, phase: value, ...(progress ?? {}), ...phaseTiming() }, () => {});
  };
  const load = (name) => import(pathToFileURL(path.join(source, name)).href);
  if (['channel','connector','storage'].includes(start.probe)) {
    let cleanup = async () => {};
    fixtureCleanup = async () => { await cleanup(); if (process.connected) process.disconnect(); };
    const ready = await (start.probe === 'storage' ? probePinnedStorage : start.probe === 'connector' ? probePinnedConnector : probePinnedChannel)(load, phase, (dispose) => { cleanup = dispose; });
    process.send({ id: start.id, ok: true, ...ready });
    process.once('message', async ({ id, op }) => {
      try {
        assert.equal(op, 'stop');
        await cleanup();
        process.send({ id, ok: true, stopped: true }, () => { if (process.connected) process.disconnect(); });
      } catch (error) {
        process.exitCode = 1;
        if (process.connected) process.send({ id, ok: false, failure: failure(error) }, () => { if (process.connected) process.disconnect(); });
      }
    });
    return;
  }
  if (start.probe === 'custody') {
    fixtureCleanup = async () => { if (process.connected) process.disconnect(); };
    const ready = await probePinnedCustody(load, mkdirSync, phase);
    process.send({ id: start.id, ok: true, ...ready });
    process.once('message', ({ id, op }) => {
      if (op !== 'stop') { process.exitCode = 1; process.disconnect(); return; }
      process.send({ id, ok: true, stopped: true }, () => { if (process.connected) process.disconnect(); });
    });
    return;
  }
  phase('fixture-imports');
  const [{ Broker }, client, pathsModule] = await Promise.all([load('lib/broker.mjs'), load('lib/client.mjs'), load('lib/paths.mjs')]);
  const paths = pathsModule.brokerPaths(), clientPaths = pathsModule.clientPaths();
  const broker = new Broker({ paths, mode: 'single-account' });
  fixtureCleanup = async () => { await broker.stop(); if (process.connected) process.disconnect(); };
  process.once('disconnect', () => fixtureCleanup().catch(() => { process.exitCode = 1; }));
  phase('fixture-broker-start');
  await broker.start();
  phase('fixture-pair');
  const pairing = await client.pair(paths, clientPaths, undefined, os.userInfo().username, 'single-account');
  phase('fixture-approve');
  await client.admin(paths, { op: 'approve', code: pairing.code });
  const credential = client.loadCredential(clientPaths), alice = `agent_${randomUUID()}`, bob = `agent_${randomUUID()}`;
  const call = (body, options) => client.call(paths, credential, body, options);
  for (const [index, agentId] of [alice, bob].entries()) {
    phase(index === 0 ? 'fixture-join-first' : 'fixture-join-second');
    await call({ op: 'join', agentId });
  }
  async function delivery(key) {
    phase('fixture-delivery-send');
    const sent = await call({ op: 'send', agentId: alice, to: bob, body: CANARY, key });
    phase('fixture-delivery-read');
    const read = await call({ op: 'read', agentId: bob });
    assert.equal(read.messages.length, 1); assert.equal(read.messages[0].id, sent.messageId); assert.equal(read.messages[0].body, CANARY);
    phase('fixture-delivery-ack');
    await call({ op: 'ack', agentId: bob, ids: [sent.messageId] });
    phase('fixture-delivery-empty');
    assert.equal((await call({ op: 'read', agentId: bob })).messages.length, 0);
  }
  await delivery('before');
  phase('fixture-ready');
  process.send({ id: start.id, ok: true, ready: true, startupDeliveryChecks: 1 });
  process.on('message', async ({ id, op, rate }) => {
    try {
      if (op === 'stage') {
        activeStage = 'fixture-offered-stage';
        const result = await admissionStage(rate, (timeoutMs) => call({ op: 'read', agentId: bob }, { timeoutMs }));
        process.send({ id, ok: true, result });
      } else if (op === 'finish') {
        activeStage = 'fixture-post-delivery'; await delivery('after');
        process.send({ id, ok: true, postDeliveryChecks: 1 });
      } else if (op === 'stop') {
        activeStage = 'fixture-stop'; await broker.stop();
        process.send({ id, ok: true, stopped: true }, () => { if (process.connected) process.disconnect(); });
      } else if (op === 'fault') throw new Error('owned-startup-fault');
      else throw new Error('policy-failed');
    } catch (error) {
      process.send({ id, ok: false, failure: failure(error) });
      process.exitCode = 1; await fixtureCleanup();
    }
  });
}

function productionArguments(source) {
  const text = readFileSync(path.join(source, 'lib/platform/windows-pipe-client.mjs'), 'utf8');
  const worker = text.match(/const worker = String\.raw`([\s\S]*?)`;\r?\n\r?\nfunction refusal/);
  assert.ok(worker, 'production-worker-unavailable');
  const encoded = Buffer.from(worker[1], 'utf16le').toString('base64');
  const command = `$ProgressPreference = 'SilentlyContinue'; & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))`;
  return { relayArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', command],
    diagnosticArgs: ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(path.join(source, 'lib/diagnostic-writer.mjs')).href)}).catch(() => process.exit(0));`] };
}
async function supervisorProbe(variant) {
  const started = performance.now(), workDeadline = started + 19_000, cleanupDeadline = started + 29_000;
  const remaining = (at, cap) => Math.max(1, Math.min(cap, Math.floor(at - performance.now())));
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cleanEnvironment = environment();
  const sampleOnly = variant === 'supervisor-sample';
  const attachOnly = variant === 'supervisor-attach' || sampleOnly;
  const fixtureArgs = [SELF, '--paused-fixture'];
  const paused = attachOnly ? ownedChild(process.execPath, fixtureArgs, {
    env: cleanEnvironment, stdio: ['ignore','ignore','pipe','ipc'], windowsHide: true }) : null;
  const pausedControl = paused ? createCapacityController(paused, { ipc: true }) : null;
  const owned = ownedChild(shell, ['-NoLogo','-NoProfile','-NonInteractive','-File',JOB], {
    env: cleanEnvironment, stdio: ['pipe','pipe','pipe'], windowsHide: true });
  const control = createCapacityController(owned, { classifyFailure: supervisorFailure });
  const evidence = { runType: sampleOnly ? 'supervisor-sample-no-workload' : attachOnly ? 'supervisor-attach-no-workload' : 'supervisor-only-no-workload', variant, productionImported: false,
    executionPolicyObservation: 'not-queried',
    environmentParity: { inheritedExecutionPolicy: Object.keys(cleanEnvironment).some((key) => key.toLowerCase() === 'psexecutionpolicypreference'),
      inheritedModulePath: Object.keys(cleanEnvironment).some((key) => key.toLowerCase() === 'psmodulepath'), explicitExecutionPolicyArgument: false },
    stderrBytes: 0, stderrByteCountCapped: false, stderrEncoding: null, control: null,
    eofSent: false, forcedTerminationRequested: false, terminal: null,
    stdioClosedConfirmed: false, ownedTerminalConfirmed: false };
  owned.child.stderr.on('data', (chunk) => {
    evidence.stderrBytes = Math.min(1048577, evidence.stderrBytes + chunk.length);
    evidence.stderrByteCountCapped = evidence.stderrBytes > 1048576;
    evidence.stderrEncoding ??= encodingSignature(chunk);
  });
  owned.child.stderr.on('error', () => { evidence.stderrEncoding = 'stream-error'; });
  if (paused) {
    paused.child.stderr.on('data', (chunk) => { evidence.stderrBytes = Math.min(1048577, evidence.stderrBytes + chunk.length); evidence.stderrByteCountCapped = evidence.stderrBytes > 1048576; });
    paused.child.stderr.on('error', () => { evidence.stderrEncoding = 'stream-error'; });
  }
  let original;
  try {
    if (paused) {
      activeStage = 'paused-fixture-startup';
      assert.equal((await deadline(pausedControl.startup, remaining(started + 15_000, 5000), 'fixture-deadline')).paused, true);
    }
    activeStage = 'supervisor-only-startup';
    const ready = await deadline(control.startup, remaining(started + 15_000, 15_000), 'control-deadline');
    if (ready.ok === false) throw supervisorFailure(ready);
    assert.equal(ready.phase, 'ready');
    if (paused) {
      activeStage = 'supervisor-only-attach';
      const attachment = await control.request('attach', { pid: paused.child.pid, parentPid: process.pid,
        nodeExecutable: realpathSync(process.execPath), shellExecutable: shell, fixtureArgs,
        relayArgs: [], diagnosticArgs: [], compilerExecutables: [], compilerTemp: realpathSync(childTemp()),
        commitLimitBytes: Math.min(2 * 1024 ** 3, Math.floor(os.totalmem() / 4)) }, remaining(started + 15_000, 15_000));
      assert.equal(attachment.attached, true); evidence.attached = true;
      if (sampleOnly) {
        activeStage = 'supervisor-only-sample';
        const sample = await control.request('sample', {}, remaining(workDeadline, 5000));
        for (const kind of ['main','relay','diagnostic','compiler']) {
          for (const key of ['count','workingSetBytes','cpu100ns']) assert.ok(Number.isSafeInteger(sample.totals?.[kind]?.[key]) && sample.totals[kind][key] >= 0);
          assert.equal(sample.totals[kind].count, kind === 'main' ? 1 : 0);
        }
        for (const value of [sample.jobPeakCommitBytes,sample.jobCpu100ns,sample.observer?.workingSetBytes,sample.observer?.cpu100ns]) assert.ok(Number.isSafeInteger(value) && value >= 0);
        evidence.sampleValidated = true;
      }
      activeStage = 'paused-fixture-stop';
      assert.equal((await pausedControl.request('stop', {}, remaining(workDeadline, 5000))).stopped, true);
      assert.equal((await deadline(paused.exited, remaining(workDeadline, 5000), 'fixture-terminal')).code, 0);
      await deadline(paused.stdioClosed, remaining(workDeadline, 5000), 'fixture-terminal');
      assert.equal((await control.request('members', {}, remaining(workDeadline, 5000))).activeMembers, 0);
    }
    activeStage = 'supervisor-only-close';
    const closed = await control.request('close', {}, remaining(workDeadline, 10_000));
    assert.equal(closed.jobEmptyConfirmed, true);
    if (paused) for (const key of ['finalJobCpu100ns','peakJobCommitBytes']) assert.ok(Number.isSafeInteger(closed[key]) && closed[key] >= 0);
    const terminal = await deadline(owned.exited, remaining(workDeadline, 5000), 'job-exit-unconfirmed');
    await deadline(owned.stdioClosed, remaining(workDeadline, 5000), 'job-exit-unconfirmed');
    assert.equal(terminal.code, 0); assert.equal(evidence.stderrBytes, 0); assert.notEqual(evidence.stderrEncoding, 'stream-error');
    evidence.cleanup = { jobEmptyConfirmed: true, naturalJobEmptyConfirmed: true,
      jobCreated: attachOnly, scratchRemoved: true, scratchCreated: false };
    return evidence;
  } catch (error) {
    if (!error.supervisorPhase && supervisorPhases.has(control.state().phase)) error.supervisorPhase = control.state().phase;
    evidence.failurePhases = snapshotCapacityPhases(control, pausedControl);
    error.supervisorProbe = evidence; original = error; throw error;
  } finally {
    if (paused) {
      if (!paused.terminal()) { paused.child.kill(); evidence.fixtureForcedTerminationRequested = true; }
      try {
        const terminal = await deadline(paused.exited, remaining(cleanupDeadline, 5000), 'fixture-terminal');
        evidence.fixtureTerminal = { code: Number.isSafeInteger(terminal.code) ? terminal.code : null,
          signal: ['SIGTERM','SIGKILL','SIGINT'].includes(terminal.signal) ? terminal.signal : null };
        evidence.fixtureOwnedTerminalConfirmed = paused.terminal();
        await deadline(paused.stdioClosed, remaining(cleanupDeadline, 5000), 'fixture-terminal');
        evidence.fixtureStdioClosedConfirmed = true;
      } catch {
        if (original) (original.cleanup ??= []).push({ stage: 'cleanup', check: 'fixture-terminal' });
      }
    }
    if (!owned.terminal()) {
      evidence.eofSent = true;
      owned.child.stdin.end();
      try { await deadline(owned.exited, remaining(cleanupDeadline, 5000), 'job-exit-unconfirmed'); }
      catch {
        evidence.forcedTerminationRequested = true;
        owned.child.kill();
        try { await deadline(owned.exited, remaining(cleanupDeadline, 5000), 'job-exit-unconfirmed'); }
        catch { if (original) (original.cleanup ??= []).push({ stage: 'cleanup', check: 'job-exit-unconfirmed' }); }
      }
    }
    if (owned.terminal()) {
      const terminal = await owned.exited;
      evidence.terminal = { code: Number.isSafeInteger(terminal.code) ? terminal.code : null,
        signal: ['SIGTERM','SIGKILL','SIGINT'].includes(terminal.signal) ? terminal.signal : null };
      try { await deadline(owned.stdioClosed, remaining(cleanupDeadline, 5000), 'job-exit-unconfirmed'); evidence.stdioClosedConfirmed = true; }
      catch { if (original) (original.cleanup ??= []).push({ stage: 'cleanup', check: 'job-exit-unconfirmed' }); }
    }
    evidence.control = control.state(); evidence.ownedTerminalConfirmed = owned.terminal() && (!paused || (evidence.fixtureOwnedTerminalConfirmed === true && evidence.fixtureStdioClosedConfirmed === true));
    evidence.elapsedMs = Math.ceil(performance.now() - started);
  }
}
async function compilerProbe(source, variant, commitLimitBytes) {
  const root = mkdtempSync(path.join(scratchParent(), 'agent-comms-compiler-'));
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = [SELF, '--compiler-fixture', source, variant];
  let fixture, control, supervisor, job;
  activeStage = 'compiler-process-setup';
  try {
    fixture = ownedChild(process.execPath, args, { env: environment(), stdio: ['ignore','ignore','pipe','ipc'], windowsHide: true });
    control = createCapacityController(fixture, { ipc: true, classifyFailure: record => classifyFixtureFailure(record, checks) });
    supervisor = ownedChild(shell, ['-NoLogo','-NoProfile','-NonInteractive','-File',JOB], {
      env: environment(), stdio: ['pipe','pipe','pipe'], windowsHide: true });
    job = createCapacityController(supervisor, { classifyFailure: supervisorFailure });
  } catch (error) {
    // Setup can throw after an earlier child was created. No attach/start has
    // been sent: terminate every existing owned handle and stop the sequence.
    for (const owned of [fixture, supervisor].filter(Boolean)) {
      if (!owned.terminal()) { try { owned.child.kill(); } catch { /* Confirmation below. */ } }
      try { await deadline(Promise.all([owned.exited,owned.stdioClosed]),5000,'fixture-terminal'); } catch { /* Uncertainty remains explicit. */ }
    }
    return {status:'failed',failure:failure(error),ownedTerminalConfirmed:false,stdioClosedConfirmed:false,
      descendantsEmptyConfirmed:false,cleanupConfirmed:false,cleanup:{scratchRemoved:false,jobEmptyConfirmed:false}};
  }
  let attached = false, disposed = false, observation, retainedObservation, original, outputBytes = 0;
  let relayCommandConfirmed = false;
  const receipt = { jobEmptyConfirmed: false, scratchRemoved: false };
  for (const stream of [fixture.child.stderr,supervisor.child.stderr]) {
    stream.on('data', chunk => { outputBytes = Math.min(1048577, outputBytes + chunk.length); });
    stream.on('error', () => { outputBytes = 1048577; });
  }
  async function closeJob() {
    const result = await job.request('close', {}, 10_000);
    assert.equal(result.jobEmptyConfirmed, true, 'job-exit-unconfirmed');
    for (const key of ['finalJobCpu100ns','peakJobCommitBytes']) assert.ok(Number.isSafeInteger(result[key]) && result[key] >= 0, 'job-exit-unconfirmed');
    Object.assign(receipt,result); disposed = true;
  }
  try {
    activeStage = 'compiler-fixture-startup';
    assert.equal((await deadline(control.startup,5000,'fixture-deadline')).paused,true);
    activeStage = 'compiler-supervisor-startup';
    const ready = await deadline(job.startup,15_000,'control-deadline');
    if (ready.ok === false) throw supervisorFailure(ready);
    assert.equal(ready.phase,'ready');
    activeStage = 'compiler-private-job-attach';
    const prefix = captureCompilerPrefix(connectWindowsPipe, environment());
    const result = await job.request('attach', { pid: fixture.child.pid, parentPid: process.pid,
      nodeExecutable: realpathSync(process.execPath), shellExecutable: shell, fixtureArgs: args,
      relayArgs: compilerControlArgs(prefix, variant), diagnosticArgs: [], commitLimitBytes,
      compilerExecutables: ['Framework','Framework64'].map(name => path.join(process.env.SystemRoot,'Microsoft.NET',name,'v4.0.30319','csc.exe')),
      compilerTemp: realpathSync(childTemp()) },15_000);
    assert.equal(result.attached,true); attached = true;
    activeStage = 'derived-compiler-control';
    const started = control.request('start',{},COMPILER_DEADLINE_MS + 15_000);
    const reply = await sampleCompilerControl(job,started,{ onReply(value) {
      // Diagnostics may survive a sampling refusal, but cannot satisfy its gates.
      try { retainedObservation = projectCompilerObservation(value.compilerObservation,variant); }
      catch { /* Malformed owned replies are never retained or serialized. */ }
    } });
    relayCommandConfirmed = true;
    observation = projectCompilerObservation(reply.compilerObservation,variant);
    activeStage = 'compiler-fixture-stop';
    assert.equal((await control.request('stop',{},5000)).stopped,true);
    assert.equal((await deadline(fixture.exited,5000,'fixture-terminal')).code,0);
    await deadline(fixture.stdioClosed,5000,'fixture-terminal');
    receipt.naturalJobEmptyConfirmed = (await job.request('members')).activeMembers === 0;
    assert.equal(receipt.naturalJobEmptyConfirmed,true,'relay-exit-unconfirmed');
    assert.equal(outputBytes,0,'diagnostic-output-invalid');
  } catch(error) { original = failure(error); }
  const cleanup = await cleanupCapacityRun({ fixture, supervisor, attached, disposed, closeJob, receipt,
    removeScratch: () => rmSync(root,{recursive:true,force:true}) });
  // The fixed observation comes from our owned derived fixture, not a peer.
  return { status: original || observation?.status !== 'passed' || cleanup.errors.length ? 'failed' : 'passed',
    ...(original ? {failure:original} : {}), ...(retainedObservation ? {compilerObservation:retainedObservation} : {}),
    ownedTerminalConfirmed: cleanup.fixtureOwnedTerminalConfirmed && cleanup.supervisorOwnedTerminalConfirmed && observation?.ownedTerminalConfirmed === true,
    stdioClosedConfirmed: cleanup.fixtureStdioClosedConfirmed && cleanup.supervisorStdioClosedConfirmed && observation?.stdioClosedConfirmed === true,
    descendantsEmptyConfirmed: cleanup.jobEmptyConfirmed,
    cleanupConfirmed: cleanup.errors.length === 0 && cleanup.scratchRemoved === true,
    relayCommandConfirmed,
    cleanup: {...cleanup,naturalJobEmptyConfirmed:receipt.naturalJobEmptyConfirmed === true} };
}

async function run(source, revision, rates, preflight, commitLimitBytes) {
  source = realpathSync(source);
  const root = mkdtempSync(path.join(scratchParent(), 'agent-comms-capacity-'));
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const timingMode = capacityTimingMode(revision, preflight), timingProfile = capacityTimingProfile(timingMode);
  const args = [SELF, '--fixture', source, ...(timingMode === 'candidate-channel' ? ['--candidate-channel-timing'] : timingMode === 'candidate-startup' ? ['--candidate-startup-timing'] : [])];
  const fixtureOwned = ownedChild(process.execPath, args, { env: environment({
    AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'), AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker'),
    AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'client'), AGENT_COMMS_SERVICE_LABEL: `test.capacity.${randomUUID()}`,
  }), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  const control = createCapacityController(fixtureOwned, { ipc: true, capturePhaseTimings: revision === 'candidate', timingMode, classifyFailure: (record) => classifyFixtureFailure(record, checks) });
  const supervisorOwned = ownedChild(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', JOB], {
    env: environment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const supervisor = createCapacityController(supervisorOwned, { classifyFailure: supervisorFailure });
  let attached = false, disposed = false, sampler, sampling, sampleFailure, outputFailure = false, diagnosticBytes = 0, original, originalError, originalFixturePhase;
  let powershellVersion, connectorObservation, controlTiming, operationPhaseTimings;
  const samples = [], stages = [], cleanupReceipt = { jobEmptyConfirmed: false, scratchRemoved: false };
  async function closeJob() {
    const receipt = await supervisor.request('close', {}, 10_000);
    assert.equal(receipt.jobEmptyConfirmed, true, 'job-exit-unconfirmed');
    for (const key of ['finalJobCpu100ns', 'peakJobCommitBytes']) {
      assert.ok(Number.isSafeInteger(receipt[key]) && receipt[key] >= 0, 'job-exit-unconfirmed');
    }
    Object.assign(cleanupReceipt, receipt);
    disposed = true;
  }
  fixtureOwned.child.stderr.on('data', (chunk) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > 1024 * 1024 || chunk.includes(CANARY) || chunk.includes(root) || chunk.includes(source)) outputFailure = true;
  });
  supervisorOwned.child.stderr.on('data', () => { outputFailure = true; });
  for (const stream of [fixtureOwned.child.stderr, supervisorOwned.child.stderr]) stream.on('error', () => { outputFailure = true; });
  function sample() {
    if (sampling) return sampling;
    sampling = supervisor.request('sample').then((value) => {
      assert.ok(samples.length < 240, 'sample-bound');
      for (const kind of ['main', 'relay', 'diagnostic', 'compiler']) {
        for (const key of ['count', 'workingSetBytes', 'cpu100ns']) assert.ok(Number.isSafeInteger(value.totals?.[kind]?.[key]) && value.totals[kind][key] >= 0);
      }
      samples.push({ ...value.totals, jobPeakCommitBytes: value.jobPeakCommitBytes, jobCpu100ns: value.jobCpu100ns, observer: value.observer });
      writeFileSync(path.join(output, 'partial-run.json'), `${JSON.stringify({ revision, requestedRates: rates, stages, samples }, null, 2)}\n`);
    }).catch((error) => { sampleFailure ??= error; }).finally(() => { sampling = null; });
    return sampling;
  }
  async function noRelays() {
    for (let i = 0; i < 20; i += 1) {
      await sample(); if (sampleFailure) throw sampleFailure;
      if (samples.at(-1).relay.count === 0 && samples.at(-1).compiler.count === 0) return;
      await sleep(100);
    }
    throw new Error('relay-exit-unconfirmed');
  }
  try {
    activeStage = 'paused-fixture-startup';
    assert.equal((await deadline(Promise.race([control.startup, fixtureOwned.exited.then(() => { throw new Error('fixture-terminal'); })]), 5000, 'fixture-deadline')).paused, true);
    const attachStarted = performance.now();
    activeStage = 'supervisor-startup';
    const ready = await deadline(Promise.race([supervisor.startup, supervisorOwned.exited.then(() => { throw new Error('control-closed'); })]), 15_000, 'control-deadline');
    if (ready.ok === false) throw supervisorFailure(ready);
    assert.equal(ready.phase, 'ready');
    activeStage = 'supervisor-attach';
    const attachment = await supervisor.request('attach', { pid: fixtureOwned.child.pid, parentPid: process.pid, nodeExecutable: realpathSync(process.execPath),
      shellExecutable: shell, fixtureArgs: args, ...productionArguments(source), commitLimitBytes,
      compilerExecutables: ['Framework', 'Framework64'].map((name) => path.join(process.env.SystemRoot, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe')),
      compilerTemp: realpathSync(childTemp()) }, Math.max(1, 15_000 - (performance.now() - attachStarted)));
    attached = true; powershellVersion = attachment.powershellVersion;
    activeStage = preflight === 'storage' ? 'candidate-storage-prefix' : preflight === 'connector' ? 'actual-connector-events' : preflight === 'channel' ? 'channel-prepare-and-stale-probes' : preflight === 'custody' ? 'custody-api' : 'production-startup';
    const startFields = { ...(['custody','channel','connector','storage'].includes(preflight) ? { probe: preflight } : {}),
      ...(revision === 'candidate' ? { phaseTimings: true } : {}) };
    const startup = revision === 'candidate'
      ? await timeCapacityRequest(() => control.request('start', startFields, timingProfile.requestDeadlineMs), timing => { controlTiming = timing; }, undefined, timingMode)
      : await control.request('start', startFields, 90_000);
    if (revision === 'candidate') {
      operationPhaseTimings = control.state().phaseTimings;
      if (!operationPhaseTimings.length || controlTiming.timingUnavailable || operationPhaseTimings.some(row => row.timingUnavailable)) throw new Error('timing-unavailable');
    }
    assert.equal(startup.ready, true);
    assert.equal(preflight === 'storage' ? startup.startupStorageChecks : preflight === 'connector' ? startup.startupConnectorChecks : preflight === 'channel' ? startup.startupChannelChecks : preflight === 'custody' ? startup.startupCustodyChecks : startup.startupDeliveryChecks, preflight === 'storage' ? 6 : ['channel','connector'].includes(preflight) ? 3 : preflight === 'custody' ? 4 : 1);
    if (preflight === 'connector') { assert.equal(validConnectorObservation(startup.connectorObservation), true); connectorObservation = startup.connectorObservation; }
    activeStage = 'post-startup-process-check';
    await noRelays();
    sampler = setInterval(sample, 1000);
    if (['custody','channel','connector','storage','candidate-startup'].includes(preflight)) {
      activeStage = preflight === 'storage' ? 'candidate-storage-stop' : preflight === 'candidate-startup' ? 'candidate-startup-stop' : preflight === 'connector' ? 'connector-stop' : preflight === 'channel' ? 'channel-stop' : 'custody-stop';
      clearInterval(sampler); if (sampling) await sampling;
      await control.request('stop', {}, 15_000);
      const result = await deadline(fixtureOwned.exited, 5000, 'natural-exit-unconfirmed');
      assert.equal(result.code, 0); assert.equal(result.signal, null);
    } else if (preflight === 'fault') {
      activeStage = 'startup-fault-preflight';
      clearInterval(sampler); if (sampling) await sampling;
      await assert.rejects(control.request('fault'), { message: 'owned-startup-fault' });
      const result = await deadline(fixtureOwned.exited, 15_000, 'natural-exit-unconfirmed');
      assert.equal(result.code, 1);
    } else if (preflight === 'forced') {
      activeStage = 'job-disposal-preflight';
      clearInterval(sampler); if (sampling) await sampling;
      await closeJob();
      await deadline(fixtureOwned.exited, 5000, 'natural-exit-unconfirmed');
    } else {
      for (const rate of rates) {
        activeStage = `offered-${rate}`;
        const response = await control.request('stage', { rate }, 25_000);
        stages.push(response.result);
        await noRelays(); if (sampleFailure) throw sampleFailure;
        if (!response.result.qualified) break;
      }
      activeStage = 'post-delivery-and-stop';
      assert.equal((await control.request('finish', {}, 60_000)).postDeliveryChecks, 1); await noRelays();
      clearInterval(sampler); if (sampling) await sampling;
      await control.request('stop', {}, 15_000);
      const result = await deadline(fixtureOwned.exited, 5000, 'natural-exit-unconfirmed');
      assert.equal(result.code, 0); assert.equal(result.signal, null);
    }
    if (preflight !== 'forced') {
      for (let i = 0; i < 20; i += 1) {
        if ((await supervisor.request('members')).activeMembers === 0) { cleanupReceipt.naturalJobEmptyConfirmed = true; break; }
        await sleep(100);
      }
      assert.equal(cleanupReceipt.naturalJobEmptyConfirmed, true, 'natural-exit-unconfirmed');
    }
    if (sampleFailure && preflight !== 'forced' && preflight !== 'fault') throw sampleFailure;
    assert.equal(outputFailure, false, 'diagnostic-output-invalid');
    return { revision, preflight: preflight || null, stages,
      deployment: preflight === 'storage' ? 'actual corrected-source fresh Broker storage prefix; no Broker.start, stale probes, listeners, A2A startup or delivery' : preflight === 'connector' ? 'actual pinned connector lifecycle events; no Broker, listener, EventLog, replay, maintenance or workload' : preflight === 'channel' ? 'channel-prepare-and-stale-probes; no Broker, listener, EventLog, replay, maintenance or workload' : preflight === 'custody' ? 'actual pinned account custody API only; no Broker or connector' : 'one embedded production Broker/client; Identification PowerShell connector',
      requestedRates: rates, skippedRates: RATES.filter((rate) => !stages.some((stage) => stage.offeredRate === rate)),
      baselinePermittedRates: rates,
      skipReason: preflight ? 'preflight-no-offers' : stages.some((stage) => !stage.qualified) ? 'preceding-stage-unqualified' : rates.length < RATES.length ? 'baseline-did-not-reach-higher-stage' : null,
      diagnosticBytes, commitLimitBytes, samples, powershellVersion,
      ...(connectorObservation ? { connectorObservation } : {}),
      ...(controlTiming ? { timingProfile, controlTiming, phaseTimings: operationPhaseTimings } : {}),
      deliveryChecks: ['custody','channel','connector','storage'].includes(preflight) ? 0 : preflight === 'candidate-startup' ? 1 : preflight === 'fault' || preflight === 'forced' ? 1 : 2,
      sampledPeakJobWorkingSetBytes: Math.max(...samples.map((sample) => ['main','relay','diagnostic','compiler'].reduce((sum, kind) => sum + sample[kind].workingSetBytes, 0))),
      accountingScope: 'sampled private-job WorkingSet is not instantaneous peak; job CPU/peak committed bytes include short-lived descendants; observer excluded and separately reported',
      ownedTerminalConfirmed: fixtureOwned.terminal(), cleanup: cleanupReceipt };
  } catch (error) {
    if (!error.supervisorPhase && supervisorPhases.has(supervisor.state().phase)) error.supervisorPhase = supervisor.state().phase;
    const phases = snapshotCapacityPhases(supervisor, control);
    original = { ...failure(error), ...(phases.supervisorPhase ? { supervisorPhase: phases.supervisorPhase } : {}),
      ...(phases.connectorProgress ? { connectorProgress: phases.connectorProgress } : {}),
      ...(controlTiming ? { controlTiming } : {}), ...(phases.phaseTimings ? { phaseTimings: phases.phaseTimings } : {}) };
    originalFixturePhase = phases.fixturePhase; originalError = error; throw error;
  }
  finally {
    clearInterval(sampler); if (sampling) await sampling;
    const ownedCleanup = await cleanupCapacityRun({ fixture: fixtureOwned, supervisor: supervisorOwned,
      attached, disposed, closeJob, receipt: cleanupReceipt, removeScratch: () => rmSync(root, { recursive: true, force: true }) });
    const fixturePhase = originalError ? originalFixturePhase : FIXTURE_PHASES.has(control.state().phase) ? control.state().phase : undefined;
    if (originalError) originalError.capacityFailure = retainCapacityFailure(original, { revision, preflight, fixturePhase }, ownedCleanup);
    else if (ownedCleanup.errors.length) {
      const error = new Error('scratch-retained');
      error.capacityFailure = retainCapacityFailure({ ...failure(error),
        ...(controlTiming ? { controlTiming } : {}), ...(operationPhaseTimings ? { phaseTimings: operationPhaseTimings } : {}) },
      { revision, preflight, fixturePhase }, ownedCleanup);
      throw error;
    }
  }
}

async function main(context) {
  if (context !== undefined) {
    assert.equal(isOwnedDesktopContext(context), true);
    desktopContext = context;
  }
  assert.equal(process.platform, 'win32');
  if (!desktopContext) {
    assert.equal(process.env.AGENT_COMMS_CAPACITY_PROFILE_VERIFIED, '1');
    assert.equal(process.env.AGENT_COMMS_DISPOSABLE_WINDOWS, '1');
  }
  const components = JSON.parse(readFileSync(new URL('../../tests/fixtures/windows-host-components.json', import.meta.url)));
  assert.equal(process.version, `v${components.node.version}`);
  assert.equal(desktopContext?.nodeArchiveSha256 ?? process.env.AGENT_COMMS_NODE_ARCHIVE_SHA256, components.node.sha256['win-x64']);
  const args = desktopContext ? [process.execPath, SELF, desktopContext.task === 'candidate-compiler' ? '--candidate-compiler' : '--candidate', path.resolve(fileURLToPath(new URL('../../', import.meta.url))), '--output', path.join(desktopContext.root, 'results')] : process.argv;
  const candidateCompiler = args[2] === '--candidate-compiler';
  const candidateChannel = args[2] === '--candidate-channel';
  const candidateStorage = args[2] === '--candidate-storage';
  const candidateStartup = args[2] === '--candidate';
  const candidateOnly = candidateStartup || candidateStorage || candidateChannel || candidateCompiler;
  if (candidateOnly) { assert.equal(args.length, 6); assert.equal(args[4], '--output'); }
  else {
    assert.equal(args[2], '--old'); assert.equal(args[4], '--new'); assert.equal(args[6], '--output');
    assert.ok(args.length === 8 || (args.length === 9 && ['--preflight','--supervisor-preflight','--attach-preflight','--sample-preflight','--startup-preflight','--custody-preflight','--channel-preflight','--connector-preflight'].includes(args[8])));
  }
  const preflight = args[8] === '--preflight';
  const startupOnly = args[8] === '--startup-preflight';
  const custodyOnly = args[8] === '--custody-preflight';
  const channelOnly = args[8] === '--channel-preflight';
  const connectorOnly = args[8] === '--connector-preflight';
  output = path.resolve(args[candidateOnly ? 5 : 7]); mkdirSync(output);
  if (['--supervisor-preflight','--attach-preflight','--sample-preflight'].includes(args[8])) {
    const result = { v: 1, scope: args[8] === '--sample-preflight' ? 'standard-user sanitized-environment paused-fixture observer sample only; no production imports or workload' : args[8] === '--attach-preflight' ? 'standard-user sanitized-environment paused-fixture attach only; no production imports or workload' : 'standard-user sanitized-environment supervisor control only; no production workload',
      node: process.version, runnerSha256: hash(readFileSync(SELF)), supervisorSha256: hash(readFileSync(JOB)),
      controlSha256: hash(readFileSync(new URL('./windows-capacity-control.mjs', import.meta.url))),
    lifecycleSha256: hash(readFileSync(new URL('./windows-capacity-lifecycle.mjs', import.meta.url))),
    custodySha256: hash(readFileSync(new URL('./windows-capacity-custody.mjs', import.meta.url))),
    channelSha256: hash(readFileSync(new URL('./windows-capacity-channel.mjs', import.meta.url))),
    connectorSha256: hash(readFileSync(new URL('./windows-capacity-connector.mjs', import.meta.url))), runs: [] };
    const persist = () => writeFileSync(path.join(output, 'capacity.json'), `${JSON.stringify(result, null, 2)}\n`);
    persist(); let firstFailure;
    await collectSupervisorProbes(async (variant) => {
      try { return { ...await supervisorProbe(variant), status: 'passed' }; }
      catch (error) {
        const original = failure(error);
        firstFailure ??= { error, stage: original.stage };
        return { ...error.supervisorProbe, status: 'failed', failure: original };
      }
    }, (receipt) => {
      result.runs.push(receipt); persist();
      if (receipt.status === 'not-run') firstFailure ??= { error: new Error('job-exit-unconfirmed'), stage: 'supervisor-probe-cleanup' };
    }, [args[8] === '--sample-preflight' ? 'supervisor-sample' : args[8] === '--attach-preflight' ? 'supervisor-attach' : 'supervisor-script']);
    result.status = firstFailure ? 'failed' : 'passed'; persist();
    if (firstFailure) { activeStage = firstFailure.stage; throw firstFailure.error; }
    process.stdout.write('{"status":"passed","supervisorOnly":true,"workloadRun":false}\n'); return;
  }
  const commitLimitBytes = Math.min(2 * 1024 ** 3, Math.floor(os.totalmem() / 4));
  if (commitLimitBytes < 512 * 1024 ** 2 || os.freemem() < commitLimitBytes + 512 * 1024 ** 2) throw new Error('memory-headroom-insufficient');
  const archives = {};
  for (const [revision, cwd] of candidateOnly ? [['candidate', args[3]]] : [['old', args[3]], ['new', args[5]]]) {
    const pin = revision === 'candidate' ? CORRECTED_STARTUP_SOURCE.pin : PINS[revision];
    activeStage = 'archive-source';
    const { stdout: tree } = await exec('git.exe', ['rev-parse', `${pin}^{tree}`], { cwd, encoding: 'utf8', windowsHide: true });
    const { stdout: bytes } = await exec('git.exe', candidateOnly ? canonicalCandidateArchiveArgs(pin) : ['archive', '--format=tar', pin], { cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    if (candidateOnly) verifyCorrectedStartupSource(tree.trim(), hash(bytes));
    const archive = path.join(output, `${revision}.tar`), source = path.join(output, revision);
    writeFileSync(archive, bytes); mkdirSync(source);
    await exec('tar.exe', ['-xf', archive, '-C', source], { windowsHide: true });
    if (candidateCompiler) verifyCandidateComponent(hash(readFileSync(path.join(source,'lib/platform/windows-pipe-client.mjs'))),
      hash(readFileSync(new URL('../../lib/platform/windows-pipe-client.mjs',import.meta.url))));
    if (candidateOnly) verifyCandidateComponent(hash(readFileSync(path.join(source, 'lib/platform/windows-pipe-stage.mjs'))),
      hash(readFileSync(new URL('../../lib/platform/windows-pipe-stage.mjs', import.meta.url))));
    archives[revision] = { source, pin, tree: tree.trim(), archiveSha256: hash(bytes) };
  }
  if (candidateCompiler) {
    const result = {v:1,...(desktopContext ? {executionKind:'desktop-current-user',desktopProfile:desktopContext.profile} : {}),compilerOnly:true,scope:'derived exact fixed worker compiler controls; implicit-explicit-explicit-implicit; no broker, pipe connection or workload',
      node:process.version,nodeArchiveSha256:desktopContext?.nodeArchiveSha256 ?? process.env.AGENT_COMMS_NODE_ARCHIVE_SHA256,
      nodeExecutableSha256:hash(readFileSync(process.execPath)),runnerSha256:hash(readFileSync(SELF)),
      compilerSha256:hash(readFileSync(new URL('./windows-capacity-compiler.mjs',import.meta.url))),
      classificationSha256:hash(readFileSync(new URL('./windows-capacity-classification.mjs',import.meta.url))),
      supervisorSha256:hash(readFileSync(JOB)),controlSha256:hash(readFileSync(new URL('./windows-capacity-control.mjs',import.meta.url))),
      lifecycleSha256:hash(readFileSync(new URL('./windows-capacity-lifecycle.mjs',import.meta.url))),
      workerSource:COMPILER_SOURCE,requestDeadlineMs:COMPILER_DEADLINE_MS,
      archives:Object.fromEntries(Object.entries(archives).map(([key,{source,...value}])=>[key,value])),runs:[]};
    const persist=()=>writeFileSync(path.join(output,'capacity.json'),`${JSON.stringify(result,null,2)}\n`);
    persist();
    await collectCompilerControls(variant=>compilerProbe(archives.candidate.source,variant,commitLimitBytes),row=>{result.runs.push(row);persist();});
    result.status=result.runs.every(row=>row.status==='passed')?'passed':'failed';persist();
    process.stdout.write(`${JSON.stringify({status:result.status,compilerOnly:true,runs:result.runs.length})}\n`);
    if(result.status!=='passed') process.exitCode=1;
    return;
  }
  const result = { v: 1, ...(desktopContext ? { executionKind: 'desktop-current-user', desktopProfile: desktopContext.profile } : {}), scope: desktopContext ? 'current standard-user desktop exact corrected-source Broker startup, one delivery and disposal only; no offered-rate or installed-host acceptance' : candidateChannel ? 'hosted standard-user exact corrected-source channel-prepare-and-stale-probes only; actual default channel; no Broker.start, EventLog, replay, maintenance, listeners, delivery or offered rates' : candidateStorage ? 'hosted standard-user exact corrected-source fresh storage prefix only; actual prepare, EventLog custody/replay and compacting maintenance; no Broker.start, stale probes, listeners, delivery or offered rates' : candidateStartup ? 'hosted standard-user exact corrected-source Broker startup, one delivery and disposal only; no offered-rate stages, capacity comparison, desktop or host acceptance' : connectorOnly ? 'actual-connector-events; prepare/main stale probe then unconsumed admin connector; no Broker, listener, EventLog, replay, maintenance or workload' : channelOnly ? 'channel-prepare-and-stale-probes; actual pinned default channel; no Broker, listener, EventLog, replay, maintenance or workload' : custodyOnly ? 'hosted standard-user Windows pinned custody API only; no Broker or connector or offered-rate stages' : startupOnly ? 'hosted standard-user Windows old-pin production startup and disposal only; no offered-rate stages or capacity acceptance' : 'hosted standard-user Windows finite capacity pilot; no benchmark, desktop, host or 100/s support acceptance',
    ...(candidateStorage ? { storageHelperLifetime: 'actual production subprocesses belong to private job; configured timeout is not exit proof; no individual helper terminal observation' } : {}),
    storageType: 'not-measured', nodeArchiveSha256: components.node.sha256['win-x64'],
    node: process.version, nodeExecutableSha256: hash(readFileSync(process.execPath)),
    osRelease: os.release(), arch: process.arch, logicalCpus: os.availableParallelism(), physicalMemoryBytes: os.totalmem(), commitLimitBytes,
    runnerSha256: hash(readFileSync(SELF)), policySha256: hash(readFileSync(new URL('./windows-capacity-policy.mjs', import.meta.url))), supervisorSha256: hash(readFileSync(JOB)),
    controlSha256: hash(readFileSync(new URL('./windows-capacity-control.mjs', import.meta.url))),
    lifecycleSha256: hash(readFileSync(new URL('./windows-capacity-lifecycle.mjs', import.meta.url))),
    custodySha256: hash(readFileSync(new URL('./windows-capacity-custody.mjs', import.meta.url))),
    channelSha256: hash(readFileSync(new URL('./windows-capacity-channel.mjs', import.meta.url))),
    connectorSha256: hash(readFileSync(new URL('./windows-capacity-connector.mjs', import.meta.url))),
    timingSha256: hash(readFileSync(new URL('./windows-capacity-timing.mjs', import.meta.url))),
    pipeStageSha256: hash(readFileSync(new URL('../../lib/platform/windows-pipe-stage.mjs', import.meta.url))),
    ...(candidateOnly ? { timingProfile: capacityTimingProfile(candidateChannel ? 'candidate-channel' : candidateStartup ? 'candidate-startup' : 'default'),
      timingScope: 'parent start-request duration and independent child relative fixed-phase observations; explicit trusted-mode deadline/reporting cap; observational, not performance acceptance' } : {}),
    storageSha256: hash(readFileSync(new URL('./windows-capacity-storage.mjs', import.meta.url))),
    correctedStartupSha256: hash(readFileSync(new URL('./windows-corrected-startup.mjs', import.meta.url))),
    archives: Object.fromEntries(Object.entries(archives).map(([key, { source, ...value }]) => [key, value])), runs: [] };
  const persist = () => writeFileSync(path.join(output, 'capacity.json'), `${JSON.stringify(result, null, 2)}\n`);
  persist();
  for (const revision of candidateOnly ? ['candidate'] : startupOnly || custodyOnly || channelOnly || connectorOnly ? ['old'] : ['old', 'new']) {
    if (candidateChannel) { result.runs.push(await run(archives[revision].source, revision, [], 'channel', commitLimitBytes)); persist(); }
    else if (candidateStorage) { result.runs.push(await run(archives[revision].source, revision, [], 'storage', commitLimitBytes)); persist(); }
    else if (candidateStartup) { result.runs.push(await run(archives[revision].source, revision, [], 'candidate-startup', commitLimitBytes)); persist(); }
    else if (connectorOnly) { result.runs.push(await run(archives[revision].source, revision, [], 'connector', commitLimitBytes)); persist(); }
    else if (channelOnly) { result.runs.push(await run(archives[revision].source, revision, [], 'channel', commitLimitBytes)); persist(); }
    else if (custodyOnly) { result.runs.push(await run(archives[revision].source, revision, [], 'custody', commitLimitBytes)); persist(); }
    else if (startupOnly) { result.runs.push(await run(archives[revision].source, revision, [], 'normal', commitLimitBytes)); persist(); }
    else if (preflight) {
      for (const kind of ['normal', 'fault', 'forced']) { result.runs.push(await run(archives[revision].source, revision, [], kind, commitLimitBytes)); persist(); }
    } else {
      const rates = revision === 'old' ? RATES : result.runs[0].stages.map((stage) => stage.offeredRate);
      result.runs.push(await run(archives[revision].source, revision, rates, false, commitLimitBytes)); persist();
    }
  }
  result.status = candidateOnly || preflight || startupOnly || custodyOnly || channelOnly || connectorOnly || result.runs.every((entry) => entry.stages.length === 3 && entry.stages.every((stage) => stage.qualified)) ? 'passed' : 'capacity-not-qualified';
  persist(); process.stdout.write(`${JSON.stringify({ status: result.status, candidateStartup, candidateStorage, candidateChannel, preflight, startupOnly, custodyOnly, channelOnly, connectorOnly, runs: result.runs.length })}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
}
try {
  if (process.argv[2] === '--paused-fixture') {
    process.send({ id: 0, paused: true });
    process.once('message', ({ id, op }) => {
      if (op !== 'stop') { process.exitCode = 1; process.disconnect(); return; }
      process.send({ id, ok: true, stopped: true }, () => { if (process.connected) process.disconnect(); });
    });
  } else if (process.argv[2] === '--compiler-fixture') {
    assert.equal(process.argv.length,5); await compilerFixture(process.argv[3],process.argv[4]);
  } else if (process.argv[2] === '--fixture') {
    assert.ok(process.argv.length === 4 || (process.argv.length === 5 && ['--candidate-channel-timing','--candidate-startup-timing'].includes(process.argv[4])));
    await fixture(process.argv[3], process.argv[4] === '--candidate-channel-timing' ? 'candidate-channel' : process.argv[4] === '--candidate-startup-timing' ? 'candidate-startup' : 'default');
  } else if (process.argv.length === 3 && process.argv[2] === '--desktop-owned') {
    await main(await readOwnedDesktopContext(process.stdin));
  } else await main();
} catch (error) {
  // Deliver only the fixed classification before cleanup disconnects IPC.
  if (['--fixture','--compiler-fixture'].includes(process.argv[2]) && Number.isSafeInteger(fixtureRequestId) && process.connected) {
    try { process.send({ id: fixtureRequestId, ok: false, failure: failure(error) }, () => {}); } catch { /* Owned cleanup still runs if IPC closed. */ }
  }
  if (fixtureCleanup) await fixtureCleanup().catch(() => {});
  const result = { status: 'failed', ...(error.capacityFailure ?? failure(error)), ...(error.cleanup ? { cleanup: error.cleanup, original: error.original ?? null } : {}),
    ...(error.supervisorProbe ? { supervisorProbe: error.supervisorProbe } : {}) };
  if (output) writeFileSync(path.join(output, 'failure.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (!['--fixture','--compiler-fixture'].includes(process.argv[2])) process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 1;
}
