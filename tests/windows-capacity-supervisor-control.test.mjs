import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCapacityController, utilityProbeCommand } from '../tools/acceptance/windows-capacity-control.mjs';
import { captureProductionWindowsRelay } from './helpers/capture-production-windows-relay.mjs';

const diagnosticParserCases = [
  'missing-command-line','wrong-type-refused','over-bound-refused-before-parse','console-host-over-bound-shape-only','zero-arguments',
  'one-argument','multiple-arguments','legacy-handle-only-candidate','legacy-handle-force-v1-candidate',
  'malformed-case-length-and-extra-args-other','unparsed-command-shape','parser-argument-bound-refused',
  'production-relay-args-exact-and-current-parent-correlation','wrong-relay-argv-not-exact','wrong-fixture-parent-not-exact',
  'older-parent-date-not-exact','unknown-parent-not-correlated',
];
const diagnosticFailureCases = ['startup-or-unknown', ...diagnosticParserCases];
const diagnosticFailurePhases = ['script-entry','module-observation','import-utility','compile-supervisor','supervisor-compiled','startup-or-unknown'];
const diagnosticParentBooleanFields = [
  'parentCurrentRowFound','parentRelayPathMatch','parentRelayArgsParsed','parentRelayArgsEqualExpected',
  'parentParentIsFixture','parentCreationDatePresent','parentCreationAtOrAfterFixtureObserved',
  'consoleHostCreationDatePresent','consoleHostCreationAtOrAfterParentObserved',
];
const diagnosticParentClassFields = ['parentRelayCommandLineClass','consoleHostCommandLineClass'];
const diagnosticCommandLineClasses = ['not-checked','missing','wrong-type','over-bound','parse-refused','no-arguments','one-argument','multiple-arguments'];
const diagnosticCommandShapes = ['unparsed','legacy-handle-only-candidate','legacy-handle-force-v1-candidate','other'];
const diagnosticParentFields = [
  ...diagnosticParentBooleanFields,
  ...diagnosticParentClassFields,
  'parentRelayArgumentCount','consoleHostArgumentCount','consoleHostCommandShape',
];

function projectDiagnosticParserOutput(stdout, stderrBytes) {
  const boundedStderrBytes = Number.isSafeInteger(stderrBytes) && stderrBytes >= 0 ? Math.min(stderrBytes, 65535) : 65535;
  if (typeof stdout !== 'string' || stdout.length > 4096) return { kind: 'invalid', stderrBytes: boundedStderrBytes };
  let record;
  try { record = JSON.parse(stdout); } catch { return { kind: 'invalid', stderrBytes: boundedStderrBytes }; }
  const hasExactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  if (hasExactKeys(record, ['id','ok','parserCases','workloadRun','processQueryRun'])
      && record.id === 0 && record.ok === true && record.workloadRun === false && record.processQueryRun === false
      && Array.isArray(record.parserCases) && record.parserCases.length === diagnosticParserCases.length
      && record.parserCases.every((value, index) => value === diagnosticParserCases[index])) {
    return { kind: 'success', stderrBytes: boundedStderrBytes };
  }
  if (hasExactKeys(record, ['id','ok','failure']) && record.id === 0 && record.ok === false
      && hasExactKeys(record.failure, ['check','phase','case'])
      && record.failure.check === 'diagnostic-parser-test-failed'
      && diagnosticFailurePhases.includes(record.failure.phase)
      && diagnosticFailureCases.includes(record.failure.case)) {
    return { kind: 'failure', phase: record.failure.phase, case: record.failure.case, stderrBytes: boundedStderrBytes };
  }
  if (hasExactKeys(record, ['id','ok','failure']) && record.id === 0 && record.ok === false
      && hasExactKeys(record.failure, ['check','phase','case','stage','parent'])
      && record.failure.check === 'diagnostic-parser-test-failed'
      && record.failure.phase === 'supervisor-compiled'
      && record.failure.case === 'production-relay-args-exact-and-current-parent-correlation'
      && ['precondition','redaction-guard'].includes(record.failure.stage)
      && hasExactKeys(record.failure.parent, diagnosticParentFields)
      && diagnosticParentBooleanFields.every((key) => typeof record.failure.parent[key] === 'boolean')
      && diagnosticParentClassFields.every((key) => diagnosticCommandLineClasses.includes(record.failure.parent[key]))
      && ['parentRelayArgumentCount','consoleHostArgumentCount'].every((key) =>
        record.failure.parent[key] === null || (Number.isInteger(record.failure.parent[key]) && record.failure.parent[key] >= 0 && record.failure.parent[key] <= 12))
      && diagnosticCommandShapes.includes(record.failure.parent.consoleHostCommandShape)) {
    return {
      kind: 'failure', phase: record.failure.phase, case: record.failure.case,
      stage: record.failure.stage,
      parent: Object.fromEntries(diagnosticParentFields.map((key) => [key, record.failure.parent[key]])),
      stderrBytes: boundedStderrBytes,
    };
  }
  return { kind: 'invalid', stderrBytes: boundedStderrBytes };
}

test('native diagnostic-parser receipt case order matches the PowerShell probe', () => {
  const script = readFileSync(new URL('../tools/acceptance/windows-capacity-job.ps1', import.meta.url), 'utf8');
  const cases = [...script.matchAll(/\$cases\.Add\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual(cases, diagnosticParserCases);
});

test('native diagnostic-parser failure projection retains only closed IDs and bounded stderr count', () => {
  const failure = JSON.stringify({ id: 0, ok: false, failure: { check: 'diagnostic-parser-test-failed', phase: 'supervisor-compiled', case: 'wrong-fixture-parent-not-exact' } });
  assert.deepEqual(projectDiagnosticParserOutput(failure, 7), { kind: 'failure', phase: 'supervisor-compiled', case: 'wrong-fixture-parent-not-exact', stderrBytes: 7 });
  const parent = Object.fromEntries([
    ...diagnosticParentBooleanFields.map((key) => [key, true]),
    ['parentRelayCommandLineClass','multiple-arguments'],['consoleHostCommandLineClass','multiple-arguments'],
    ['parentRelayArgumentCount',7],['consoleHostArgumentCount',2],['consoleHostCommandShape','legacy-handle-force-v1-candidate'],
  ]);
  const parentFailure = (overrides = {}) => JSON.stringify({ id: 0, ok: false, failure: {
    check: 'diagnostic-parser-test-failed', phase: 'supervisor-compiled',
    case: 'production-relay-args-exact-and-current-parent-correlation', stage: 'precondition',
    parent: { ...parent, ...overrides },
  } });
  const projectedParent = projectDiagnosticParserOutput(parentFailure({ parentRelayArgsEqualExpected: false }), 11);
  assert.equal(projectedParent.kind, 'failure');
  assert.equal(projectedParent.stage, 'precondition');
  assert.equal(projectedParent.parent.parentRelayArgsEqualExpected, false);
  assert.equal(projectedParent.parent.consoleHostCommandShape, 'legacy-handle-force-v1-candidate');
  for (const invalid of [
    JSON.stringify({ id: 0, ok: false, failure: { check: 'diagnostic-parser-test-failed', phase: 'supervisor-compiled', case: 'unknown-case' } }),
    JSON.stringify({ id: 0, ok: false, failure: { check: 'diagnostic-parser-test-failed', phase: 'supervisor-compiled', case: 'wrong-fixture-parent-not-exact', commandLine: 'CANARY-private' } }),
    JSON.stringify({ id: 0, ok: false, failure: { check: 'diagnostic-parser-test-failed', phase: 'supervisor-compiled', case: 'wrong-fixture-parent-not-exact', handle: '0xDEADBEEF' } }),
    parentFailure({ commandLine: 'CANARY-private' }),
    parentFailure({ parentRelayArgsEqualExpected: 'false' }),
    parentFailure({ parentRelayCommandLineClass: 'unknown-class' }),
    parentFailure({ consoleHostArgumentCount: 13 }),
    JSON.stringify({ id: 0, ok: false, failure: { check: 'diagnostic-parser-test-failed', phase: 'supervisor-compiled', case: 'production-relay-args-exact-and-current-parent-correlation', stage: 'unknown-stage', parent } }),
    '{malformed-json',
    'x'.repeat(4097),
  ]) assert.deepEqual(projectDiagnosticParserOutput(invalid, 100000), { kind: 'invalid', stderrBytes: 65535 });
});

async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('owned process deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}

for (const [kind, command] of [
  ['bare literal', `[Console]::Out.WriteLine('{"id":0,"ok":true,"phase":"ready"}');[Console]::Out.Flush()`],
  ['unsigned memory bounds', `$ErrorActionPreference='Stop';if ($PSVersionTable.PSVersion.Major -ne 5) {throw 'expected-classic-shell'};$oldAliasRefused=$false;try {$null=[ulong]536870912} catch {$oldAliasRefused=$true};if (-not $oldAliasRefused) {throw 'unexpected-unsigned-alias'};foreach ($entry in @(@{value=536870911;allowed=$false},@{value=536870912;allowed=$true},@{value=2147483648;allowed=$true},@{value=2147483649;allowed=$false})) {$limit=[uint64]$entry.value;if ($limit.GetType() -ne [System.UInt64]) {throw 'incorrect-unsigned-type'};$allowed=-not ($limit -lt 536870912 -or $limit -gt 2147483648);if ($allowed -ne $entry.allowed) {throw 'incorrect-memory-bound'}};[Console]::Out.WriteLine('{"id":0,"ok":true,"phase":"ready"}');[Console]::Out.Flush()`],
  ['JSON-only', utilityProbeCommand()],
  ['explicit built-in Utility', utilityProbeCommand(true)],
]) test(`${kind} classic shell emits control and exits naturally with stdin still open`, { skip: process.platform !== 'win32' }, async () => {
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawn(shell, ['-NoLogo','-NoProfile','-NonInteractive','-Command',command], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
  let terminal = false, stderrBytes = 0;
  const exited = new Promise((resolve) => {
    child.once('error', () => { terminal = true; resolve({ code: null }); });
    child.once('exit', (code) => { terminal = true; resolve({ code }); });
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
  child.stderr.on('error', () => { stderrBytes = -1; });
  const control = createCapacityController({ child, exited, terminal: () => terminal });
  try {
    assert.deepEqual(await within(control.startup, 15000), { id: 0, ok: true, phase: 'ready' });
    assert.equal((await within(exited, 5000)).code, 0);
    await within(closed, 5000); assert.equal(stderrBytes, 0);
  } finally {
    if (!terminal) child.kill();
    await within(exited, 5000); await within(closed, 5000);
  }
});

test('classic supervisor exchanges bounded control records with stdin still open', { skip: process.platform !== 'win32' }, async () => {
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('../tools/acceptance/windows-capacity-job.ps1', import.meta.url));
  const child = spawn(shell, ['-NoProfile','-NonInteractive','-File',script], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
  let terminal = false, bytes = '', fault, stderrBytes = 0;
  const records = new Map(), phases = new Set();
  const stdioClosed = new Promise((resolve) => child.once('close', resolve));
  const exited = new Promise((resolve) => {
    child.once('error', () => { terminal = true; resolve({ code: null }); });
    child.once('exit', (code) => { terminal = true; resolve({ code }); });
  });
  child.stdin.on('error', () => { fault = true; });
  child.stdout.on('error', () => { fault = true; });
  child.stderr.on('error', () => { fault = true; });
  child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
  child.stdout.on('data', (chunk) => {
    bytes += chunk.toString('utf8');
    if (bytes.length > 65536) { fault = true; return; }
    while (bytes.includes('\n')) {
      const end = bytes.indexOf('\n'), line = bytes.slice(0, end); bytes = bytes.slice(end + 1);
      try {
        const value = JSON.parse(line);
        if (value.id === -1) {
          if (!['script-entry','compile-supervisor','supervisor-compiled','module-observation','import-utility','utility-imported','serialize-ready','ready-serialized','read-control','control-read','parse-control','control-parsed','close-job'].includes(value.phase)) { fault = true; return; }
          if (value.phase === 'module-observation' && (value.manifestPresent !== true || value.expectedPSHome !== true)) { fault = true; return; }
          phases.add(value.phase);
        }
        if (!records.has(value.id) && records.size >= 4) { fault = true; return; }
        records.set(value.id, value);
      } catch { fault = true; }
    }
  });
  async function record(id) {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      assert.equal(fault, undefined, 'supervisor control framing failed');
      if (records.has(id)) return records.get(id);
      assert.equal(terminal, false, 'supervisor exited before control receipt');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail('supervisor control deadline');
  }
  async function terminalWithin(ms) {
    let timer;
    try { return await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]); }
    finally { clearTimeout(timer); }
  }
  try {
    assert.deepEqual(await record(0), { id: 0, ok: true, phase: 'ready' });
    child.stdin.write('{"id":1,"op":"close"}\n');
    // Do not send EOF: this checks the same live duplex control path as attach.
    const closed = await record(1);
    assert.equal(closed.ok, true); assert.equal(closed.closed, true); assert.equal(closed.jobEmptyConfirmed, true);
    const result = await terminalWithin(5000);
    await within(stdioClosed, 5000);
    assert.equal(result?.code, 0); assert.equal(stderrBytes, 0);
    assert.deepEqual([...phases].sort(), ['close-job','compile-supervisor','control-parsed','control-read','import-utility','module-observation','parse-control','read-control','ready-serialized','script-entry','serialize-ready','supervisor-compiled','utility-imported']);
  } finally {
    if (!terminal) child.kill();
    const result = await terminalWithin(5000);
    assert.notEqual(result, null, 'owned supervisor terminal unconfirmed');
    await within(stdioClosed, 5000);
  }
});

test('classic supervisor bounds command-line diagnostic parsing without querying processes', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('../tools/acceptance/windows-capacity-job.ps1', import.meta.url));
  const { args: relayArgs } = captureProductionWindowsRelay();
  const child = spawn(shell, ['-NoProfile','-NonInteractive','-File',script,'-DiagnosticParserTestOnly'], {
    env: { ...process.env, AGENT_COMMS_TEST_RELAY_ARGS_JSON: JSON.stringify(relayArgs) },
    stdio: ['ignore','pipe','pipe'], windowsHide: true,
  });
  let terminal = false, stdout = '', stderrBytes = 0;
  const exited = new Promise(resolve => {
    child.once('error', () => { terminal = true; resolve({ code: null }); });
    child.once('exit', code => { terminal = true; resolve({ code }); });
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); if (stdout.length > 4096) child.kill(); });
  child.stderr.on('data', chunk => { stderrBytes = Math.min(65535, stderrBytes + chunk.length); });
  try {
    const result = await within(exited, 50000);
    await within(closed, 5000);
    const projected = projectDiagnosticParserOutput(stdout, stderrBytes);
    const safeDetail = projected.kind === 'failure'
      ? `sanitizedFailure=${projected.phase}/${projected.case}${projected.stage ? `; stage=${projected.stage}; parent=${JSON.stringify(projected.parent)}` : ''}; stderrBytes=${projected.stderrBytes}`
      : `sanitizedFailureRecord=${projected.kind}; stderrBytes=${projected.stderrBytes}`;
    assert.equal(result.code, 0, safeDetail);
    assert.equal(projected.kind, 'success', safeDetail);
    assert.equal(projected.stderrBytes, 0, `unexpectedStderrBytes=${projected.stderrBytes}`);
  } finally {
    if (!terminal) child.kill();
    await within(exited, 5000); await within(closed, 5000);
  }
});

test('classic supervisor refuses an unexpected built-in module home without JSON autoload', { skip: process.platform !== 'win32' }, async () => {
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('../tools/acceptance/windows-capacity-job.ps1', import.meta.url));
  // Keep the shell/CLR bootstrap environment intact; change only the script's
  // expected-home input after startup, in this disposable child process.
  const env = { ...process.env, AGENT_COMMS_TEST_SUPERVISOR: script };
  const command = `[Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"bootstrap-ready"}');[Console]::Out.Flush();$env:SystemRoot='X:\\CANARY-nonexistent-system-root';& $env:AGENT_COMMS_TEST_SUPERVISOR;exit $LASTEXITCODE`;
  const child = spawn(shell, ['-NoLogo','-NoProfile','-NonInteractive','-Command',command], { env, stdio: ['pipe','pipe','pipe'], windowsHide: true });
  let terminal = false, stderrBytes = 0;
  const exited = new Promise((resolve) => {
    child.once('error', () => { terminal = true; resolve({ code: null }); });
    child.once('exit', (code) => { terminal = true; resolve({ code }); });
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
  child.stderr.on('error', () => { stderrBytes = -1; });
  const control = createCapacityController({ child, exited, terminal: () => terminal });
  try {
    const refused = await within(control.startup, 15000);
    assert.equal(refused.ok, false); assert.deepEqual(refused.failure, { check: 'job-supervisor-failed', phase: 'module-observation' });
    assert.deepEqual(control.state().moduleObservation, { manifestPresent: true, expectedPSHome: false });
    assert.equal((await within(exited, 5000)).code, 1);
    await within(closed, 5000); assert.equal(stderrBytes, 0);
  } finally {
    if (!terminal) child.kill();
    await within(exited, 5000); await within(closed, 5000);
  }
});

// This tests the actual observer job boundary, without loading either runtime.
test('classic supervisor verifies and attaches an owned paused fixture before natural disposal', { skip: process.platform !== 'win32' }, async () => {
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('../tools/acceptance/windows-capacity-job.ps1', import.meta.url));
  const fixtureArgs = [fileURLToPath(new URL('../tools/acceptance/windows-connector-capacity.mjs', import.meta.url)), '--paused-fixture'];
  function owned(file, args, stdio) {
    const child = spawn(file, args, { stdio, windowsHide: true }); let terminal = false;
    const exited = new Promise((resolve) => {
      child.once('error', () => { terminal = true; resolve({ code: null }); });
      child.once('exit', (code) => { terminal = true; resolve({ code }); });
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    let stderrBytes = 0; child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
    child.stderr.on('error', () => { stderrBytes = -1; });
    return { child, exited, closed, terminal: () => terminal, stderrBytes: () => stderrBytes };
  }
  const fixture = owned(process.execPath, fixtureArgs, ['ignore','ignore','pipe','ipc']);
  const fixtureControl = createCapacityController(fixture, { ipc: true });
  const supervisor = owned(shell, ['-NoLogo','-NoProfile','-NonInteractive','-File',script], ['pipe','pipe','pipe']);
  // state() retains only controller-validated fixed phases/encoding/booleans.
  // Preserve the refusal interval without printing PowerShell errors or input.
  const control = createCapacityController(supervisor, {
    classifyFailure: () => new Error('job-supervisor-failed ' + JSON.stringify(control.state())),
  });
  const started = Date.now(), remaining = () => Math.max(1, 15000 - (Date.now() - started));
  try {
    assert.equal((await within(fixtureControl.startup, remaining())).paused, true);
    assert.equal((await within(control.startup, remaining())).phase, 'ready');
    const attached = await control.request('attach', { pid: fixture.child.pid, parentPid: process.pid,
      nodeExecutable: realpathSync(process.execPath), shellExecutable: shell, fixtureArgs,
      relayArgs: [], diagnosticArgs: [], compilerExecutables: [], compilerTemp: realpathSync(process.env.TEMP),
      commitLimitBytes: 536870912 }, remaining());
    assert.equal(attached.attached, true);
    assert.deepEqual(control.state().cimModuleObservation, { manifestPresent: true });
    const sample = await control.request('sample');
    assert.equal(sample.totals.main.count, 1);
    for (const kind of ['relay','diagnostic','compiler']) assert.equal(sample.totals[kind].count, 0);
    for (const value of [sample.totals.main.workingSetBytes,sample.totals.main.cpu100ns,sample.jobPeakCommitBytes,sample.jobCpu100ns,sample.observer.workingSetBytes,sample.observer.cpu100ns]) assert.ok(Number.isSafeInteger(value) && value >= 0);
    assert.equal((await fixtureControl.request('stop')).stopped, true);
    assert.equal((await within(fixture.exited, 5000)).code, 0); await within(fixture.closed, 5000);
    assert.equal((await control.request('members')).activeMembers, 0);
    const close = await control.request('close'); assert.equal(close.jobEmptyConfirmed, true);
    for (const key of ['finalJobCpu100ns','peakJobCommitBytes']) assert.ok(Number.isSafeInteger(close[key]) && close[key] >= 0);
    assert.equal((await within(supervisor.exited, 5000)).code, 0); await within(supervisor.closed, 5000);
    assert.equal(control.state().phase, 'close-job');
    assert.equal(supervisor.stderrBytes(), 0); assert.equal(fixture.stderrBytes(), 0);
  } finally {
    // Both are direct owned children; the paused fixture never starts descendants.
    for (const child of [fixture, supervisor]) if (!child.terminal()) child.child.kill();
    await Promise.all([fixture, supervisor].map(async child => { await within(child.exited, 5000); await within(child.closed, 5000); }));
  }
});
