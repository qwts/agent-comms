// Opt-in macOS acceptance of two unmodified production source archives.
import assert from 'node:assert/strict';
import { runPairedGroup } from './diagnostic-mailbox-pairs.mjs';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);
const EXECUTABLE = realpathSync(process.execPath);
const PINS = Object.freeze({ old: 'f0eafb4faffa757b46310c25792dd126ea611f76', new: 'f0eafb4faffa757b46310c25792dd126ea611f76' });
const MODES = ['healthy', 'failed', 'unread'];
let activeOutput, fixtureCleanup, activeStage = 'arguments', runSerial = 0, activePartialWorkload = null;
const SAFE_CHECKS = new Set(['budget-failed', 'fixture-start-failed', 'fixture-start-deadline', 'fixture-command-deadline',
  'natural-exit-deadline', 'owned-exit-unconfirmed', 'owned-cleanup-identity-unconfirmed',
  'helper-exit-unconfirmed', 'scratch-cleanup-failed', 'scratch-retained', 'startup-helper-state-unobserved',
  'startup-injected-fault', 'owned-process-accounting-invalid', 'owned-main-unconfirmed',
  'owned-main-command-unconfirmed', 'owned-helper-command-unconfirmed', 'unexpected-owned-child',
  'failed-helper-respawned', 'helper-replaced', 'default-client-helper-missing',
  'failed-helper-still-alive', 'default-diagnostic-output-invalid', 'surviving-helper', 'watch-ready-deadline', 'watch-stop-deadline', 'watch-ended-before-ready', 'owned-stdio-close-unconfirmed']);
const SAFE_SYSTEM_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ESRCH', 'ETIMEDOUT', 'ERR_ASSERTION', 'ERR_IPC_CHANNEL_CLOSED']);
function safeFailure(error, stage = activeStage) {
  return { stage, check: SAFE_CHECKS.has(error?.message) ? error.message : error?.code === 'ERR_ASSERTION' ? 'assertion-failed' : 'operation-failed',
    ...(SAFE_SYSTEM_CODES.has(error?.code) ? { systemCode: error.code } : {}) };
}
const MARKER = 'CANARY-lifecycle-overhead-body-secret-trace';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PAIR_MODULE_SHA256 = hash(readFileSync(new URL('./diagnostic-mailbox-pairs.mjs', import.meta.url)));
const RUNNER_SHA256 = hash(readFileSync(SELF));
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
async function deadline(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(source) {
  activeStage = 'fixture-import';
  const began = performance.now();
  const load = (name) => import(pathToFileURL(path.join(source, name)).href);
  const [{ Broker }, client, pathsModule] = await Promise.all([load('lib/broker.mjs'), load('lib/client.mjs'), load('lib/paths.mjs')]);
  const importMs = performance.now() - began;
  const paths = pathsModule.brokerPaths(), clientPaths = pathsModule.clientPaths();
  let burstTimer, burstFailure = false, running = false, stopping = false;
  let broker = new Broker({ paths, mode: 'single-account' });
  const watches = new Set();
  const watchOutcomes = { churnReady: 0, persistentReady: 0, reconnectReady: 0, refusal: 0 };
  let persistent;
  fixtureCleanup = async () => {
    stopping = true; clearTimeout(burstTimer);
    try { await closeWatches(); } finally { await broker.stop(); }
    if (process.connected) process.disconnect();
  };
  process.once('disconnect', () => {
    if (!stopping) fixtureCleanup().catch(() => { process.exitCode = 1; });
  });
  activeStage = 'fixture-broker-start';
  const start = performance.now();
  await broker.start();
  const brokerStartMs = performance.now() - start;
  if (stopping) { await broker.stop(); return; }
  activeStage = 'fixture-pair-and-delivery';
  const pairing = await client.pair(paths, clientPaths, undefined, os.userInfo().username, 'single-account');
  await client.admin(paths, { op: 'approve', code: pairing.code });
  const credential = client.loadCredential(clientPaths);
  const alice = `agent_${randomUUID()}`, recipients = Array.from({ length: 4 }, () => `agent_${randomUUID()}`), bob = recipients[0];
  const request = (body, auth = credential) => client.call(paths, auth, body);
  for (const agentId of [alice, ...recipients]) await request({ op: 'join', agentId });
  const principalSecret = randomUUID();
  const { sha256 } = await load('lib/broker.mjs');
  const principalPending = await request({ op: 'principal-pair-request', name: 'benchmark', secretHash: sha256(principalSecret) });
  await client.admin(paths, { op: 'principal-approve', code: principalPending.code, grant: recipients });
  const principalCredential = { principal: principalPending.principal, secret: principalSecret,
    brokerUid: credential.brokerUid, mode: credential.mode,
    ...(credential.brokerKey === undefined ? {} : { brokerKey: credential.brokerKey }) };
  const absent = { ...paths, socket: path.join(paths.shared, 'absent.sock'), state: path.join(paths.state, 'absent') };
  function openWatch() {
    const controller = new AbortController();
    const waiters = [];
    const entry = { controller, task: null, waiters };
    watches.add(entry);
    entry.task = client.watch(paths, credential, { op: 'watch', agentId: alice, body: MARKER, traceId: MARKER }, (event) => {
      if (event.event === 'ready') waiters.shift()?.();
    }, { signal: controller.signal });
    // Keep an owned rejection handler even between readiness waits.
    entry.task.catch(() => {});
    entry.nextReady = () => deadline(Promise.race([
      new Promise((resolve) => waiters.push(resolve)),
      entry.task.then(() => { throw new Error('watch-ended-before-ready'); }),
    ]), 5000, 'watch-ready-deadline');
    return entry;
  }
  async function closeWatch(entry) {
    entry.controller.abort();
    try { await deadline(entry.task, 2000, 'watch-stop-deadline'); }
    finally { watches.delete(entry); entry.waiters.length = 0; }
  }
  async function closeWatches() {
    for (const entry of watches) entry.controller.abort();
    const results = await Promise.allSettled([...watches].map(closeWatch));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  async function churnWatch() {
    const entry = openWatch();
    try { await entry.nextReady(); watchOutcomes.churnReady += 1; }
    finally { await closeWatch(entry); }
  }
  async function startPersistent() {
    persistent = openWatch();
    await persistent.nextReady(); watchOutcomes.persistentReady += 1;
  }
  async function reconnectPersistent() {
    const sockets = broker.watchers.get(alice);
    assert.equal(sockets?.size, 1, 'only the owned persistent watch may be disconnected');
    const ready = persistent.nextReady();
    for (const socket of sockets) socket.destroy();
    await ready; watchOutcomes.reconnectReady += 1;
  }
  async function refusalWatch() {
    await assert.rejects(client.watch(paths, { ...credential, secret: MARKER }, { op: 'watch', agentId: alice }, () => {
      assert.fail('refused watch cannot become ready');
    }), { code: 'unauthenticated' });
    watchOutcomes.refusal += 1;
  }
  async function watchPreflight() {
    await churnWatch(); await startPersistent(); await reconnectPersistent(); await refusalWatch(); await closeWatches();
    assert.deepEqual(watchOutcomes, { churnReady: 1, persistentReady: 1, reconnectReady: 1, refusal: 1 });
    return { ...watchOutcomes };
  }

  function localFailure() {
    // Actual production client preflight: no connection, diagnostic injection,
    // source patch, synthetic reporter or private sink/queue access.
    assert.throws(() => client.call(absent, credential, { op: 'read', agentId: bob, body: MARKER, traceId: MARKER }), { code: 'broker-unreachable' });
  }
  async function delivery(key) {
    const sent = await request({ op: 'send', agentId: alice, to: bob, body: MARKER, key });
    const read = await request({ op: 'read', agentId: bob });
    assert.equal(read.messages[0].id, sent.messageId);
    assert.equal(read.messages[0].body, MARKER);
    await request({ op: 'ack', agentId: bob, ids: [sent.messageId] });
    assert.equal((await request({ op: 'read', agentId: bob })).messages.length, 0);
  }
  await delivery('before');
  activeStage = 'fixture-local-failure-warmup';
  const warmup = performance.now();
  localFailure();
  await sleep(100);
  const warmupMs = performance.now() - warmup;
  const phases = [];
  const outcomes = { read: 0, send: 0, deliveredRead: 0, ack: 0, census: 0, refusal: 0, localFailure: 1 };
  let checkpoint = async () => {};
  function installCheckpoint(operations, latency, lateness, start) {
    let checkpointAt = 0;
    const checkpointCounts = Object.fromEntries(Object.keys(operations).map(name => [name, 0]));
    checkpoint = async () => {
      if (latency.length === checkpointAt || !process.connected) return;
      const delta = Object.fromEntries(Object.entries(operations).map(([name, values]) => [name, values.slice(checkpointCounts[name])]));
      const receipt = { completed: latency.length, elapsedMs: performance.now() - start,
        outcomes: { ...outcomes }, watchOutcomes: { ...watchOutcomes },
        latencySamplesMs: delta, driverLatenessSamplesMs: lateness.slice(checkpointAt) };
      assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 512 * 1024);
      await new Promise((resolve, reject) => process.send({ id: -3, checkpoint: receipt }, error => error ? reject(error) : resolve()));
      checkpointAt = latency.length;
      for (const name of Object.keys(operations)) checkpointCounts[name] = operations[name].length;
    };
  }
  async function workloadPreflight() {
    const operations = { send: [], deliveredRead: [], ack: [], census: [], emptyRead: [], refusal: [] };
    const latency = [], lateness = [], start = performance.now();
    installCheckpoint(operations, latency, lateness, start);
    let message;
    const steps = [
      ['send', async () => {
        const sent = await request({ op: 'send', agentId: alice, to: bob, body: MARKER, key: 'workload-preflight' });
        assert.equal(sent.duplicate, false); message = sent.messageId; outcomes.send += 1;
      }],
      ['deliveredRead', async () => {
        const read = await request({ op: 'read', agentId: bob });
        assert.equal(read.messages.length, 1); assert.equal(read.messages[0].id, message); assert.equal(read.messages[0].body, MARKER);
        outcomes.deliveredRead += 1;
      }],
      ['census', async () => {
        const snapshot = await client.callPrincipal(paths, principalCredential, { op: 'census' });
        assert.equal(snapshot.souls.length, recipients.length);
        assert.ok(snapshot.souls.every(row => recipients.includes(row.agentId)));
        const row = snapshot.souls.find(row => row.agentId === bob);
        assert.equal(row.unacked, 1); assert.ok(Number.isSafeInteger(row.oldestUnackedAgeMs) && row.oldestUnackedAgeMs >= 0);
        outcomes.census += 1;
      }],
      ['ack', async () => {
        assert.equal((await request({ op: 'ack', agentId: bob, ids: [message] })).acknowledged, 1); outcomes.ack += 1;
      }],
      ['emptyRead', async () => {
        assert.equal((await request({ op: 'read', agentId: bob })).messages.length, 0); outcomes.read += 1;
      }],
      ['refusal', async () => {
        await assert.rejects(request({ op: 'read', agentId: bob }, { ...credential, secret: MARKER }), { code: 'unauthenticated' });
        outcomes.refusal += 1;
      }],
    ];
    for (const [name, operation] of steps) {
      const began = performance.now(); await operation(); const elapsed = performance.now() - began;
      operations[name].push(elapsed); latency.push(elapsed); lateness.push(0);
    }
    await checkpoint();
    assert.deepEqual(outcomes, { read: 1, send: 1, deliveredRead: 1, ack: 1, census: 1, refusal: 1, localFailure: 1 });
    return { timedWorkloadRun: false, completed: latency.length, outcomes: { ...outcomes },
      checkpointExpected: true, perOperationCounts: Object.fromEntries(Object.entries(operations).map(([name, values]) => [name, values.length])) };
  }
  async function workload() {
    await startPersistent();
    await refusalWatch();
    for (const seconds of [720]) {
      const latency = [], lateness = [];
      const operations = { send: [], deliveredRead: [], ack: [], census: [], emptyRead: [], refusal: [] };
      const start = performance.now();
      installCheckpoint(operations, latency, lateness, start);
      let message, recipient, lastSend = -Infinity;
      for (let i = 0; i < seconds * 100; i += 1) {
        const target = start + i * 10;
        await sleep(Math.max(0, target - performance.now()));
        if (stopping) throw new Error('fixture-disconnected');
        if (i % 100 === 20) await churnWatch();
        if (i % 1000 === 500) await reconnectPersistent();
        // Admission pacing also uses actual monotonic time: catch-up reads
        // cannot compress sends above unchanged sliding-window rate limits.
        if (i % 60 === 0) await sleep(Math.max(0, lastSend + 600 - performance.now()));
        const began = performance.now();
        let operation;
        if (i % 60 === 0) {
          recipient = recipients[Math.floor(i / 60) % recipients.length];
          const sent = await request({ op: 'send', agentId: alice, to: recipient, body: MARKER, key: `timed-${i}` });
          assert.equal(sent.duplicate, false);
          message = sent.messageId; outcomes.send += 1; operation = 'send'; lastSend = began;
        } else if (i % 60 === 1) {
          const read = await request({ op: 'read', agentId: recipient });
          assert.equal(read.messages.length, 1); assert.equal(read.messages[0].id, message); assert.equal(read.messages[0].body, MARKER);
          outcomes.deliveredRead += 1; operation = 'deliveredRead';
        } else if (i % 60 === 2) {
          const snapshot = await client.callPrincipal(paths, principalCredential, { op: 'census' });
          assert.equal(snapshot.souls.length, recipients.length);
          const row = snapshot.souls.find(row => row.agentId === recipient);
          assert.equal(row.unacked, 1); assert.ok(Number.isSafeInteger(row.oldestUnackedAgeMs) && row.oldestUnackedAgeMs >= 0);
          outcomes.census += 1; operation = 'census';
        } else if (i % 60 === 3) {
          const ack = await request({ op: 'ack', agentId: recipient, ids: [message] });
          assert.equal(ack.acknowledged, 1); message = null; outcomes.ack += 1; operation = 'ack';
        } else if (i % 100 === 99) {
          await assert.rejects(request({ op: 'read', agentId: alice }, { ...credential, secret: MARKER }), { code: 'unauthenticated' });
          outcomes.refusal += 1; operation = 'refusal';
        } else {
          assert.equal((await request({ op: 'read', agentId: alice })).messages.length, 0);
          outcomes.read += 1; operation = 'emptyRead';
        }
        const elapsed = performance.now() - began;
        latency.push(elapsed); operations[operation].push(elapsed); lateness.push(Math.max(0, began - target));
        if (latency.length % 6000 === 0) await checkpoint();
      }
      await sleep(Math.max(0, start + seconds * 1000 - performance.now()));
      const elapsedMs = performance.now() - start;
      assert.deepEqual(outcomes, { read: 66480, send: 1200, deliveredRead: 1200, ack: 1200, census: 1200, refusal: 720, localFailure: 1 });
      const summarize = values => ({ count: values.length, p95Ms: quantile(values, 0.95), p99Ms: quantile(values, 0.99) });
      phases.push({ seconds, completed: latency.length, elapsedMs, throughput: latency.length * 1000 / elapsedMs,
        ...summarize(latency), driverLatenessMaxMs: Math.max(...lateness),
        operations: Object.fromEntries(Object.entries(operations).map(([name, values]) => [name, summarize(values)])),
        latencySamplesMs: operations, driverLatenessSamplesMs: lateness, actualLocalFailureAttempts: 0 });
    }
    await closeWatches();
    assert.deepEqual(watchOutcomes, { churnReady: 720, persistentReady: 1, reconnectReady: 72, refusal: 1 });
    await delivery('after');
    const recoveryStart = performance.now();
    await broker.stop();
    broker = await new Broker({ paths, mode: 'single-account' }).start();
    assert.equal((await request({ op: 'read', agentId: bob })).messages.length, 0);
    return { importMs, brokerStartMs, warmupMs, recoveryMs: performance.now() - recoveryStart, phases, outcomes, watchOutcomes, deliveryChecks: 2, ordinaryRecoveryChecks: 1 };
  }
  process.on('message', async ({ id, command }) => {
    try {
      if (command === 'startup-fault') {
        assert.equal(process.argv[4], '--startup-fault');
        activeStage = 'fixture-startup-fault';
        process.send({ id, faultInjected: true });
        throw new Error('startup-injected-fault');
      } else if (command === 'workload-preflight') {
        process.send({ id, workloadPreflight: await workloadPreflight() });
      } else if (command === 'watch-preflight') {
        process.send({ id, watchOutcomes: await watchPreflight() });
      } else if (command === 'run') {
        activeStage = 'fixture-workload';
        assert.equal(running, false); running = true;
        process.send({ id, result: await workload() });
      } else if (command === 'stop') {
        activeStage = 'fixture-normal-stop';
        stopping = true; clearTimeout(burstTimer);
        try { await closeWatches(); } finally { await broker.stop(); }
        process.send({ id, stopped: true }, () => process.disconnect());
      } else throw new Error('unsupported-fixture-command');
    } catch (error) {
      await checkpoint().catch(() => {}); // Best-effort tail; prior parent-owned checkpoints survive even abrupt loss.
      if (process.connected) process.send({ id: -2, failure: safeFailure(error) });
      stopping = true; clearTimeout(burstTimer); process.exitCode = 1; await closeWatches().catch(() => {}); await broker.stop().catch(() => {}); if (process.connected) process.disconnect();
    }
  });
  process.send({ id: 0, startup: { importMs, brokerStartMs, warmupMs } });
}

function parseRow(line) {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
  assert.ok(match, 'owned-process-accounting-invalid');
  assert.equal(realpathSync(match[5]), EXECUTABLE);
  const time = match[4].split(':').map(Number);
  assert.ok(time.length >= 2 && time.length <= 3 && time.every(Number.isFinite));
  return { pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]),
    cpuSeconds: time.reduce((sum, value) => sum * 60 + value, 0), command: match[6] };
}
async function accounting(pid, source) {
  let descendants = '';
  try { descendants = (await exec('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 1000, maxBuffer: 128 })).stdout; }
  catch (error) { if (error.code !== 1) throw error; }
  const children = descendants.trim() ? descendants.trim().split(/\s+/).map(Number) : [];
  assert.ok(children.length <= 1 && children.every(Number.isSafeInteger), 'unexpected-owned-child');
  // Darwin comm has a 16-column default even under -ww; an explicit header
  // width prevents executable truncation. Discard only that known header.
  const { stdout } = await exec('ps', ['-ww', '-o', `pid=,ppid=,rss=,time=,comm=${'.'.repeat(1024)},args=`, '-p', [pid, ...children].join(',')], { encoding: 'utf8', timeout: 1000, maxBuffer: 8192 });
  const rows = stdout.trim().split('\n').slice(1).map(parseRow);
  const main = rows.find((row) => row.pid === pid);
  assert.equal(main?.ppid, process.pid, 'owned-main-unconfirmed');
  assert.ok(main.command.includes(SELF) && main.command.includes('--fixture'), 'owned-main-command-unconfirmed');
  const helper = rows.find((row) => row.pid !== pid);
  if (helper) {
    assert.equal(helper.ppid, pid); assert.ok(children.includes(helper.pid));
    assert.ok(helper.command.includes(JSON.stringify(pathToFileURL(path.join(source, 'lib/diagnostic-writer.mjs')).href)), 'owned-helper-command-unconfirmed');
  }
  return { main, helper };
}
async function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}

async function run(source, revision, mode, preflight = false, startupFault = false) {
  activeStage = 'parent-spawn';
  source = realpathSync(source);
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-diag-lifecycle-'));
  const child = spawn(process.execPath, [SELF, '--fixture', source, ...(startupFault ? ['--startup-fault'] : [])], { env: {
    PATH: process.env.PATH, ...(revision === 'old' ? { AGENT_COMMS_DIAGNOSTICS: 'off' } : {}), AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'), AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker'),
    AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'client'), AGENT_COMMS_SERVICE_LABEL: `test.lifecycle.${randomUUID()}`,
  }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let terminal = false, originalFailure, sampler, helperPid, failedHelper, sampling, samplingError, lifecycleObserved = false, fixtureFailure;
  const exited = new Promise((resolve) => {
    child.once('error', () => { if (!child.pid) { terminal = true; resolve([null, null]); } });
    child.once('exit', (code, signal) => { terminal = true; resolve([code, signal]); });
  });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve([code, signal])));
  const checkpointFile = activeOutput ? path.join(activeOutput, `partial-${String(++runSerial).padStart(2, '0')}-${revision}-${mode}.ndjson`) : null;
  let checkpointCompleted = 0, checkpointReceipts = 0;
  activePartialWorkload = { file: checkpointFile ? path.basename(checkpointFile) : null, persisted: false, completed: 0, receipts: 0 };
  function retainCheckpoint(receipt) {
    const names = ['send', 'deliveredRead', 'ack', 'census', 'emptyRead', 'refusal'];
    assert.deepEqual(Object.keys(receipt).sort(), ['completed', 'elapsedMs', 'outcomes', 'watchOutcomes', 'latencySamplesMs', 'driverLatenessSamplesMs'].sort());
    assert.ok(Number.isSafeInteger(receipt.completed) && receipt.completed > checkpointCompleted && receipt.completed <= 72000);
    assert.ok(Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs >= 0);
    assert.deepEqual(Object.keys(receipt.latencySamplesMs).sort(), names.sort());
    const delta = receipt.completed - checkpointCompleted;
    assert.ok(delta <= 6000 && ++checkpointReceipts <= 12);
    const values = [...Object.values(receipt.latencySamplesMs), receipt.driverLatenessSamplesMs];
    assert.ok(values.every(array => Array.isArray(array) && array.length <= 6000 && array.every(value => Number.isFinite(value) && value >= 0)));
    assert.equal(Object.values(receipt.latencySamplesMs).reduce((sum, array) => sum + array.length, 0), delta);
    assert.equal(receipt.driverLatenessSamplesMs.length, delta);
    assert.deepEqual(Object.keys(receipt.outcomes).sort(), ['read', 'send', 'deliveredRead', 'ack', 'census', 'refusal', 'localFailure'].sort());
    assert.deepEqual(Object.keys(receipt.watchOutcomes).sort(), ['churnReady', 'persistentReady', 'reconnectReady', 'refusal'].sort());
    assert.ok([...Object.values(receipt.outcomes), ...Object.values(receipt.watchOutcomes)].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 72000));
    const serialized = JSON.stringify(receipt);
    assert.ok(Buffer.byteLength(serialized) <= 512 * 1024);
    if (checkpointFile) appendFileSync(checkpointFile, serialized + '\n', { flag: checkpointReceipts === 1 ? 'wx' : 'a', mode: 0o600 });
    checkpointCompleted = receipt.completed;
    activePartialWorkload = { file: checkpointFile ? path.basename(checkpointFile) : null, persisted: Boolean(checkpointFile),
      completed: checkpointCompleted, receipts: checkpointReceipts };
  }
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve) => child.on('message', (message) => {
    if (message.id === 0) resolve(message);
    else if (message.id === -2) fixtureFailure = message.failure;
    else if (message.id === -3) {
      try { retainCheckpoint(message.checkpoint); } catch (error) { samplingError = error; }
    }
    else pending.get(message.id)?.(message);
  }));
  async function command(command, timeout = 2000) {
    const id = nextId++;
    const response = new Promise((resolve) => pending.set(id, resolve));
    try {
      child.send({ id, command });
      return await deadline(Promise.race([response, exited.then(() => { throw new Error('fixture-start-failed'); })]), timeout, 'fixture-command-deadline');
    }
    finally { pending.delete(id); }
  }
  const samples = [];
  function sample() {
    if (sampling) return sampling;
    sampling = (async () => {
      try {
        const row = await accounting(child.pid, source);
        lifecycleObserved = true;
        if (revision === 'old') assert.equal(row.helper, undefined, 'opted-out helper unexpectedly present');
        if (row.helper) {
          assert.equal(failedHelper, undefined, 'failed-helper-respawned');
          if (helperPid) assert.equal(row.helper.pid, helperPid, 'helper-replaced');
          helperPid = row.helper.pid;
        }
        samples.push({ mainRssKiB: row.main.rssKiB, helperRssKiB: row.helper?.rssKiB ?? 0,
          mainCpuSeconds: row.main.cpuSeconds, helperCpuSeconds: row.helper?.cpuSeconds ?? 0 });
      } catch (error) { samplingError = error; }
    })().finally(() => { sampling = null; });
    return sampling;
  }
  let diagnosticBytes = 0, diagnosticLines = 0, outputFailure = false, line = '';
  const observedEvents = Object.fromEntries(['broker.started', 'broker.stopped', 'transport.ready', 'transport.reconnected',
    'pairing.account-pending', 'pairing.account-approved', 'pairing.principal-pending', 'pairing.principal-approved',
    'membership.joined', 'mailbox.admitted', 'mailbox.read', 'mailbox.acked'].map(event => [event, 0]));
  const buildVersion = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')).version;
  const { projectDiagnosticRecord } = await import(pathToFileURL(path.join(source, 'lib/diagnostic-profile.mjs')).href);
  if (mode !== 'unread') child.stderr.on('data', (chunk) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > 64 * 1024 * 1024 || chunk.includes(MARKER) || chunk.includes(root) || chunk.includes(source)) { outputFailure = true; return; }
    line += chunk.toString('utf8');
    if (line.length > 4096 && !line.includes('\n')) { outputFailure = true; line = ''; return; }
    while (line.includes('\n')) {
      const at = line.indexOf('\n'), record = line.slice(0, at); line = line.slice(at + 1);
      try {
        assert.ok(Buffer.byteLength(record) + 1 <= 512);
        const event = JSON.parse(record);
        assert.ok(!record.includes(MARKER) && !record.includes(root) && !record.includes(source));
        assert.deepEqual(projectDiagnosticRecord(event), event);
        assert.equal(event.buildVersion, buildVersion);
        assert.equal(event.buildSource, 'running');
        if (Object.hasOwn(observedEvents, event.event)) observedEvents[event.event] += 1;
        assert.ok(!Object.hasOwn(event, 'context') && !Object.hasOwn(event, 'links'));
        diagnosticLines += 1;
      } catch { outputFailure = true; }
    }
  });
  async function finishStdio() {
    // Called only after actual fixture exit and verified helper disappearance.
    // Unread mode cannot drain diagnostics; dispose this owned pipe explicitly.
    if (mode === 'unread') child.stderr.destroy();
    const [code, signal] = await deadline(closed, 2000, 'owned-stdio-close-unconfirmed');
    assert.equal(code, startupFault ? 1 : 0); assert.equal(signal, null);
    if (mode !== 'unread') {
      assert.equal(outputFailure, false, 'default-diagnostic-output-invalid');
      assert.equal(line, '', 'default-diagnostic-output-invalid');
    }
    return { stdioClosureConfirmed: true, stderrDisposition: mode === 'unread' ? 'owned unread pipe disposed after fixture/helper exit' : 'consumed through child close' };
  }
  try {
    activeStage = 'parent-startup';
    const startup = await deadline(Promise.race([ready, exited.then(() => { throw new Error('fixture-start-failed'); })]), 15_000, 'fixture-start-deadline');
    activeStage = 'parent-startup-accounting';
    await sample();
    if (samplingError) throw samplingError;
    if (revision === 'new') assert.ok(helperPid, 'default-client-helper-missing');
    else assert.equal(helperPid, undefined, 'opted-out helper unexpectedly present');
    if (mode === 'failed' && helperPid) {
      const row = await accounting(child.pid, source);
      assert.equal(row.helper?.pid, helperPid);
      failedHelper = helperPid; process.kill(helperPid, 'SIGKILL');
      for (let i = 0; i < 100 && !(await gone(helperPid)); i += 1) await sleep(10);
      assert.ok(await gone(helperPid), 'failed-helper-still-alive');
    }
    if (startupFault) {
      activeStage = 'parent-startup-fault';
      assert.equal((await command('startup-fault')).faultInjected, true);
      const [code, signal] = await deadline(exited, 2000, 'natural-exit-deadline');
      assert.equal(code, 1); assert.equal(signal, null);
      assert.equal(fixtureFailure?.check, 'startup-injected-fault');
      if (helperPid) {
        for (let i = 0; i < 100 && !(await gone(helperPid)); i += 1) await sleep(10);
        assert.ok(await gone(helperPid), 'surviving-helper');
      }
      const stdio = await finishStdio();
      return { revision, mode, preflight: true, startupFault: true, timedWorkloadRun: false, ...stdio,
        ...startup.startup, fixtureFailure, ownedTerminalConfirmed: true, helperWasPresent: Boolean(helperPid), helperExitConfirmed: helperPid ? true : null };
    }
    activeStage = preflight ? 'parent-normal-preflight' : 'parent-workload';
    sampler = setInterval(sample, 1000);
    const result = preflight ? { preflight: true, ...startup.startup, actualLocalFailureWarmup: 1, watchOutcomes: (await command('watch-preflight', 10_000)).watchOutcomes,
      workloadPreflight: (await command('workload-preflight', 10_000)).workloadPreflight } : (await command('run', 750_000)).result;
    if (preflight) { assert.equal(checkpointCompleted, 6); assert.equal(checkpointReceipts, 1); }
    clearInterval(sampler); await sample();
    if (samplingError) throw samplingError;
    activeStage = 'parent-normal-stop';
    const stopping = performance.now();
    await command('stop');
    const [code, signal] = await deadline(exited, 2000, 'natural-exit-deadline');
    assert.equal(code, 0); assert.equal(signal, null);
    if (helperPid) {
      for (let i = 0; i < 100 && !(await gone(helperPid)); i += 1) await sleep(10);
      assert.ok(await gone(helperPid), 'surviving-helper');
    }
    const stdio = await finishStdio();
    const shutdownMs = performance.now() - stopping;
    assert.equal(outputFailure, false, 'default-diagnostic-output-invalid');
    if (mode !== 'unread' && revision === 'new') assert.ok(diagnosticLines > 0);
    if (revision === 'old') { assert.equal(diagnosticBytes, 0); assert.equal(Boolean(helperPid), false); }
    if (revision === 'new' && mode === 'healthy') {
      assert.ok(observedEvents['broker.started'] >= 1);
      assert.ok(observedEvents['transport.ready'] >= 1);
      for (const event of ['pairing.account-pending', 'pairing.account-approved', 'pairing.principal-pending',
        'pairing.principal-approved', 'membership.joined', 'mailbox.admitted', 'mailbox.read', 'mailbox.acked']) assert.ok(observedEvents[event] >= 1);
      assert.ok(observedEvents['transport.reconnected'] >= 1); // Sampling/drop budgets do not promise lossless event capture.
    }
    if (revision === 'old') assert.ok(Object.values(observedEvents).every((count) => count === 0));
    const peak = (key) => Math.max(...samples.map((row) => row[key]));
    return { revision, mode, checkpointCompleted, checkpointReceipts, partialCheckpointFile: checkpointFile ? path.basename(checkpointFile) : null, deployment: 'one embedded Broker/client process; default callbacks; old=process-start off,new=enabled', ...result,
      shutdownMs, ...stdio, shutdownDiagnosticObserved: observedEvents['broker.stopped'] > 0, ownedTerminalConfirmed: true, helperWasPresent: Boolean(helperPid), helperExitConfirmed: helperPid ? true : null, diagnosticBytes, diagnosticLines, observedEvents, destination: mode === 'unread' ? 'configured unread; queue not inspected' : mode,
      failedHelperApplicable: mode === 'failed' && revision === 'new', peakMainRssKiB: peak('mainRssKiB'), peakHelperRssKiB: peak('helperRssKiB'),
      peakTotalRssKiB: Math.max(...samples.map((row) => row.mainRssKiB + row.helperRssKiB)),
      mainCpuSeconds: peak('mainCpuSeconds'), helperCpuSeconds: peak('helperCpuSeconds'), tail: samples.slice(-5) };
  } catch (error) { originalFailure = fixtureFailure ?? safeFailure(error); error.safeDetails = originalFailure; throw error; }
  finally {
    clearInterval(sampler); if (sampling) await sampling;
    const cleanup = [];
    if (terminal && !lifecycleObserved) cleanup.push(new Error('startup-helper-state-unobserved'));
    if (!terminal) {
      try {
        const row = await accounting(child.pid, source);
        lifecycleObserved = true;
        if (row.helper) { helperPid = row.helper.pid; process.kill(row.helper.pid, 'SIGKILL'); }
      } catch { cleanup.push(new Error('owned-cleanup-identity-unconfirmed')); }
      // The ChildProcess handle is ours even if OS accounting is unavailable.
      // Unknown helper identity still prevents scratch removal and a cleanup claim.
      if (!terminal) child.kill('SIGKILL');
      try { await deadline(exited, 2000, 'owned-exit-unconfirmed'); } catch (error) { cleanup.push(error); }
    }
    if (terminal && helperPid) {
      try { if (!(await gone(helperPid))) cleanup.push(new Error('helper-exit-unconfirmed')); }
      catch { cleanup.push(new Error('helper-exit-unconfirmed')); }
    }
    if (terminal && !cleanup.length) {
      child.stderr.destroy();
      try { await deadline(closed, 2000, 'owned-stdio-close-unconfirmed'); } catch (error) { cleanup.push(error); }
    }
    if (terminal && !cleanup.length) {
      try { rmSync(root, { recursive: true, force: true }); }
      catch { cleanup.push(new Error('scratch-cleanup-failed')); }
    } else cleanup.push(new Error('scratch-retained'));
    if (cleanup.length) {
      const failure = new AggregateError(cleanup, 'acceptance-cleanup-failed');
      failure.originalFailure = originalFailure;
      throw failure;
    }
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'macOS accounting only');
  const preflight = process.argv.length === 5 && process.argv[4] === '--preflight';
  assert.ok(process.argv.length === 4 || process.argv.length === 6 || preflight); assert.equal(process.argv[2], '--output');
  const modes = process.argv.length === 6 ? process.argv[5].split(',') : MODES;
  if (process.argv.length === 6) assert.equal(process.argv[4], '--modes');
  assert.ok(modes.length >= 1 && modes.length <= 3 && new Set(modes).size === modes.length && modes.every((mode) => MODES.includes(mode)));
  activeStage = 'archive-extraction';
  const output = path.resolve(process.argv[3]);
  mkdirSync(output, { recursive: false }); activeOutput = output;
  const archives = {};
  for (const [revision, pin] of Object.entries(PINS)) {
    const { stdout: tree } = await exec('git', ['rev-parse', `${pin}^{tree}`], { encoding: 'utf8' });
    const { stdout: bytes } = await exec('git', ['archive', '--format=tar', pin], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    const archive = path.join(output, `${revision}.tar`), source = path.join(output, revision);
    writeFileSync(archive, bytes); mkdirSync(source);
    await exec('tar', ['-xf', archive, '-C', source]);
    archives[revision] = { source, pin, tree: tree.trim(), archiveSha256: hash(bytes) };
  }
  if (preflight) {
    const runs = [];
    for (const revision of ['old', 'new']) {
      for (const [mode, fault] of [['healthy', false], ['healthy', true], ['failed', false], ['unread', false]]) {
        runs.push(await run(archives[revision].source, revision, mode, true, fault));
        writeFileSync(path.join(output, 'preflight-runs.json'), `${JSON.stringify(runs, null, 2)}\n`);
      }
    }
    const result = { v: 1, stage: 'startup-normal-and-fault-cleanup-preflight', timedWorkloadRun: false,
      node: process.version, runnerSha256: RUNNER_SHA256, pairModuleSha256: PAIR_MODULE_SHA256,
      archives: Object.fromEntries(Object.entries(archives).map(([key, { source, ...entry }]) => [key, entry])), runs };
    writeFileSync(path.join(output, 'preflight.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const pairs = [], runs = [];
  for (const mode of modes) {
    process.stderr.write(`Measuring ${mode}: old/new/new/old, 720 seconds each; old=off, new=enabled.\n`);
    await runPairedGroup(mode, async (revision) => {
      writeFileSync(path.join(output, 'progress.json'), `${JSON.stringify({ stage: 'run', runnerSha256: RUNNER_SHA256, pairModuleSha256: PAIR_MODULE_SHA256, mode, revision, completedRuns: runs.length, archives: Object.fromEntries(Object.entries(archives).map(([key, { source, ...entry }]) => [key, entry])) }, null, 2)}\n`);
      return run(archives[revision].source, revision, mode);
    }, async (result) => {
      runs.push(result);
      writeFileSync(path.join(output, 'runs.json'), `${JSON.stringify(runs, null, 2)}\n`);
    }, async (pair) => {
      pairs.push(pair);
      writeFileSync(path.join(output, 'pairs.json'), `${JSON.stringify(pairs, null, 2)}\n`);
    });
  }
  const result = { v: 1, platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version,
    nodeExecutableSha256: hash(readFileSync(EXECUTABLE)), runnerSha256: RUNNER_SHA256, pairModuleSha256: PAIR_MODULE_SHA256, logicalCpus: os.availableParallelism(),
    scope: 'same current production archive opted-out versus enabled reporting; 1200 fresh sends/read/census/acks over720s, aggregate100requests/s, 1/s watch churn and reconnect/10s; includes existing instrumentation timing in both; no Windows/native/host/OTLP/export-command or isolated append latency claim',
    archives: Object.fromEntries(Object.entries(archives).map(([key, { source, ...entry }]) => [key, entry])), pairs };
  writeFileSync(path.join(output, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (pairs.some((pair) => !pair.passes)) process.exitCode = 1;
}
try {
  if (process.argv[2] === '--fixture') await fixture(process.argv[3]);
  else await main();
} catch (error) {
  if (fixtureCleanup) await fixtureCleanup().catch(() => {});
  const failure = error instanceof AggregateError
    ? { status: 'failed', check: 'cleanup-failed', originalFailure: error.originalFailure ?? null,
      cleanupFailures: error.errors.map((entry) => safeFailure(entry, 'parent-cleanup')) }
    : { status: 'failed', ...(error.safeDetails ?? safeFailure(error)) };
  if (process.argv[2] === '--fixture' && process.connected) process.send({ id: -2, failure: safeFailure(error) });
  if (activeOutput) {
    failure.runnerSha256 = RUNNER_SHA256;
    failure.pairModuleSha256 = PAIR_MODULE_SHA256;
    failure.partialWorkload = activePartialWorkload;
    try { writeFileSync(path.join(activeOutput, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`); } catch { /* Preserve the original result. */ }
  }
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}
