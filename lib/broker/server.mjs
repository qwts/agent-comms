// Socket lifecycle and the line protocol used by both broker endpoints.

import {
  chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { assertAncestors, assertOwnedDir } from '../custody.mjs';
import { CommsError, fail } from '../errors.mjs';
import { lineReader, PROTOCOL_VERSION, writeLine } from '../wire.mjs';

export const STREAMING = Symbol('streaming');

// One broker per state directory. The lock holds the owner's pid; a lock
// whose pid is gone is left over from a crash and may be taken.
function takeLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const pid = Number(readFileSync(file, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = Number.isInteger(pid) && pid > 0;
    } catch (error) {
      alive = error.code === 'EPERM';
    }
    if (alive) break;
    rmSync(file, { force: true });
  }
  fail('broker-running', `another broker holds ${file}`);
}

// Unlink a socket only when nothing answers on it, so a second broker cannot
// take over the rendezvous path from a running one.
export async function removeStaleSocket(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return;
  }
  if (!stat.isSocket()) fail('socket-path-occupied', `${file} exists and is not a socket`);
  const live = await new Promise((resolve) => {
    const probe = net.createConnection(file);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  if (live) fail('broker-running', `another broker is already answering on ${file}`);
  unlinkSync(file);
}

export function prepare(broker) {
  const { shared, proofs, state } = broker.paths;
  const uid = process.getuid();
  // Refuse a rendezvous path another account could have planted: check the
  // ancestors and ownership before touching modes, so a foreign directory or
  // symlink stops the broker instead of being adopted.
  mkdirSync(shared, { recursive: true, mode: 0o755 });
  assertAncestors(shared, uid, 'shared-dir-untrusted');
  assertOwnedDir(shared, uid, { code: 'shared-dir-untrusted' });
  chmodSync(shared, 0o755); // no client account may replace the socket
  mkdirSync(proofs, { recursive: true, mode: 0o755 });
  assertOwnedDir(proofs, uid, { code: 'shared-dir-untrusted' });
  chmodSync(proofs, 0o1777);
  // The event log is the broker's authority, so its directory must pass
  // custody before a single record is replayed: another account able to
  // write there could forge pairings or messages.
  mkdirSync(state, { recursive: true, mode: 0o700 });
  assertAncestors(state, uid, 'state-dir-untrusted');
  const stateDir = assertOwnedDir(state, uid, { code: 'state-dir-untrusted' });
  if ((stateDir.mode & 0o022) !== 0) fail('state-dir-untrusted', `${state} is writable by accounts other than the broker's`);
  chmodSync(state, 0o700);
  const lock = path.join(state, 'broker.lock');
  takeLock(lock);
  broker.lock = lock;
  return uid;
}

export async function stop(broker) {
  const closing = broker.servers.map((server) => new Promise((resolve) => server.close(resolve)));
  for (const socket of broker.connections) socket.destroy();
  await Promise.all(closing);
  broker.servers = [];
  broker.watchers.clear();
  if (broker.lock) rmSync(broker.lock, { force: true });
  broker.lock = null;
}

export function listen(broker, file, handler, mode) {
  const server = net.createServer((socket) => {
    broker.connections.add(socket);
    socket.on('close', () => broker.connections.delete(socket));
    let handled = false;
    lineReader(socket, (request) => {
      if (handled) return;
      handled = true;
      try {
        if (request?.v !== PROTOCOL_VERSION) {
          fail('protocol-version', `this broker speaks protocol ${PROTOCOL_VERSION}`);
        }
        const result = handler(request, socket);
        if (result === STREAMING) return;
        writeLine(socket, { ok: true, ...result });
      } catch (error) {
        const code = error instanceof CommsError ? error.code : 'internal';
        const message = error instanceof CommsError ? error.message : 'the broker hit an internal error';
        if (!(error instanceof CommsError)) console.error(error);
        writeLine(socket, { ok: false, error: { code, message } });
      }
      socket.end();
    }, (error) => {
      // Stop reading, flush the refusal, then drop the connection.
      socket.pause();
      socket.end(`${JSON.stringify({ ok: false, error: { code: 'bad-request', message: error.message } })}\n`, () => socket.destroy());
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => {
      chmodSync(file, mode);
      resolve(server);
    });
  });
}
