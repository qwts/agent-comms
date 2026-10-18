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
    skipRelayVerificationForTests: true,
    spawnProcess(file, args) {
      captured = { file, args: [...args] };
      return child;
    },
  });
  raw.destroy();
  if (!captured) throw new Error('production-relay-spawn-not-captured');
  const { file, args } = captured;
  const serializedCommandLineLength = file.length + 2 + args.reduce((length, arg) => length + arg.length, 0)
    + args.length + 2;
  return { file, args, serializedCommandLineLength };
}
