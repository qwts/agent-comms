// Client side of the broker protocol: custody checks before connecting,
// the account credential, and the soul a CLI call acts for.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { PROOF_HEADER, signBindingProof } from './binding-proof.mjs';
import { currentUid, assertOwnedDir, assertBindingFile, loadCredential, saveCredential, uidOf } from './platform/account-isolation.mjs';
import { checkBrokerCustody, connect } from './platform/local-channel.mjs';
import { savePrincipalCredential } from './platform/secret-store.mjs';
import { readHostConfig } from './host-config.mjs';
import { CommsError, fail } from './errors.mjs';
import { lineReader, PROTOCOL_VERSION, writeLine } from './wire.mjs';

export { loadCredential, uidOf } from './platform/account-isolation.mjs';
export { checkBrokerCustody } from './platform/local-channel.mjs';

const REQUEST_TIMEOUT_MS = 10_000;

function open(file, request, { onEvent, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!onEvent && (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
    fail('usage', 'request timeout must be a positive integer of at most 2147483647 milliseconds');
  }
  return new Promise((resolve, reject) => {
    const socket = connect(file);
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const cancel = () => finish();
    if (!onEvent) {
      // A deadline, not an idle timeout: partial replies cannot extend it.
      timer = setTimeout(() => finish(new CommsError('broker-timeout', `broker request timed out after ${timeoutMs}ms`)), timeoutMs);
    }
    socket.on('connect', () => writeLine(socket, { v: PROTOCOL_VERSION, ...request }));
    socket.on('error', (error) => finish(new CommsError('broker-unreachable', `cannot reach the broker: ${error.code ?? error.message}`)));
    socket.on('close', () => finish(new CommsError('broker-unreachable', 'the broker closed the connection')));
    lineReader(socket, (line) => {
      if (settled) return;
      if (onEvent && line.event) {
        onEvent(line);
        return;
      }
      if (!line.ok) finish(new CommsError(line.error?.code ?? 'internal', line.error?.message ?? 'request failed'));
      else if (!onEvent) finish(null, line);
    }, (error) => finish(new CommsError('bad-response', error.message)));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

export function call(paths, credential, request, options) {
  checkBrokerCustody(paths, credential.brokerUid, credential.mode ?? 'group');
  return open(paths.socket, { ...request, auth: credential && { account: credential.account, secret: credential.secret } }, {
    timeoutMs: options?.timeoutMs,
  });
}

export function stream(paths, credential, request, onEvent, { signal } = {}) {
  checkBrokerCustody(paths, credential.brokerUid, credential.mode ?? 'group');
  return open(paths.socket, { ...request, auth: { account: credential.account, secret: credential.secret } }, { onEvent, signal });
}

const RETRYABLE = new Set(['broker-unreachable', 'broker-timeout']);
const SEEN_LIMIT = 10_000;

function delay(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

export async function watch(paths, credential, request, onEvent, { signal } = {}) {
  const seen = new Set();
  let retryInMs = 250;
  let disconnected = false;
  while (!signal?.aborted) {
    try {
      await stream(paths, credential, request, (event) => {
        if (event.event === 'ready') {
          retryInMs = 250;
          disconnected = false;
        }
        const id = event.event === 'message' ? event.message?.id : null;
        if (id) {
          if (seen.has(id)) return;
          seen.add(id);
          if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
        }
        onEvent(event);
      }, { signal });
      return;
    } catch (error) {
      if (signal?.aborted) return;
      // Custody failures and typed refusals need intervention, not retries.
      if (!RETRYABLE.has(error.code)) throw error;
      if (!disconnected) onEvent({ event: 'disconnected', code: error.code, retryInMs });
      disconnected = true;
      await delay(retryInMs, signal);
      retryInMs = Math.min(retryInMs * 2, 10_000);
    }
  }
}

export function callPrincipal(paths, credential, request, options) {
  checkBrokerCustody(paths, credential.brokerUid, credential.mode ?? 'group');
  return open(paths.socket, { ...request, auth: { principal: credential.principal, secret: credential.secret } }, options);
}

const principalPaths = (client) => ({ ...client, credential: path.join(client.dir, 'principal.json') });

export const loadPrincipalCredential = (client) => loadCredential(principalPaths(client));

export async function pairPrincipal(paths, client, name = null, env = process.env, host = readHostConfig(env)) {
  const account = loadCredential(client);
  const secret = randomBytes(32).toString('hex');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const result = await call(paths, account, { op: 'principal-pair-request', name, secretHash });
  const credential = {
    principal: result.principal, secret, brokerUid: account.brokerUid,
    pairedAt: new Date().toISOString(), account: account.account,
  };
  saveCredential(principalPaths(client), credential);
  savePrincipalCredential(credential, host, env);
  return { principal: result.principal, code: result.code, state: result.state };
}

let vouchCache;

function gitDir(cwd) {
  try {
    const value = execFileSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.resolve(cwd, value);
  } catch { return null; }
}

export function resolveBinding(env = process.env, cwd = process.cwd()) {
  const dir = gitDir(cwd);
  const file = env.AGENT_BOT_BINDING ? path.resolve(cwd, env.AGENT_BOT_BINDING) : (dir && path.join(dir, 'agent-binding.json'));
  if (!file) return null;
  let info;
  try { info = lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT' && !env.AGENT_BOT_BINDING) return null;
    fail('binding-untrusted', `cannot read binding file ${file}`);
  }
  assertBindingFile(info, file);
  try {
    const binding = JSON.parse(readFileSync(file, 'utf8'));
    if (binding.v !== 1 || !['agentId', 'parent', 'account', 'daemon', 'secret'].every((key) => key in binding)
      || typeof binding.agentId !== 'string' || (binding.parent !== null && typeof binding.parent !== 'string')
      || typeof binding.account !== 'string' || typeof binding.daemon !== 'string' || typeof binding.secret !== 'string') throw new Error('invalid shape');
    // The secret goes wherever `daemon` points, so only the loopback daemon qualifies.
    const daemon = new URL(binding.daemon);
    if (daemon.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(daemon.hostname)) throw new Error('not loopback');
    return binding;
  } catch { fail('binding-untrusted', `${file} has an invalid binding`); }
}

export function soulContext(env = process.env, cwd = process.cwd()) {
  const binding = resolveBinding(env, cwd);
  if (binding) {
    if (env.QWTS_AGENT_ID && env.QWTS_AGENT_ID !== binding.agentId) fail('soul-mismatch', 'QWTS_AGENT_ID does not match the worktree binding');
    return { agentId: binding.agentId, parent: binding.parent ?? null, source: 'binding', binding };
  }
  if (env.QWTS_AGENT_ID) return { agentId: env.QWTS_AGENT_ID, parent: null, source: 'env' };
  try {
    const id = execFileSync('git', ['config', '--get', 'agentBot.agentId'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (id) return { agentId: id, parent: null, source: 'git-config' };
  } catch { /* no bootstrap claim */ }
  fail('unbound', 'no soul here: set QWTS_AGENT_ID or run inside a worktree set up by `agent-bot setup-worktree`');
}

export function resolveParent(env = process.env, cwd = process.cwd()) { return resolveBinding(env, cwd)?.parent ?? null; }
export function resolveSoul(env = process.env, cwd = process.cwd()) { return soulContext(env, cwd).agentId; }

export function vouch(context) {
  if (!context.binding) return Promise.resolve(null);
  const key = `${context.binding.daemon}\0${context.binding.secret}`;
  if (vouchCache?.key === key && vouchCache.exp * 1000 - Date.now() > 30_000) {
    if (context.parent == null && vouchCache.parent) context.parent = vouchCache.parent;
    return Promise.resolve(vouchCache.token);
  }
  if (vouchCache?.key === key && vouchCache.pending) return vouchCache.pending;
  let target;
  try { target = new URL('/v0/vouch', context.binding.daemon); }
  catch { return Promise.reject(new CommsError('daemon-unreachable', 'cannot reach the agent-bot daemon; make sure it is running (`agent-bot daemon start`)')); }
  const pending = new Promise((resolve, reject) => {
    // A one-time proof, never the secret (ADR-0008 decision 3 as amended): a
    // process squatting the daemon's port while it is down learns nothing reusable.
    const proof = signBindingProof({ secret: context.binding.secret, method: 'POST', path: target.pathname, authority: target.host });
    const req = http.request(target, { method: 'POST', headers: { [PROOF_HEADER]: proof, 'content-type': 'application/json' }, timeout: 3000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) throw new Error('non-2xx response');
          const result = JSON.parse(data);
          if (typeof result.token !== 'string' || result.agentId !== context.agentId || !Number.isFinite(Number(result.exp))) throw new Error('invalid vouch response');
          vouchCache = { key, token: result.token, exp: Number(result.exp), parent: result.parent ?? null };
          if (context.parent == null && result.parent) context.parent = result.parent;
          resolve(result.token);
        } catch { vouchCache = null; reject(new CommsError('daemon-unreachable', 'cannot obtain a soul token; make sure the agent-bot daemon is running (`agent-bot daemon start`)')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => { vouchCache = null; reject(new CommsError('daemon-unreachable', 'cannot reach the agent-bot daemon; make sure it is running (`agent-bot daemon start`)')); });
    req.end(JSON.stringify({ aud: 'agent-comms' }));
  });
  vouchCache = { key, pending, exp: 0 };
  return pending;
}

export const admin = (paths, request, options) => open(paths.admin, request, { timeoutMs: options?.timeoutMs });

export async function pair(paths, clientPaths, brokerAccount, account = os.userInfo().username, mode = 'group') {
  if (mode === 'group' && !brokerAccount) fail('usage', 'name the broker account: agent-comms account pair --broker ACCOUNT');
  const brokerUid = mode === 'single-account' ? currentUid() : uidOf(brokerAccount);
  checkBrokerCustody(paths, brokerUid, mode);
  if (mode === 'group') assertOwnedDir(paths.proofs, brokerUid, { mode: 0o1777 });
  else assertOwnedDir(paths.proofs, brokerUid, { mode: 0o700 });
  const secret = randomBytes(32).toString('hex');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const proof = `${randomBytes(16).toString('hex')}.proof`;
  const proofFile = path.join(paths.proofs, proof);
  writeFileSync(proofFile, secretHash, { mode: 0o644, flag: 'wx' });
  try {
    const result = await open(paths.socket, { op: 'pair-request', account, secretHash, proof });
    saveCredential(clientPaths, { account, secret, brokerUid, mode, pairedAt: new Date().toISOString() });
    return result;
  } finally {
    rmSync(proofFile, { force: true });
  }
}
