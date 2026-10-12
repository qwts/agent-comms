import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const script = fileURLToPath(new URL('./windows-desktop-job-native.ps1', import.meta.url));
const cases = ['before-resume-parent-loss', 'nested-parent-loss', 'nested-terminate',
  'finite-uncertain', 'cleanup-clock-reuse'];
for (const kind of cases) test(`desktop outer job native proof: ${kind}`, {
  skip: process.platform !== 'win32', timeout: 120000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'comms-desktop-job-proof-'));
  t.diagnostic(`Retained scratch: ${root}`);
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script,
    '-Case', kind, '-Root', root, '-Node', process.execPath], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let terminal = false, outputBytes = 0, overflow = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    outputBytes += bytes.length;
    if (outputBytes > 32768) { overflow = true; child.kill(); }
  });
  const exited = new Promise(resolve => {
    child.once('exit', code => { terminal = true; resolve(code); });
    child.once('error', () => { terminal = true; resolve(null); });
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  async function bounded(promise, ms) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native proof terminal unconfirmed; scratch retained')), ms);
    })]); } finally { clearTimeout(timer); }
  }
  try {
    assert.equal(await bounded(exited, 105000), 0);
    await bounded(closed, 5000);
    assert.equal(overflow, false);
    const bytes = await readFile(path.join(root, 'controller.json'));
    assert.ok(bytes.length <= 2048);
    const receipt = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(receipt, { v: 1, case: kind,
      retainedProcessHandles: kind === 'before-resume-parent-loss' ? 2 : 4,
      allSignaled: true, jobHandleDuplicated: false,
      independentReadHandles: kind.endsWith('parent-loss') ? 2 : 0,
      independentPipeEof: kind.endsWith('parent-loss'), rootRetained: true, status: 'passed' });
  } finally {
    if (!terminal) child.kill();
    // No delete on either success or failure. Controller retains actual PROCESS
    // handles and performs exact-owned cleanup; wrapper-death tests never hold JOB.
    await bounded(exited, 5000); await bounded(closed, 5000);
  }
});
