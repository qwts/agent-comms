import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { connectWindowsPipe, legacyPowerShellEnv } from '../lib/platform/windows-pipe-client.mjs';

const PIPE = '\\\\.\\pipe\\agent-comms.test.S-1-5-21-123';

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killCount = 0;
  child.kill = () => {
    child.killCount += 1;
    child.signalCode = 'SIGTERM';
    child.stdout.end();
    child.stderr.end();
    child.emit('close', null, 'SIGTERM');
    return true;
  };
  return child;
}

test('legacy PowerShell environment removes every PSModulePath spelling without changing its input', () => {
  const input = { Path: 'system-path', PSModulePath: 'pwsh-modules', pSmOdUlEpAtH: 'another-path', sentinel: 'kept' };
  assert.deepEqual(legacyPowerShellEnv(input), { Path: 'system-path', sentinel: 'kept' });
  assert.deepEqual(input, { Path: 'system-path', PSModulePath: 'pwsh-modules', pSmOdUlEpAtH: 'another-path', sentinel: 'kept' });
});

test('Windows pipe connector waits for the child connection marker and forwards bytes both ways', async () => {
  const child = fakeChild();
  const callerEnv = { Path: 'system-path', PSModulePath: 'incompatible', keep: 'yes' };
  const observed = {};
  const raw = connectWindowsPipe(PIPE, {
    env: callerEnv,
    spawnProcess: (file, args, options) => {
      Object.assign(observed, { file, args, options });
      return child;
    },
  });
  let connected = false;
  raw.on('connect', () => { connected = true; });
  child.stderr.write('CONN');
  assert.equal(connected, false, 'partial readiness cannot send the hello');
  child.stderr.write('ECTED\n');
  assert.equal(connected, true);
  assert.equal(observed.file, 'powershell.exe');
  const command = observed.args.at(-1);
  const encodedWorker = /FromBase64String\('([^']+)'\)/.exec(command)?.[1];
  assert.ok(encodedWorker, 'the fixed PowerShell command should carry the relay source');
  const workerSource = Buffer.from(encodedWorker, 'base64').toString('utf16le');
  assert.match(workerSource, /PipeDirection\.InOut, PipeOptions\.Asynchronous,\s*TokenImpersonationLevel\.Identification/);
  assert.deepEqual(observed.options.env, { Path: 'system-path', keep: 'yes', AGENT_COMMS_PIPE_NAME: 'agent-comms.test.S-1-5-21-123' });
  assert.deepEqual(callerEnv, { Path: 'system-path', PSModulePath: 'incompatible', keep: 'yes' });

  const received = once(child.stdin, 'data');
  raw.write(Buffer.from('client bytes'));
  assert.equal((await received)[0].toString(), 'client bytes');
  const serverData = once(raw, 'data');
  child.stdout.write(Buffer.from('server bytes'));
  assert.equal((await serverData)[0].toString(), 'server bytes');
  raw.destroy();
});

test('Windows pipe connector refuses unexpected child status without exposing its output', async () => {
  const child = fakeChild();
  const raw = connectWindowsPipe(PIPE, { spawnProcess: () => child });
  const failed = once(raw, 'error');
  child.stderr.write('REFUSED\nsecret/path/detail');
  const [error] = await failed;
  assert.equal(error.code, 'ECONNREFUSED');
  assert.equal(error.message, 'named pipe connection failed');
});

test('Windows pipe bridge drains final bytes, propagates EOF, and closes its child handles on destroy', async () => {
  const child = fakeChild();
  const raw = connectWindowsPipe(PIPE, { spawnProcess: () => child });
  const chunks = [];
  raw.on('data', (chunk) => chunks.push(chunk));
  const ended = once(raw, 'end');
  const inputFinished = once(child.stdin, 'finish');
  child.stderr.write('CONNECTED\n');
  child.stdout.end(Buffer.from('final reply bytes'));
  await Promise.all([ended, inputFinished]);
  assert.equal(Buffer.concat(chunks).toString(), 'final reply bytes');
  assert.equal(raw.allowHalfOpen, false);

  raw.destroy();
  assert.equal(child.killCount, 1);
  assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
});

test('Windows pipe startup diagnostics classify unexpected output without exposing it', async () => {
  for (const [text, stage] of [
    ['#< CLIXML\r\n<Objs>private secret</Objs>', 'host-clixml'],
    ['private secret path\n', 'host-stderr'],
    ['REFUSED\n', 'pipe-refused'],
  ]) {
    const child = fakeChild();
    const raw = connectWindowsPipe(PIPE, { spawnProcess: () => child });
    const failed = once(raw, 'error');
    child.stderr.end(text);
    const [error] = await failed;
    assert.equal(error.windowsPipeStage, stage);
    assert.equal(error.message, 'named pipe connection failed');
    assert.equal(Object.keys(error).includes('windowsPipeStage'), false);
    assert.doesNotMatch(JSON.stringify(error), /private|secret|path/i);
  }
});
