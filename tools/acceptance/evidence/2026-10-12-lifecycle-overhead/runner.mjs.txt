// Opt-in macOS acceptance of two unmodified production source archives.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);
const EXECUTABLE = realpathSync(process.execPath);
const PINS = Object.freeze({ old: 'a618508ab4c4d7185b198c89b1befce513a66b8e', new: '5276f77d6bbcc68e42ef6ba5654495d2df56bc35' });
const MODES = ['healthy', 'failed', 'unread'];
let activeOutput, fixtureCleanup, activeStage = 'arguments';
const SAFE_CHECKS = new Set(['fixture-start-failed', 'fixture-start-deadline', 'fixture-command-deadline',
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
  const alice = `agent_${randomUUID()}`, bob = `agent_${randomUUID()}`;
  const request = (body, auth = credential) => client.call(paths, auth, body);
  for (const agentId of [alice, bob]) await request({ op: 'join', agentId });
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
  const outcomes = { read: 0, send: 0, deliveredRead: 0, ack: 0, refusal: 0, localFailure: 1 };
  async function workload() {
    await startPersistent();
    await refusalWatch();
    for (const seconds of [60, 10]) {
      const latency = [], lateness = [];
      let attempts = 0, message;
      const start = performance.now();
      if (seconds === 10) {
        const next = () => {
          try {
            for (let i = 0; i < 10; i += 1) { localFailure(); attempts += 1; outcomes.localFailure += 1; }
            if (attempts < 10_000) burstTimer = setTimeout(next, Math.max(0, start + attempts - performance.now()));
          } catch { burstFailure = true; }
        };
        next();
      }
      for (let i = 0; i < seconds * 100; i += 1) {
        const target = start + i * 10;
        await sleep(Math.max(0, target - performance.now()));
        if (stopping) throw new Error('fixture-disconnected');
        // These actual operations are outside request service latency but their
        // scheduling impact remains visible in lateness and total throughput.
        if (i % 100 === 20) await churnWatch();
        if (i % 1000 === 500) await reconnectPersistent();
        const began = performance.now();
        // Six sends/minute respects unmodified account/pair rate limits.
        if (i % 1000 === 6) {
          const sent = await request({ op: 'send', agentId: alice, to: bob, body: MARKER, key: `${seconds}-${i}` });
          message = sent.messageId; outcomes.send += 1;
        } else if (i % 1000 === 7) {
          const read = await request({ op: 'read', agentId: bob });
          assert.equal(read.messages.length, 1); assert.equal(read.messages[0].id, message); assert.equal(read.messages[0].body, MARKER);
          outcomes.deliveredRead += 1;
        } else if (i % 1000 === 8) {
          await request({ op: 'ack', agentId: bob, ids: [message] }); message = null; outcomes.ack += 1;
        } else if (i % 100 === 99) {
          await assert.rejects(request({ op: 'read', agentId: bob }, { ...credential, secret: MARKER }), { code: 'unauthenticated' });
          outcomes.refusal += 1;
        } else {
          assert.equal((await request({ op: 'read', agentId: bob })).messages.length, 0); outcomes.read += 1;
        }
        latency.push(performance.now() - began); lateness.push(Math.max(0, began - target));
        assert.equal(burstFailure, false);
      }
      await sleep(Math.max(0, start + seconds * 1000 - performance.now()));
      const elapsedMs = performance.now() - start;
      assert.equal(attempts, seconds === 10 ? 10_000 : 0);
      clearTimeout(burstTimer);
      const windows = [];
      for (let i = 0; i < latency.length; i += 100) {
        const a = latency.slice(i, i + 100), b = lateness.slice(i, i + 100);
        windows.push({ requestSecond: i / 100 + 1, p95Ms: quantile(a, 0.95), p99Ms: quantile(a, 0.99), driverLatenessMaxMs: Math.max(...b) });
      }
      phases.push({ seconds, completed: latency.length, elapsedMs, throughput: latency.length * 1000 / elapsedMs,
        p95Ms: quantile(latency, 0.95), p99Ms: quantile(latency, 0.99), actualLocalFailureAttempts: attempts, windows });
    }
    await closeWatches();
    assert.deepEqual(watchOutcomes, { churnReady: 70, persistentReady: 1, reconnectReady: 7, refusal: 1 });
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
    PATH: process.env.PATH, AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'), AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker'),
    AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'client'), AGENT_COMMS_SERVICE_LABEL: `test.lifecycle.${randomUUID()}`,
  }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let terminal = false, originalFailure, sampler, helperPid, failedHelper, sampling, samplingError, lifecycleObserved = false, fixtureFailure;
  const exited = new Promise((resolve) => {
    child.once('error', () => { if (!child.pid) { terminal = true; resolve([null, null]); } });
    child.once('exit', (code, signal) => { terminal = true; resolve([code, signal]); });
  });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve([code, signal])));
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve) => child.on('message', (message) => {
    if (message.id === 0) resolve(message);
    else if (message.id === -2) fixtureFailure = message.failure;
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
  const observedEvents = { 'broker.started': 0, 'broker.stopped': 0, 'transport.ready': 0, 'transport.reconnected': 0 };
  const buildVersion = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')).version;
  const tuples = new Map([
    ['broker.started', ['agent-comms-broker', 'broker.lifecycle', 'startup', 'ready', 'succeeded']],
    ['broker.stopped', ['agent-comms-broker', 'broker.lifecycle', 'shutdown', 'stopped', 'succeeded']],
    ['transport.ready', ['agent-comms-client', 'transport.watch', 'ready', 'ready', 'succeeded']],
    ['transport.reconnected', ['agent-comms-client', 'transport.watch', 'reconnect', 'ready', 'succeeded']],
    ['transport.unreachable', ['agent-comms-client', 'transport.connect', 'connect', 'broker-unreachable', 'failed']],
    ['transport.retry', ['agent-comms-client', 'transport.watch', 'backoff', 'retry-scheduled', 'succeeded']],
  ]);
  if (mode !== 'unread') child.stderr.on('data', (chunk) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > 1024 * 1024 || chunk.includes(MARKER) || chunk.includes(root) || chunk.includes(source)) { outputFailure = true; return; }
    line += chunk.toString('utf8');
    if (line.length > 4096 && !line.includes('\n')) { outputFailure = true; line = ''; return; }
    while (line.includes('\n')) {
      const at = line.indexOf('\n'), record = line.slice(0, at); line = line.slice(at + 1);
      try {
        assert.ok(Buffer.byteLength(record) + 1 <= 512);
        const event = JSON.parse(record);
        assert.ok(!record.includes(MARKER) && !record.includes(root) && !record.includes(source));
        assert.equal(event.v, 1);
        assert.deepEqual(Object.keys(event).sort(), ['v', 'component', 'buildVersion', 'buildSource', 'event', 'eventId', 'sessionId',
          'operation', 'stage', 'code', 'outcome', 'observedAtUnixMs',
          ...(event.durationMs === undefined ? [] : ['durationMs']),
          ...(['transport.retry', 'diagnostics.dropped'].includes(event.event) ? ['details'] : [])].sort());
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        assert.match(event.eventId, uuid); assert.match(event.sessionId, uuid);
        assert.equal(event.buildVersion, buildVersion);
        assert.equal(event.buildSource, 'running');
        assert.ok(Number.isSafeInteger(event.observedAtUnixMs) && event.observedAtUnixMs >= 0);
        if (event.durationMs !== undefined) assert.ok(Number.isSafeInteger(event.durationMs) && event.durationMs >= 0);
        if (event.event === 'transport.retry') {
          assert.deepEqual(Object.keys(event.details).sort(), ['attempt', 'delayMs']);
          assert.ok(Number.isSafeInteger(event.details.attempt) && event.details.attempt >= 1);
          assert.ok(Number.isInteger(event.details.delayMs) && event.details.delayMs >= 0 && event.details.delayMs <= 10000);
        }
        if (event.event === 'diagnostics.dropped') {
          assert.ok(['agent-comms-broker', 'agent-comms-client'].includes(event.component));
          assert.deepEqual(Object.keys(event.details), ['droppedCount']);
          assert.ok(Number.isSafeInteger(event.details.droppedCount) && event.details.droppedCount >= 0);
          assert.deepEqual([event.operation, event.stage, event.code, event.outcome], ['diagnostics', 'queue', 'diagnostics-dropped', 'dropped']);
        } else {
          assert.ok(tuples.has(event.event));
          assert.deepEqual([event.component, event.operation, event.stage, event.code, event.outcome], tuples.get(event.event));
        }
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
    assert.ok(helperPid, 'default-client-helper-missing');
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
    const result = preflight ? { preflight: true, ...startup.startup, actualLocalFailureWarmup: 1, watchOutcomes: (await command('watch-preflight', 10_000)).watchOutcomes } : (await command('run', 80_000)).result;
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
    const shutdownMs = performance.now() - stopping;
    const stdio = await finishStdio();
    assert.equal(outputFailure, false, 'default-diagnostic-output-invalid');
    if (mode !== 'unread') assert.ok(diagnosticLines > 0);
    if (revision === 'new' && mode === 'healthy') {
      assert.ok(observedEvents['broker.started'] >= 1);
      assert.ok(observedEvents['transport.ready'] >= (preflight ? 2 : 61));
      assert.ok(observedEvents['transport.reconnected'] >= (preflight ? 1 : 6));
    }
    if (revision === 'old') assert.ok(Object.values(observedEvents).every((count) => count === 0));
    const peak = (key) => Math.max(...samples.map((row) => row[key]));
    return { revision, mode, deployment: 'one embedded Broker/client process; default callbacks', ...result,
      shutdownMs, ...stdio, shutdownDiagnosticObserved: observedEvents['broker.stopped'] > 0, ownedTerminalConfirmed: true, helperWasPresent: Boolean(helperPid), helperExitConfirmed: helperPid ? true : null, diagnosticBytes, diagnosticLines, observedEvents, destination: mode === 'unread' ? 'configured unread; queue not inspected' : mode,
      failedHelperApplicable: mode === 'failed', peakMainRssKiB: peak('mainRssKiB'), peakHelperRssKiB: peak('helperRssKiB'),
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
      node: process.version, runnerSha256: hash(readFileSync(SELF)),
      archives: Object.fromEntries(Object.entries(archives).map(([key, { source, ...entry }]) => [key, entry])), runs };
    writeFileSync(path.join(output, 'preflight.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const pairs = [], runs = [];
  for (const mode of modes) {
    process.stderr.write(`Measuring ${mode}: old/new/new/old, 70 seconds each.\n`);
    const group = [];
    for (const revision of ['old', 'new', 'new', 'old']) {
      writeFileSync(path.join(output, 'progress.json'), `${JSON.stringify({ stage: 'run', mode, revision, completedRuns: runs.length, archives: Object.fromEntries(Object.entries(archives).map(([key, { source, ...entry }]) => [key, entry])) }, null, 2)}\n`);
      const result = await run(archives[revision].source, revision, mode);
      group.push(result); runs.push(result);
      writeFileSync(path.join(output, 'runs.json'), `${JSON.stringify(runs, null, 2)}\n`);
    }
    for (const [old, current, order] of [[group[0], group[1], 'old-new'], [group[3], group[2], 'new-old']]) {
      assert.deepEqual(old.outcomes, current.outcomes);
      assert.deepEqual(old.watchOutcomes, current.watchOutcomes);
      const deltas = current.phases.map((phase, i) => ({ p95Ms: phase.p95Ms - old.phases[i].p95Ms, p99Ms: phase.p99Ms - old.phases[i].p99Ms,
        throughputRatio: phase.throughput / old.phases[i].throughput }));
      const additionalRssKiB = current.peakTotalRssKiB - old.peakTotalRssKiB;
      pairs.push({ mode, order, deltas, additionalRssKiB, passes: deltas.every((d) => d.p95Ms <= 2 && d.p99Ms <= 5 && d.throughputRatio >= 0.98)
        && additionalRssKiB <= 64 * 1024 && old.shutdownMs <= 2000 && current.shutdownMs <= 2000 });
    }
  }
  const result = { v: 1, platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version,
    nodeExecutableSha256: hash(readFileSync(EXECUTABLE)), runnerSha256: hash(readFileSync(SELF)), logicalCpus: os.availableParallelism(),
    scope: 'incremental lifecycle instrumentation in one embedded production Broker/client macOS workload; 1/s authenticated watch churn and one owned watch reconnect/10s; 1000/s burst is client failures, not lifecycle completions; startup/import/recovery separate; no Windows/host/compaction/arbitrary-error claim',
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
    failure.runnerSha256 = hash(readFileSync(SELF));
    try { writeFileSync(path.join(activeOutput, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`); } catch { /* Preserve the original result. */ }
  }
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}
