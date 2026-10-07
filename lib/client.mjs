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
import { brokerPin, checkBrokerCustody, connect } from './platform/local-channel.mjs';
import { savePrincipalCredential } from './platform/secret-store.mjs';
import { principalFileName, readHostConfig } from './host-config.mjs';
import { CommsError, fail } from './errors.mjs';
import { lineReader, PROTOCOL_VERSION, writeLine } from './wire.mjs';

export { loadCredential, uidOf } from './platform/account-isolation.mjs';
export { checkBrokerCustody } from './platform/local-channel.mjs';

const REQUEST_TIMEOUT_MS = 10_000;

// `trust` is what the pairing record pins for the broker; the local channel
// seam decides what, if anything, it verifies with it before `connect` fires.
function open(file, request, { onEvent, signal, timeoutMs = REQUEST_TIMEOUT_MS, trust } = {}) {
  if (!onEvent && (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
    fail('usage', 'request timeout must be a positive integer of at most 2147483647 milliseconds');
  }
  return new Promise((resolve, reject) => {
    const socket = connect(file, trust);
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
    // A typed refusal from the channel itself (a broker that failed to prove
    // its identity) keeps its code; anything else is the broker out of reach.
    socket.on('error', (error) => finish(error instanceof CommsError ? error : new CommsError('broker-unreachable', `cannot reach the broker: ${error.code ?? error.message}`)));
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
    timeoutMs: options?.timeoutMs, trust: credential,
  });
}

export function stream(paths, credential, request, onEvent, { signal } = {}) {
  checkBrokerCustody(paths, credential.brokerUid, credential.mode ?? 'group');
  return open(paths.socket, { ...request, auth: { account: credential.account, secret: credential.secret } }, { onEvent, signal, trust: credential });
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
  return open(paths.socket, { ...request, auth: { principal: credential.principal, secret: credential.secret } }, { ...options, trust: credential });
}

// The fields a credential carries to name its broker: the account pinned at
// pairing and whatever else the local channel pinned beside it.
const pinnedBroker = (credential) => ({ brokerUid: credential.brokerUid, ...(credential.brokerKey === undefined ? {} : { brokerKey: credential.brokerKey }) });

const principalPaths = (client, host) => ({ ...client, credential: path.join(client.dir, principalFileName(host)) });

export const loadPrincipalCredential = (client, host = readHostConfig()) => loadCredential(principalPaths(client, host));

export async function pairPrincipal(paths, client, name = null, env = process.env, host = readHostConfig(env)) {
  const account = loadCredential(client);
  const secret = randomBytes(32).toString('hex');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const result = await call(paths, account, { op: 'principal-pair-request', name, secretHash });
  const credential = {
    principal: result.principal, secret, ...pinnedBroker(account),
    pairedAt: new Date().toISOString(), account: account.account, mode: account.mode ?? 'group',
  };
  saveCredential(principalPaths(client, host), credential);
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

// The soul named by the environment. agent-bot documents AGENT_BOT_ID and
// sets it next to QWTS_AGENT_ID for the souls it runs; either works alone,
// and two that disagree are refused rather than guessed between
// (agent-bot-identity#382).
function envSoul(env) {
  const named = [env.AGENT_BOT_ID, env.QWTS_AGENT_ID].filter(Boolean);
  if (named.length === 2 && named[0] !== named[1]) fail('soul-mismatch', 'AGENT_BOT_ID and QWTS_AGENT_ID name different souls');
  return named[0] ?? null;
}

export function soulContext(env = process.env, cwd = process.cwd()) {
  const named = envSoul(env);
  const binding = resolveBinding(env, cwd);
  if (binding) {
    if (named && named !== binding.agentId) fail('soul-mismatch', 'AGENT_BOT_ID / QWTS_AGENT_ID does not match the worktree binding');
    return { agentId: binding.agentId, parent: binding.parent ?? null, source: 'binding', binding };
  }
  if (named) return { agentId: named, parent: null, source: 'env' };
  try {
    const id = execFileSync('git', ['config', '--get', 'agentBot.agentId'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (id) return { agentId: id, parent: null, source: 'git-config' };
  } catch { /* no bootstrap claim */ }
  fail('unbound', 'no soul here: set AGENT_BOT_ID, run `agent-bot join --name NAME --harness HARNESS`, or run inside a worktree set up by `agent-bot setup-worktree`');
}

export function resolveParent(env = process.env, cwd = process.cwd()) { return resolveBinding(env, cwd)?.parent ?? null; }
export function resolveSoul(env = process.env, cwd = process.cwd()) { return soulContext(env, cwd).agentId; }

// One binding-authenticated POST to the daemon, for the routes a bound client
// calls with its own proof and no other credential: the proof is keyed by
// sha256(secret), which the daemon registry already keeps, so the secret never
// goes over the wire (ADR-0008 decision 3 as amended). Any answer resolves as
// `{ status, text }`, refusals included, because a caller may treat a 404 as
// success (an older daemon) and a refusal as silence. Only a transport
// failure or the deadline rejects, with `daemon-unreachable`.
export function bindingPost(context, pathname, payload, { timeoutMs = 3000 } = {}) {
  if (!context?.binding) return Promise.reject(new CommsError('unbound', 'this session carries no daemon binding'));
  let target;
  try { target = new URL(pathname, context.binding.daemon); }
  catch { return Promise.reject(new CommsError('daemon-unreachable', 'the binding names no usable daemon URL')); }
  return new Promise((resolve, reject) => {
    // A one-time proof, never the secret: a process squatting the daemon's port
    // while it is down learns nothing reusable.
    const proof = signBindingProof({ secret: context.binding.secret, method: 'POST', path: target.pathname, authority: target.host });
    // A deadline, not an idle timeout: a daemon that stops mid-body answers
    // nothing at all, and this request must not wait on it.
    const req = http.request(target, { method: 'POST', headers: { [PROOF_HEADER]: proof, 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', () => reject(new CommsError('daemon-unreachable', 'the agent-bot daemon did not answer')));
    req.end(JSON.stringify(payload ?? {}));
  });
}

export function vouch(context) {
  if (!context.binding) return Promise.resolve(null);
  const key = `${context.binding.daemon}\0${context.binding.secret}`;
  if (vouchCache?.key === key && vouchCache.exp * 1000 - Date.now() > 30_000) {
    if (context.parent == null && vouchCache.parent) context.parent = vouchCache.parent;
    return Promise.resolve(vouchCache.token);
  }
  if (vouchCache?.key === key && vouchCache.pending) return vouchCache.pending;
  const pending = (async () => {
    let response;
    try {
      response = await bindingPost(context, '/v0/vouch', { aud: 'agent-comms' });
    } catch {
      vouchCache = null;
      throw new CommsError('daemon-unreachable', 'cannot reach the agent-bot daemon; make sure it is running (`agent-bot daemon start`)');
    }
    try {
      if (response.status < 200 || response.status >= 300) throw new Error('non-2xx response');
      const result = JSON.parse(response.text);
      if (typeof result.token !== 'string' || result.agentId !== context.agentId || !Number.isFinite(Number(result.exp))) throw new Error('invalid vouch response');
      vouchCache = { key, token: result.token, exp: Number(result.exp), parent: result.parent ?? null };
      if (context.parent == null && result.parent) context.parent = result.parent;
      return result.token;
    } catch {
      vouchCache = null;
      throw new CommsError('daemon-unreachable', 'cannot obtain a soul token; make sure the agent-bot daemon is running (`agent-bot daemon start`)');
    }
  })();
  vouchCache = { key, pending, exp: 0 };
  return pending;
}

// The admin channel is the owner's own; where the channel needs a pin to trust
// it, the owner reads the broker's identity file directly.
export const admin = (paths, request, options) => open(paths.admin, request, { timeoutMs: options?.timeoutMs, trust: brokerPin(paths) });

export async function pair(paths, clientPaths, brokerAccount, account = os.userInfo().username, mode = 'group') {
  if (mode === 'group' && !brokerAccount) fail('usage', 'name the broker account: agent-comms account pair --broker ACCOUNT');
  const brokerUid = mode === 'single-account' ? currentUid() : uidOf(brokerAccount);
  checkBrokerCustody(paths, brokerUid, mode);
  if (mode === 'group') assertOwnedDir(paths.proofs, brokerUid, { mode: 0o1777 });
  else assertOwnedDir(paths.proofs, brokerUid, { mode: 0o700 });
  // Pinned from the broker's own state, never from the wire (no trust on
  // first use), and recorded with the credential for every later call.
  const pin = brokerPin(paths);
  const secret = randomBytes(32).toString('hex');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const proof = `${randomBytes(16).toString('hex')}.proof`;
  const proofFile = path.join(paths.proofs, proof);
  writeFileSync(proofFile, secretHash, { mode: 0o644, flag: 'wx' });
  try {
    const result = await open(paths.socket, { op: 'pair-request', account, secretHash, proof }, { trust: pin });
    saveCredential(clientPaths, { account, secret, brokerUid, ...pin, mode, pairedAt: new Date().toISOString() });
    return result;
  } finally {
    rmSync(proofFile, { force: true });
  }
}
