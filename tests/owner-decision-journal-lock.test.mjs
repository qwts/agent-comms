import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireOwnerJournalLock as acquire } from '../lib/platform/owner-journal-lock.mjs';
const darwin = { skip: process.platform !== 'darwin', timeout: 12000 };
const moduleUrl = new URL('../lib/platform/owner-journal-lock.mjs', import.meta.url).href;
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-journal-lock-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function child(t, source, args = []) {
  const c = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; let bytes = 0;
  for (const stream of [c.stdout, c.stderr]) stream.on('data', chunk => {
    bytes += chunk.length; if (bytes > 32768) c.kill('SIGKILL'); else output += chunk;
  });
  const done = once(c, 'close'); const timer = setTimeout(() => c.kill('SIGKILL'), 8000);
  done.finally(() => clearTimeout(timer));
  t.after(async () => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); await done; assert(bytes <= 32768, output); });
  return { c, done, output: () => output };
}
test('Darwin kernel lock refuses same-process and child contention without replacing its inode', darwin, async t => {
  const dir = temporary(t); const fd = acquire(dir); t.after(() => fs.closeSync(fd));
  const before = fs.lstatSync(path.join(dir, '.journal-lock'));
  assert.throws(() => acquire(dir), { message: 'owner-journal-busy' });
  const { c, done, output } = child(t, `import { acquireOwnerJournalLock } from ${JSON.stringify(moduleUrl)};
    try { acquireOwnerJournalLock(process.argv[1]); process.exit(1); }
    catch(e) { process.stdout.write(e.message); process.exit(e.message === 'owner-journal-busy' ? 0 : 2); }`, [dir]);
  const [code] = await done; assert.equal(code, 0, output());
  assert.equal(output(), 'owner-journal-busy'); assert.equal(c.signalCode, null);
  const after = fs.lstatSync(path.join(dir, '.journal-lock')); assert.equal(after.ino, before.ino); assert.equal(after.nlink, 1);
});
test('Darwin kernel releases a killed child holder and reuses the fixed lock inode', darwin, async t => {
  const dir = temporary(t);
  const { c, done, output } = child(t, `import { acquireOwnerJournalLock } from ${JSON.stringify(moduleUrl)};
    acquireOwnerJournalLock(process.argv[1]); process.send('locked'); setInterval(() => {}, 1000);`, [dir]);
  assert.deepEqual(await once(c, 'message'), ['locked', undefined]);
  const before = fs.lstatSync(path.join(dir, '.journal-lock'));
  assert.throws(() => acquire(dir), { message: 'owner-journal-busy' });
  c.kill('SIGKILL'); await done; assert.equal(output(), '');
  const fd = acquire(dir); try { assert.equal(fs.fstatSync(fd).ino, before.ino); } finally { fs.closeSync(fd); }
});
test('spawned exec child does not retain the parent journal descriptor after parent closes it', darwin, async t => {
  const dir = temporary(t); let fd = acquire(dir);
  t.after(() => { if (fd !== undefined) fs.closeSync(fd); });
  const { c } = child(t, `process.send('ready'); setInterval(() => {}, 1000);`);
  await once(c, 'message'); fs.closeSync(fd); fd = undefined;
  const next = acquire(dir); try { assert.equal(c.exitCode, null); } finally { fs.closeSync(next); }
});

test('an established lock removed between lstat and open is never recreated', darwin, t => {
  const dir = temporary(t); const held = acquire(dir); fs.closeSync(held);
  const file = path.join(dir, '.journal-lock'); let removed = false;
  const io = { ...fs, lstatSync: name => {
    const info = fs.lstatSync(name); if (name === file && !removed) { fs.unlinkSync(file); removed = true; } return info;
  }, openSync: (name, flags, mode) => { assert.equal(flags & fs.constants.O_CREAT, 0); return fs.openSync(name, flags, mode); } };
  assert.throws(() => acquire(dir, { io }), { message: 'owner-journal-storage-failed' });
  assert(removed); assert(!fs.existsSync(file));
});
test('racing first creators use exclusive creation and preserve the winning inode', darwin, t => {
  const dir = temporary(t); const file = path.join(dir, '.journal-lock'); let inode;
  const io = { ...fs, openSync: (name, flags, mode) => {
    assert(flags & fs.constants.O_CREAT); assert(flags & fs.constants.O_EXCL);
    fs.writeFileSync(file, '', { mode: 0o600, flag: 'wx' }); inode = fs.lstatSync(file).ino; return fs.openSync(name, flags, mode);
  } };
  assert.throws(() => acquire(dir, { io }), { message: 'owner-journal-busy' });
  assert.equal(fs.lstatSync(file).ino, inode); const fd = acquire(dir); fs.closeSync(fd);
});

test('unsupported platforms refuse before touching the supplied path', { skip: process.platform === 'darwin' }, () => {
  assert.throws(() => acquire('/path-not-created-secret'), { message: 'owner-journal-platform-unsupported' });
});
