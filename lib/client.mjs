// Client side of the broker protocol: custody checks before connecting,
// the account credential, and the soul a CLI call acts for.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { assertAncestors, assertBrokerSocket, assertOwnedDir } from './custody.mjs';
import { CommsError, fail } from './errors.mjs';
import { lineReader, PROTOCOL_VERSION, writeLine } from './wire.mjs';

// ADR-0006 decision 1: refuse a broker unless its directory, ancestors, and
// socket belong to the broker account named at pairing. There is no trust on
// first use: `account pair --broker ACCOUNT` names it, and later calls use the
// uid recorded then.
export function checkBrokerCustody(paths, brokerUid) {
  if (!Number.isInteger(brokerUid)) fail('broker-untrusted', 'no broker account is pinned for this client');
  try {
    lstatSync(paths.socket);
  } catch {
    fail('broker-unreachable', `no broker socket at ${paths.socket}; is the broker running?`);
  }
  assertAncestors(paths.shared, brokerUid);
  const dir = assertOwnedDir(paths.shared, brokerUid);
  if ((dir.mode & 0o022) !== 0) fail('broker-untrusted', `${paths.shared} is writable by accounts other than the broker's`);
  assertBrokerSocket(paths.socket, brokerUid);
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
      if (!onEvent || !line.ok) socket.end();
    }, (error) => {
      // The reader has stopped, so nothing more on this connection is usable.
      settle(reject, new CommsError('bad-response', error.message));
      socket.destroy();
    });
  });
}

export function call(paths, credential, request) {
  checkBrokerCustody(paths, credential.brokerUid);
  return open(paths.socket, { ...request, auth: credential && { account: credential.account, secret: credential.secret } });
}

export function stream(paths, credential, request, onEvent) {
  checkBrokerCustody(paths, credential.brokerUid);
  return open(paths.socket, { ...request, auth: { account: credential.account, secret: credential.secret } }, { onEvent });
}

export const admin = (paths, request) => open(paths.admin, request);

// The credential pins the broker account, so whoever can replace it can
// point this client at their own socket. Its directory must be ours alone.
function assertClientDir(dir) {
  const uid = process.getuid();
  assertAncestors(dir, uid, 'client-dir-untrusted');
  const info = assertOwnedDir(dir, uid, { code: 'client-dir-untrusted' });
  if ((info.mode & 0o022) !== 0) fail('client-dir-untrusted', `${dir} is writable by accounts other than this one`);
}

export function loadCredential(clientPaths) {
  try {
    lstatSync(clientPaths.credential);
  } catch {
    return fail('unpaired', 'this account is not paired; run `agent-comms account pair`');
  }
  assertClientDir(clientPaths.dir);
  const info = lstatSync(clientPaths.credential);
  if (!info.isFile() || info.uid !== process.getuid()) fail('client-dir-untrusted', `${clientPaths.credential} is not this account's file`);
  try {
    return JSON.parse(readFileSync(clientPaths.credential, 'utf8'));
  } catch {
    return fail('unpaired', 'the saved credential is unreadable; pair again');
  }
}

function saveCredential(clientPaths, credential) {
  mkdirSync(clientPaths.dir, { recursive: true, mode: 0o700 });
  assertClientDir(clientPaths.dir);
  chmodSync(clientPaths.dir, 0o700);
  const temp = `${clientPaths.credential}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, clientPaths.credential);
}

export function uidOf(account) {
  try {
    return Number(execFileSync('/usr/bin/id', ['-u', account], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return fail('usage', `no account named ${account} on this machine`);
  }
}

export async function pair(paths, clientPaths, brokerAccount, account = os.userInfo().username) {
  if (!brokerAccount) fail('usage', 'name the broker account: agent-comms account pair --broker ACCOUNT');
  const brokerUid = uidOf(brokerAccount);
  checkBrokerCustody(paths, brokerUid);
  assertOwnedDir(paths.proofs, brokerUid, { mode: 0o1777 });
  const secret = randomBytes(32).toString('hex');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const proof = `${randomBytes(16).toString('hex')}.proof`;
  const proofFile = path.join(paths.proofs, proof);
  writeFileSync(proofFile, secretHash, { mode: 0o644, flag: 'wx' });
  try {
    const result = await open(paths.socket, { op: 'pair-request', account, secretHash, proof });
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
