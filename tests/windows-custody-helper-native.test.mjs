import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, openSync, fsyncSync, closeSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAccountIsolation } from '../lib/platform/account-isolation.mjs';
import { verifyWindowsRelay } from '../lib/platform/windows-relay-artifact.mjs';
import { durableReplace } from '../lib/platform/durable-file.mjs';

test('verified GUI helper performs fresh Unicode custody and SID checks without PowerShell', {
  skip: process.platform !== 'win32', timeout: 30000,
}, t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "custody-'unicode-日-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "owner's file-日");
  writeFileSync(file, 'inert');
  const env = { ...process.env, PATH: path.join(process.env.SystemRoot, 'System32'), PSModulePath: 'CANARY-invalid-modules' };
  const isolation = createAccountIsolation('win32', { env });
  assert.deepEqual(isolation.inspect([], 'custody-test'), []);
  const sid = isolation.currentUid();
  // Elevated developer/CI tokens can initially assign Administrators as owner.
  // Make this private test fixture explicitly user-owned before testing it.
  const ownership = spawnSync(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'),
    [root, '/setowner', `*${sid}`, '/T'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(ownership.error, undefined);
  assert.equal(ownership.status, 0, 'private fixture ownership setup failed');
  assert.equal(isolation.systemUidOf(os.userInfo().username), sid);
  assert.deepEqual(isolation.inspect([root, file, path.join(root, 'missing')], 'custody-test'), [
    { owner: sid, kind: 'directory', link: false }, { owner: sid, kind: 'file', link: false }, null,
  ]);
  assert.throws(() => isolation.assertOwnedDir(root, 'S-1-0-0'), { code: 'broker-untrusted' });
  rmSync(file);
  assert.deepEqual(isolation.inspect([file], 'custody-test'), [null], 'file state is read again, never cached');
  assert.throws(() => isolation.systemUidOf('owner\nCANARY'), { code: 'usage' });
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  try {
    const next = path.join(root, 'next-日.tmp');
    writeFileSync(next, 'new bytes');
    const fd = openSync(next, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    writeFileSync(file, 'old bytes');
    durableReplace(next, file);
    assert.equal(readFileSync(file, 'utf8'), 'new bytes');
    assert.equal(existsSync(next), false);
  } finally { process.env.PATH = previousPath; }
  const binary = verifyWindowsRelay();
  for (const args of [['--SID'], ['--inspect', 'CANARY-extra'], ['--replace', 'CANARY-extra'], ['--unknown']]) {
    const result = spawnSync(binary, args, { input: '', encoding: 'utf8', env, windowsHide: true, timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
