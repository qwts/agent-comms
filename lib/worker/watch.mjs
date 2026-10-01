// The inbox watch. It runs as its own process, so stopping the worker stops
// the broker connection with it, and so a dropped watch can be restarted
// without disturbing the turn in flight.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { lineReader } from '../wire.mjs';

export const BIN = fileURLToPath(new URL('../../bin/agent-comms.mjs', import.meta.url));

export function watchInbox({ bin = BIN, soul, env, onEvent, log }) {
  const child = spawn(process.execPath, [bin, 'inbox', 'watch'], {
    env: { ...env, QWTS_AGENT_ID: soul },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  lineReader(child.stdout, onEvent, (error) => log('watch stream failed', error.message));
  return {
    kill: () => child.kill('SIGTERM'),
    closed: new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal }))),
  };
}
