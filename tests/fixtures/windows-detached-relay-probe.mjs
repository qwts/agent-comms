import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { connectWindowsPipe } from '../../lib/platform/windows-pipe-client.mjs';

const pipe = process.argv[2];
assert.equal(typeof pipe, 'string');
assert.ok(pipe.startsWith('\\\\.\\pipe\\agent-comms.detached-probe.'));

let server;
let raw;
let relay;
let relayExit;
let relayClose;
let rawClose;
let serverClosed = false;
const sockets = new Set();

const serverReady = new Promise((resolve, reject) => {
  server = net.createServer((socket) => {
    if (sockets.size !== 0) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('data', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.once('error', reject);
  server.listen(pipe, () => resolve());
});

async function within(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
process.send({ id: 0, ready: true });

process.on('message', async ({ id, op, expectedRelayArgs }) => {
  try {
    if (op === 'start') {
      await serverReady;
      let spawnCount = 0;
      raw = connectWindowsPipe(pipe, {
        spawnProcess(file, args, options) {
          spawnCount += 1;
          const exactArgs = Array.isArray(expectedRelayArgs) && args.length === expectedRelayArgs.length
            && args.every((value, index) => value === expectedRelayArgs[index]);
          if (spawnCount !== 1 || file !== 'powershell.exe' || !exactArgs
              || options.windowsHide !== true
              || JSON.stringify(options.stdio) !== JSON.stringify(['pipe', 'pipe', 'pipe'])
              || options.detached !== undefined) throw new Error('production-relay-spawn-mismatch');
          const child = spawn(file, args, { ...options, detached: true });
          relay = child;
          relayExit = new Promise((resolve) => {
            child.once('error', () => resolve({ code: null }));
            child.once('exit', (code, signal) => resolve({ code, signal }));
          });
          relayClose = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
          return child;
        },
      });
      rawClose = new Promise(resolve => raw.once('close', resolve));
      raw.on('data', () => {});
      await new Promise((resolve, reject) => {
        raw.once('connect', resolve);
        raw.once('error', reject);
      });
      process.send({ id, connected: true, detached: true, windowsHide: true, stdioPipes: true, productionArgsExact: true });
    } else if (op === 'stop') {
      if (!raw || !relay) throw new Error('relay-not-started');
      raw.end();
      const result = await within(relayExit, 5000, 'relay-natural-exit-deadline');
      const closed = await within(relayClose, 5000, 'relay-close-deadline');
      if (result.code !== 0 || result.signal !== null || closed.code !== 0 || closed.signal !== null) throw new Error('relay-natural-exit-not-zero');
      const rawEnded = await within(rawClose, 5000, 'raw-close-deadline');
      if (raw.readableEnded !== true || raw.writableEnded !== true || rawEnded !== undefined) throw new Error('raw-eof-unconfirmed');
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      serverClosed = true;
      if (sockets.size !== 0) throw new Error('pipe-server-not-empty');
      process.send({ id, stopped: true, exitCode: closed.code, signal: closed.signal, serverClosed: true, rawReadableEnded: raw.readableEnded, rawWritableEnded: raw.writableEnded });
    } else if (op === 'shutdown') {
      if (!serverClosed) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        serverClosed = true;
      }
      process.send({ id, shutdown: true, serverClosed: true }, () => process.disconnect());
    } else {
      throw new Error('unknown-operation');
    }
  } catch {
    process.send({ id, ok: false, code: 'probe-operation-failed' });
  }
});
