import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { connectWindowsPipe } from '../../lib/platform/windows-pipe-client.mjs';

export function captureProductionWindowsRelay() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.signalCode = 'SIGTERM';
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.emit('close', null, 'SIGTERM');
    return true;
  };
  let captured;
  const raw = connectWindowsPipe('\\\\.\\pipe\\agent-comms.test.S-1-5-21-123', {
    env: {},
    spawnProcess(_file, args) {
      captured = [...args];
      return child;
    },
  });
  raw.destroy();
  if (!captured) throw new Error('production-relay-spawn-not-captured');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const executable = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const serializedCommandLineLength = executable.length + 2 + captured.reduce((length, arg) => length + arg.length, 0)
    + captured.length + 2; // Each argument is space-separated; the executable and final command argument are quoted.
  return { args: captured, serializedCommandLineLength };
}
