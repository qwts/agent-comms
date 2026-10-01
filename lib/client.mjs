// Client side of the broker protocol: custody checks before connecting,
// the account credential, and the soul a CLI call acts for.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { CommsError, fail } from './errors.mjs';
import { lineReader, PROTOCOL_VERSION, writeLine } from './wire.mjs';

// ADR-0006 decision 1: refuse a broker whose directory a client account could
// have written, or whose socket belongs to someone other than the directory
// owner. `expectedUid` pins the broker account recorded at pairing.
export function checkBrokerCustody(paths, expectedUid = null) {
  let dir;
  let socket;
  try {
    dir = lstatSync(paths.shared);
    socket = lstatSync(paths.socket);
  } catch {
    fail('broker-unreachable', `no broker socket at ${paths.socket}; is the broker running?`);
  }
  if (!dir.isDirectory() || (dir.mode & 0o022) !== 0) {
    fail('broker-untrusted', `${paths.shared} is not a directory that only the broker account can write`);
  }
  if (!socket.isSocket() || socket.uid !== dir.uid) fail('broker-untrusted', `${paths.socket} is not the broker's socket`);
  if (expectedUid !== null && dir.uid !== expectedUid) {
    fail('broker-untrusted', `the broker directory is owned by uid ${dir.uid}, not the paired broker uid ${expectedUid}`);
  }
  return dir.uid;
}

function open(file, request, { onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };
    socket.on('connect', () => writeLine(socket, { v: PROTOCOL_VERSION, ...request }));
    socket.on('error', (error) => settle(reject, new CommsError('broker-unreachable', `cannot reach the broker: ${error.code ?? error.message}`)));
    socket.on('close', () => settle(reject, new CommsError('broker-unreachable', 'the broker closed the connection')));
    lineReader(socket, (line) => {
      if (onEvent && line.event) {
        onEvent(line);
        return;
      }
      if (line.ok) settle(resolve, line);
      else settle(reject, new CommsError(line.error?.code ?? 'internal', line.error?.message ?? 'request failed'));
      if (!onEvent) socket.end();
    }, (error) => settle(reject, new CommsError('bad-response', error.message)));
  });
}

export function call(paths, credential, request) {
  checkBrokerCustody(paths, credential?.brokerUid ?? null);
  return open(paths.socket, { ...request, auth: credential && { account: credential.account, secret: credential.secret } });
}

export function stream(paths, credential, request, onEvent) {
  checkBrokerCustody(paths, credential.brokerUid);
  return open(paths.socket, { ...request, auth: { account: credential.account, secret: credential.secret } }, { onEvent });
}

export const admin = (paths, request) => open(paths.admin, request);

export function loadCredential(clientPaths) {
  try {
    return JSON.parse(readFileSync(clientPaths.credential, 'utf8'));
  } catch {
    return fail('unpaired', 'this account is not paired; run `agent-comms account pair`');
  }
}

function saveCredential(clientPaths, credential) {
  mkdirSync(clientPaths.dir, { recursive: true, mode: 0o700 });
  const temp = `${clientPaths.credential}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, clientPaths.credential);
}

export async function pair(paths, clientPaths, account = os.userInfo().username) {
  const brokerUid = checkBrokerCustody(paths);
  const secret = randomBytes(32).toString('hex');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const proof = `${randomBytes(16).toString('hex')}.proof`;
  const proofFile = path.join(paths.proofs, proof);
  writeFileSync(proofFile, secretHash, { mode: 0o644, flag: 'wx' });
  try {
    const result = await call(paths, null, { op: 'pair-request', account, secretHash, proof });
    saveCredential(clientPaths, { account, secret, brokerUid, pairedAt: new Date().toISOString() });
    return result;
  } finally {
    rmSync(proofFile, { force: true });
  }
}

// ADR-0003 decision 3, bootstrap phase: the soul is a claim read from the
// ENG-0081 child override or the worktree's agent-bot config.
export function resolveSoul(env = process.env, cwd = process.cwd()) {
  if (env.QWTS_AGENT_ID) return env.QWTS_AGENT_ID;
  try {
    const id = execFileSync('git', ['config', '--get', 'agentBot.agentId'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (id) return id;
  } catch {
    // not a git checkout, or no agent-bot binding
  }
  return fail('unbound', 'no soul here: set QWTS_AGENT_ID or run inside a worktree set up by `agent-bot setup-worktree`');
}
