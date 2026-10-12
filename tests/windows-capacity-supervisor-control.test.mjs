import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCapacityController, utilityProbeCommand } from '../tools/acceptance/windows-capacity-control.mjs';

async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('owned process deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}

for (const [kind, command] of [
  ['bare literal', `[Console]::Out.WriteLine('{"id":0,"ok":true,"phase":"ready"}');[Console]::Out.Flush()`],
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
  const control = createCapacityController(supervisor);
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
