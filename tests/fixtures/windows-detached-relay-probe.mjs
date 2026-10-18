import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { projectRelayExitOutcome } from '../helpers/windows-relay-exit-outcome.mjs';
import { waitForProbeConnect } from '../helpers/windows-probe-connect.mjs';
import { connectWindowsPipe } from '../../lib/platform/windows-pipe-client.mjs';
import { projectWindowsPipeStage } from '../../lib/platform/windows-pipe-stage.mjs';

const pipe = process.argv[2];
const mode = process.argv[3] ?? 'detached';
assert.ok(['production', 'detached'].includes(mode));
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
const reportStage = stage => { if (process.connected) process.send({ id: -2, stage }); };
const reportConnector = (event, detail) => {
  if (!process.connected) return;
  const record = { id: -3, event };
  if (event === 'raw-error') record.errorStage = detail;
  if (event === 'relay-exit') Object.assign(record, detail);
  process.send(record);
};

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
      reportStage('fixture-start-requested');
      await serverReady;
      reportStage('pipe-listening');
      let spawnCount = 0;
      raw = connectWindowsPipe(pipe, {
        spawnProcess(file, args, options) {
          spawnCount += 1;
          const exactArgs = Array.isArray(expectedRelayArgs) && args.length === expectedRelayArgs.length
            && args.every((value, index) => value === expectedRelayArgs[index]);
          if (spawnCount !== 1 || file !== 'powershell.exe' || !exactArgs
              || options.windowsHide !== true
              || !Array.isArray(options.stdio) || options.stdio.length !== 3
              || !options.stdio.every(value => value === 'pipe')
              || options.detached !== false) throw new Error('production-relay-spawn-mismatch');
          reportStage('spawn-request-validated');
          const child = spawn(file, args, mode === 'detached' ? { ...options, detached: true } : options);
          reportStage('relay-process-spawned');
          relay = child;
          relayExit = new Promise((resolve) => {
            child.once('error', () => { reportConnector('relay-error'); resolve({ code: null }); });
            child.once('exit', (code, signal) => { reportConnector('relay-exit', projectRelayExitOutcome(code, signal)); resolve({ code, signal }); });
          });
          relayClose = new Promise((resolve) => child.once('close', (code, signal) => {
            reportConnector('relay-close');
            resolve({ code, signal });
          }));
          return child;
        },
      });
      rawClose = new Promise(resolve => raw.once('close', resolve));
      raw.on('data', () => {});
      let connectorSettled = false;
      let pendingTimer;
      const settleConnector = (event, errorStage) => {
        connectorSettled = true;
        clearTimeout(pendingTimer);
        pendingTimer = undefined;
        reportConnector(event, errorStage);
      };
      raw.once('connect', () => settleConnector('raw-connect'));
      raw.once('error', error => settleConnector('raw-error', projectWindowsPipeStage(error) ?? 'unclassified'));
      raw.once('close', () => settleConnector('raw-close'));
      pendingTimer = setTimeout(() => {
        pendingTimer = undefined;
        if (!connectorSettled) reportConnector('pending-after-12s');
      }, 12_000);
      await waitForProbeConnect(raw);
      reportStage('relay-connected');
      process.send({ id, connected: true, detached: mode === 'detached', windowsHide: true, stdioPipes: true, productionArgsExact: true });
    } else if (op === 'stop') {
      if (!raw || !relay) throw new Error('relay-not-started');
      reportStage('relay-stop-requested');
      raw.end();
      const result = await within(relayExit, 5000, 'relay-natural-exit-deadline');
      reportStage('relay-natural-exit');
      const closed = await within(relayClose, 5000, 'relay-close-deadline');
      reportStage('relay-stdio-closed');
      if (result.code !== 0 || result.signal !== null || closed.code !== 0 || closed.signal !== null) throw new Error('relay-natural-exit-not-zero');
      const rawEnded = await within(rawClose, 5000, 'raw-close-deadline');
      if (raw.readableEnded !== true || raw.writableEnded !== true || rawEnded !== undefined) throw new Error('raw-eof-unconfirmed');
      reportStage('raw-eof');
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      serverClosed = true;
      if (sockets.size !== 0) throw new Error('pipe-server-not-empty');
      reportStage('pipe-server-closed');
      process.send({ id, stopped: true, exitCode: closed.code, signal: closed.signal, serverClosed: true, rawReadableEnded: raw.readableEnded, rawWritableEnded: raw.writableEnded });
    } else if (op === 'shutdown') {
      reportStage('fixture-shutdown-requested');
      if (!serverClosed) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        serverClosed = true;
      }
      reportStage('fixture-shutdown-complete');
      process.send({ id, shutdown: true, serverClosed: true }, () => process.disconnect());
    } else {
      throw new Error('unknown-operation');
    }
  } catch {
    process.send({ id, ok: false, code: 'probe-operation-failed' });
  }
});
