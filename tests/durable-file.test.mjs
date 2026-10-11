import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { durableReplace } from '../lib/platform/durable-file.mjs';

test('POSIX replacement syncs the containing directory and propagates ambiguous failure', () => {
  const calls = [];
  const io = {
    renameSync: (...args) => calls.push(['rename', ...args]),
    openSync: (...args) => { calls.push(['open', ...args]); return 3; },
    fsyncSync: (fd) => calls.push(['fsync', fd]),
    closeSync: (fd) => calls.push(['close', fd]),
  };
  durableReplace('/state/new.tmp', '/state/events.jsonl', { platform: 'linux', io });
  assert.deepEqual(calls, [['rename', '/state/new.tmp', '/state/events.jsonl'],
    ['open', '/state', 'r'], ['fsync', 3], ['close', 3]]);
  calls.length = 0;
  assert.throws(() => durableReplace('/state/new.tmp', '/state/events.jsonl', {
    platform: 'linux', io: { ...io, fsyncSync: () => { throw new Error('disk failure'); } },
  }), /disk failure/);
  assert.deepEqual(calls.at(-1), ['close', 3]);
});

test('Windows replacement uses checked write-through native move with literal path data', () => {
  const source = 'C:\\state\\quo\'te $value; Ω.tmp';
  const destination = 'C:\\state\\events.jsonl';
  const calls = [];
  durableReplace(source, destination, { platform: 'win32', run: (command, args, options) => {
    calls.push({ command, args, options }); return { status: 0, stdout: 'replaced' };
  } });
  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(command, 'powershell.exe');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.match(script, /MoveFileExW\(\$env:AGENT_COMMS_REPLACE_SOURCE, \$env:AGENT_COMMS_REPLACE_DESTINATION, 9\)/);
  assert.ok(!script.includes(source));
  assert.equal(options.env.AGENT_COMMS_REPLACE_SOURCE, path.win32.toNamespacedPath(source));
  assert.equal(options.env.AGENT_COMMS_REPLACE_DESTINATION, path.win32.toNamespacedPath(destination));
  for (const response of [{ status: 1, stdout: 'replaced' }, { status: 0, stdout: '' },
    { status: null, error: new Error('timeout') }]) {
    assert.throws(() => durableReplace(source, destination, {
      platform: 'win32', run: () => response,
    }), /restart and recover/);
  }
});

test('replacement refuses cross-directory paths and does not invoke a runner', () => {
  const run = () => assert.fail('invalid paths must not reach native code');
  for (const [source, destination] of [
    ['C:\\a\\new', 'C:\\b\\events'], ['C:\\a\\same', 'C:\\a\\same'],
    ['relative', 'C:\\a\\events'], ['C:\\a\\bad\0file', 'C:\\a\\events'],
  ]) assert.throws(() => durableReplace(source, destination, { platform: 'win32', run }), /sibling paths/);
});

test('native replacement preserves written bytes and leaves one authoritative path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-durable-'));
  try {
    const oldFile = path.join(dir, 'events.jsonl');
    const nextFile = path.join(dir, 'quote\' Ω.tmp');
    fs.writeFileSync(oldFile, 'old\n');
    const fd = fs.openSync(nextFile, 'wx', 0o600);
    try { fs.writeSync(fd, 'new Ω\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    durableReplace(nextFile, oldFile);
    assert.equal(fs.readFileSync(oldFile, 'utf8'), 'new Ω\n');
    assert.ok(!fs.existsSync(nextFile));
    fs.appendFileSync(oldFile, 'tail\n');
    assert.equal(fs.readFileSync(oldFile, 'utf8'), 'new Ω\ntail\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Windows replacement rebuilds classic PowerShell modules without changing caller environment', () => {
  const key = 'PSModulePath';
  const original = process.env[key];
  process.env[key] = 'C:\\PowerShell7\\Modules';
  try {
    durableReplace('C:\\state\\new.tmp', 'C:\\state\\events.jsonl', {
      platform: 'win32', run: (_command, _args, options) => {
        assert.ok(!Object.keys(options.env).some((name) => name.toLowerCase() === 'psmodulepath'));
        for (const [name, value] of Object.entries(process.env)) {
          if (name.toLowerCase() !== 'psmodulepath'
              && !['AGENT_COMMS_REPLACE_SOURCE', 'AGENT_COMMS_REPLACE_DESTINATION'].includes(name)) {
            assert.equal(options.env[name], value, `preserved caller setting ${name}`);
          }
        }
        return { status: 0, stdout: 'replaced' };
      },
    });
    assert.equal(process.env[key], 'C:\\PowerShell7\\Modules');
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});
