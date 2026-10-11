import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isBrokerCommandLine, stopWindowsBrokerTask, windowsTaskStopScript } from '../lib/platform/windows-task-stop.mjs';
import { createServiceStartup } from '../lib/platform/service-startup.mjs';

test('broker identity accepts actual individually quoted Windows argv and refuses adjacent commands', () => {
  for (const line of ['"C:\\Program Files\\node.exe" "C:\\bundle space\\bin\\agent-comms.mjs" "broker" "run" "--single-account"',
    'C:\\node.exe C:\\bundle\\agent-comms.mjs broker run --single-account']) assert.ok(isBrokerCommandLine(line));
  for (const line of ['node.exe C:\\agent-comms.mjs worker run', 'node.exe C:\\agent-comms.mjs broker running',
    'node.exe C:\\other.mjs broker run', 'node.exe "C:\\agent-comms.mjs broker run"']) assert.equal(isBrokerCommandLine(line), false);
});

test('stop checks custody before native execution and bounds the sanitized helper', () => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'comms-stop-'));
  const calls = [];
  const isolation = { currentUid: () => 'sid', assertOwnedDir: () => calls.push('dir'), assertLogFile: () => calls.push('lock') };
  try {
    writeFileSync(path.join(state, 'broker.lock'), '123');
    stopWindowsBrokerTask({ label: 'org.example.test', state, isolation, env: { PSModulePath: 'wrong', KEEP: 'yes' }, timeoutMs: 100,
      exec: (command, args, options) => {
        assert.deepEqual(calls, ['dir', 'lock']);
        assert.equal(command, 'powershell.exe');
        assert.equal(options.env.PSModulePath, undefined);
        assert.equal(options.env.KEEP, 'yes');
        assert.ok(options.timeout > 0 && options.timeout <= 100);
        const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
        assert.match(script, /GetProcessById\(123\)/);
        assert.ok(script.indexOf('$null=$p.Handle') < script.indexOf('$t.Stop(0)'));
        assert.match(script, /\$p.HasExited/);
        assert.doesNotMatch(script, /GetInstances|Stop-Process|taskkill|process\.kill/);
        return 'stopped\r\n';
      } });
    for (const result of ['0', '', 'stopped\nextra']) assert.throws(() => stopWindowsBrokerTask({ label: 'org.example.test', state, isolation, exec: () => result }), { code: 'launchagent-unload-failed' });
    assert.throws(() => stopWindowsBrokerTask({ label: 'org.example.test', state, isolation, exec: () => { throw new Error('denied'); } }), { code: 'launchagent-unload-failed' });
    writeFileSync(path.join(state, 'broker.lock'), '-1');
    assert.throws(() => stopWindowsBrokerTask({ label: 'org.example.test', state, isolation, exec: () => assert.fail('must not query') }), { code: 'state-dir-untrusted' });
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('replacement cannot register until stop proves completion, and stop errors never trigger rollback launch', () => {
  const service = createServiceStartup('win32');
  const root = mkdtempSync(path.join(os.tmpdir(), 'comms-replace-'));
  const calls = [];
  const base = { label: 'org.example.test', userId: 'OWNER', args: ['node.exe', 'agent-comms.mjs', 'broker', 'run'],
    logDir: root, plist: path.join(root, 'task.xml'), environment: {}, makeDir: () => {}, writeFile: writeFileSync,
    load: () => calls.push('create/run') };
  try {
    writeFileSync(base.plist, 'previous');
    assert.throws(() => service.install({ ...base, unload: () => { calls.push('stop'); throw new Error('stop timeout'); } }), /stop timeout/);
    assert.deepEqual(calls, ['stop']);
    calls.length = 0;
    service.install({ ...base, unload: () => { calls.push('stop pending'); assert.deepEqual(calls, ['stop pending']); calls.push('old process exited'); } });
    assert.deepEqual(calls, ['stop pending', 'old process exited', 'create/run']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stop script requires safe task state and retains the original process handle across PID reuse', () => {
  const script = windowsTaskStopScript('org.example.test', null, 100);
  assert.match(script, /running broker task has no verifiable broker lock process/);
  assert.match(script, /\$state -eq -1 -or \$state -eq 1 -or \$state -eq 3/);
  assert.match(script, /previous broker PID was reused/);
  assert.match(script, /\$p.Dispose\(\)/);
});

 test('custody children share the stop deadline and exhausted preflight never starts replacement', () => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'comms-stop-budget-'));
  let clock = 0;
  const calls = [];
  try {
    assert.throws(() => stopWindowsBrokerTask({ label: 'org.example.test', state, timeoutMs: 100, now: () => clock,
      run: (command, args, options) => {
        calls.push(command);
        assert.equal(options.timeout, 100);
        clock = 100;
        return { status: 0, stdout: '"OWNER","S-1-5-21-1"\n' };
      }, exec: () => assert.fail('deadline exhausted before helper') }), { code: 'launchagent-unload-failed' });
    assert.deepEqual(calls, ['whoami.exe']);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
