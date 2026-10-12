import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('classic supervisor exchanges bounded control records with stdin still open', { skip: process.platform !== 'win32' }, async () => {
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('../tools/acceptance/windows-capacity-job.ps1', import.meta.url));
  const child = spawn(shell, ['-NoProfile','-NonInteractive','-File',script], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
  let terminal = false, bytes = '', fault, stderrBytes = 0;
  const records = new Map(), phases = new Set();
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
          if (!['script-entry','compile-supervisor'].includes(value.phase)) { fault = true; return; }
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
    assert.deepEqual([...phases].sort(), ['compile-supervisor','script-entry']);
    child.stdin.write('{"id":1,"op":"close"}\n');
    // Do not send EOF: this checks the same live duplex control path as attach.
    const closed = await record(1);
    assert.equal(closed.ok, true); assert.equal(closed.closed, true); assert.equal(closed.jobEmptyConfirmed, true);
    const result = await terminalWithin(5000);
    assert.equal(result?.code, 0); assert.equal(stderrBytes, 0);
  } finally {
    if (!terminal) child.kill();
    const result = await terminalWithin(5000);
    assert.notEqual(result, null, 'owned supervisor terminal unconfirmed');
  }
});
