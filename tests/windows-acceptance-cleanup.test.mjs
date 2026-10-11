import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupWindowsAcceptance, writeWindowsAcceptanceReport } from '../scripts/windows-acceptance-cleanup.mjs';

test('locked runtime and task directories preserve original failure and writable report', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'acceptance-report-'));
  try {
    const result = { cases: [{ name: 'restart', status: 'failed', code: 'Error' }], failure: { code: 'Error' } };
    const removals = [];
    const commands = [];
    const cleaned = await cleanupWindowsAcceptance({ result, root: 'locked-runtime', local: 'local',
      taskLabels: ['test.one', 'test.two'], stopSupervisor() { throw new Error('secret output'); },
      async command(file, args) { commands.push(args); return { exit: args[0] === '/Query' ? 1 : 0 }; },
      remove(target, options) { removals.push({ target, options }); throw Object.assign(new Error('credential contents'), { code: 'EPERM' }); } });
    assert.equal(cleaned, false);
    assert.equal(commands.length, 6, 'one failed cleanup does not skip later tasks');
    assert.equal(removals.length, 3);
    assert.ok(removals.every(entry => entry.options.maxRetries > 0));
    assert.deepEqual(result.failure, { code: 'Error' });
    assert.equal(result.retainedRuntimeDirectory, 'locked-runtime');
    const report = path.join(directory, 'report', 'acceptance.json');
    writeWindowsAcceptanceReport(report, result);
    const bytes = readFileSync(report, 'utf8');
    assert.equal(JSON.parse(bytes).cases[0].status, 'failed');
    assert.ok(!bytes.includes('secret output') && !bytes.includes('credential contents'));
    assert.equal(JSON.parse(bytes).cleanupErrors.at(-1).code, 'EPERM');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a task still present makes cleanup fail even when all files are removable', async () => {
  const result = {};
  assert.equal(await cleanupWindowsAcceptance({ result, root: 'r', local: 'l', taskLabels: ['test.one'],
    command: async () => ({ exit: 0 }), remove() {} }), false);
  assert.deepEqual(result.cleanupErrors, [{ operation: 'verify-task-absence', code: 'cleanup-failed' }]);
});
