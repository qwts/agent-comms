// Inert, scratch-only job proof. Never invokes compiler, engine or desktop runner.
import { spawn } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCapacityController } from '../../tools/acceptance/windows-capacity-control.mjs';
const root = process.env.DESKTOP_JOB_PROOF_ROOT;
if (!root || process.argv[2] !== '--desktop-owned') throw new Error('proof frame refused');
writeFileSync(path.join(root, 'started.json'), JSON.stringify({ v: 1, node: process.pid }), { flag: 'wx' });
let frame = '';
for await (const bytes of process.stdin) {
  frame += bytes.toString('utf8');
  if (Buffer.byteLength(frame) > 128) throw new Error('proof frame bound');
}
if (frame !== 'nested\n') throw new Error('proof frame refused');
const runner = fileURLToPath(new URL('../../tools/acceptance/windows-connector-capacity.mjs', import.meta.url));
const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
function owned(file, args, stdio) {
  const child = spawn(file, args, { stdio, windowsHide: true }); let terminal = false;
  const exited = new Promise(resolve => {
    child.once('exit', code => { terminal = true; resolve({ code }); });
    child.once('error', () => { terminal = true; resolve({ code: null }); });
  });
  child.stderr?.resume();
  return { child, exited, terminal: () => terminal };
}
const fixtureArgs = [runner, '--paused-fixture'];
const fixture = owned(process.execPath, fixtureArgs, ['ignore','inherit','inherit','ipc']);
const supervisor = owned(shell, ['-NoLogo','-NoProfile','-NonInteractive','-File',
  fileURLToPath(new URL('../../tools/acceptance/windows-capacity-job.ps1', import.meta.url))], ['pipe','pipe','pipe']);
const fixtureControl = createCapacityController(fixture, { ipc: true });
const control = createCapacityController(supervisor);
const deadline = Date.now() + 15000;
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('proof nested deadline')), Math.max(1, deadline - Date.now()));
  })]).finally(() => clearTimeout(timer));
}
try {
  if (!(await bounded(fixtureControl.startup)).paused) throw new Error('proof pause refused');
  if ((await bounded(control.startup)).phase !== 'ready') throw new Error('proof supervisor refused');
  const attached = await bounded(control.request('attach', { pid: fixture.child.pid, parentPid: process.pid,
    nodeExecutable: realpathSync(process.execPath), shellExecutable: shell, fixtureArgs,
    relayArgs: [], diagnosticArgs: [], compilerExecutables: [], compilerTemp: realpathSync(process.env.TEMP),
    commitLimitBytes: 536870912 }, Math.max(1, deadline - Date.now())));
  if (!attached.attached) throw new Error('proof nested assignment refused');
  writeFileSync(path.join(root, 'nested.json'), JSON.stringify({ v: 1, node: process.pid,
    supervisor: supervisor.child.pid, fixture: fixture.child.pid, attached: true }), { flag: 'wx' });
  // The actual paused fixture inherits both Node pipe WRITE ends. Independent
  // EOF therefore requires descendant closure too, not only Node termination.
  // Stay entered until the outer owner terminates or dies. No synthetic close receipt.
  setInterval(() => {}, 1000);
} catch {
  for (const item of [fixture, supervisor]) if (!item.terminal()) item.child.kill();
  process.exitCode = 1;
}
