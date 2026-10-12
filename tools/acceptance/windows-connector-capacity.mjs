// Opt-in standard-user Windows capacity pilot. Never imported by production.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { admissionStage, RATES } from './windows-capacity-policy.mjs';

const exec = promisify(execFile), SELF = fileURLToPath(import.meta.url);
const JOB = fileURLToPath(new URL('./windows-capacity-job.ps1', import.meta.url));
const PINS = { old: '25dfa8362401489503f704c7322ad1314b7e6ddb', new: 'e648d71277da72fc50c70ebcbb94c3c8f53c7cf3' };
const CANARY = 'CANARY-windows-capacity-body-secret';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let output, activeStage = 'arguments', fixtureCleanup;
const supervisorPhases = new Set(['compile-supervisor','read-control','verify-fixture','assign-private-job','sample-job','query-members','close-job']);
const checks = new Set(['fixture-terminal', 'fixture-deadline', 'control-deadline', 'control-closed',
  'control-output-bound', 'control-invalid', 'job-supervisor-failed', 'natural-exit-unconfirmed',
  'relay-exit-unconfirmed', 'scratch-retained', 'job-exit-unconfirmed', 'diagnostic-output-invalid',
  'owned-startup-fault', 'owned-forced-cleanup', 'policy-failed', 'memory-headroom-insufficient']);
function failure(error) {
  return { stage: activeStage, check: checks.has(error?.message) ? error.message : error?.code === 'ERR_ASSERTION' ? 'assertion-failed' : 'operation-failed',
    ...(supervisorPhases.has(error?.supervisorPhase) ? { supervisorPhase: error.supervisorPhase } : {}) };
}
function supervisorFailure(record) {
  const error = new Error('job-supervisor-failed');
  if (supervisorPhases.has(record?.failure?.phase)) error.supervisorPhase = record.failure.phase;
  return error;
}
async function deadline(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}
function environment(extra = {}) {
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'userprofile', 'localappdata', 'appdata',
    'temp', 'tmp', 'username', 'userdomain', 'userdnsdomain', 'processor_architecture', 'programdata',
    'programfiles', 'programfiles(x86)', 'commonprogramfiles', 'commonprogramfiles(x86)']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase()))), ...extra };
}
function ownedChild(file, args, options) {
  const child = spawn(file, args, options);
  let terminal = false;
  const exited = new Promise((resolve) => {
    child.once('error', () => { if (!child.pid) { terminal = true; resolve({ code: null, signal: null }); } });
    child.once('exit', (code, signal) => { terminal = true; resolve({ code, signal }); });
  });
  return { child, exited, terminal: () => terminal };
}
function controller(owned, ipc = false) {
  const pending = new Map(); let id = 1, bytes = '', rejected;
  const startup = new Promise((resolve) => {
    const receive = (record) => {
      if (record.id === 0) resolve(record);
      else pending.get(record.id)?.resolve(record);
    };
    if (ipc) owned.child.on('message', receive);
    else owned.child.stdout.on('data', (chunk) => {
      bytes += chunk.toString('utf8');
      if (bytes.length > 65536) { rejected = new Error('control-output-bound'); return; }
      while (bytes.includes('\n')) {
        const end = bytes.indexOf('\n'), line = bytes.slice(0, end); bytes = bytes.slice(end + 1);
        try { receive(JSON.parse(line)); } catch { rejected = new Error('control-invalid'); }
      }
    });
  });
  // A terminal promise is handled at construction, including spawn failures.
  const closed = () => { for (const entry of pending.values()) entry.reject(new Error('control-closed')); };
  owned.exited.then(closed);
  owned.child.stdin?.on('error', closed);
  owned.child.stdout?.on('error', closed);
  return { startup, async request(op, fields = {}, timeout = 5000) {
    if (rejected) throw rejected;
    const requestId = id++;
    const response = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    try {
      const record = { id: requestId, op, ...fields };
      if (ipc) owned.child.send(record, (error) => { if (error) pending.get(requestId)?.reject(new Error('control-closed')); });
      else owned.child.stdin.write(`${JSON.stringify(record)}\n`);
      const result = await deadline(response, timeout, 'control-deadline');
      if (rejected) throw rejected;
      if (result.ok === false) {
        if (result.failure?.check === 'job-supervisor-failed') throw supervisorFailure(result);
        throw new Error(checks.has(result.failure?.check) ? result.failure.check : 'job-supervisor-failed');
      }
      return result;
    } finally { pending.delete(requestId); }
  } };
}

async function fixture(source) {
  // No production imports or descendants until the parent has assigned the job.
  process.send({ id: 0, paused: true });
  const start = await new Promise((resolve) => process.once('message', resolve));
  assert.equal(start.op, 'start');
  activeStage = 'fixture-startup';
  const load = (name) => import(pathToFileURL(path.join(source, name)).href);
  const [{ Broker }, client, pathsModule] = await Promise.all([load('lib/broker.mjs'), load('lib/client.mjs'), load('lib/paths.mjs')]);
  const paths = pathsModule.brokerPaths(), clientPaths = pathsModule.clientPaths();
  const broker = new Broker({ paths, mode: 'single-account' });
  fixtureCleanup = async () => { await broker.stop(); if (process.connected) process.disconnect(); };
  process.once('disconnect', () => fixtureCleanup().catch(() => { process.exitCode = 1; }));
  await broker.start();
  const pairing = await client.pair(paths, clientPaths, undefined, os.userInfo().username, 'single-account');
  await client.admin(paths, { op: 'approve', code: pairing.code });
  const credential = client.loadCredential(clientPaths), alice = `agent_${randomUUID()}`, bob = `agent_${randomUUID()}`;
  const call = (body, options) => client.call(paths, credential, body, options);
  for (const agentId of [alice, bob]) await call({ op: 'join', agentId });
  async function delivery(key) {
    const sent = await call({ op: 'send', agentId: alice, to: bob, body: CANARY, key });
    const read = await call({ op: 'read', agentId: bob });
    assert.equal(read.messages.length, 1); assert.equal(read.messages[0].id, sent.messageId); assert.equal(read.messages[0].body, CANARY);
    await call({ op: 'ack', agentId: bob, ids: [sent.messageId] });
    assert.equal((await call({ op: 'read', agentId: bob })).messages.length, 0);
  }
  await delivery('before');
  process.send({ id: start.id, ok: true, ready: true, startupDeliveryChecks: 1 });
  process.on('message', async ({ id, op, rate }) => {
    try {
      if (op === 'stage') {
        activeStage = 'fixture-offered-stage';
        const result = await admissionStage(rate, (timeoutMs) => call({ op: 'read', agentId: bob }, { timeoutMs }));
        process.send({ id, ok: true, result });
      } else if (op === 'finish') {
        activeStage = 'fixture-post-delivery'; await delivery('after');
        process.send({ id, ok: true, postDeliveryChecks: 1 });
      } else if (op === 'stop') {
        activeStage = 'fixture-stop'; await broker.stop();
        process.send({ id, ok: true, stopped: true }, () => { if (process.connected) process.disconnect(); });
      } else if (op === 'fault') throw new Error('owned-startup-fault');
      else throw new Error('policy-failed');
    } catch (error) {
      process.send({ id, ok: false, failure: failure(error) });
      process.exitCode = 1; await fixtureCleanup();
    }
  });
}

function productionArguments(source) {
  const text = readFileSync(path.join(source, 'lib/platform/windows-pipe-client.mjs'), 'utf8');
  const worker = text.match(/const worker = String\.raw`([\s\S]*?)`;\r?\n\r?\nfunction refusal/);
  assert.ok(worker, 'production-worker-unavailable');
  const encoded = Buffer.from(worker[1], 'utf16le').toString('base64');
  const command = `$ProgressPreference = 'SilentlyContinue'; & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))`;
  return { relayArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', command],
    diagnosticArgs: ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(path.join(source, 'lib/diagnostic-writer.mjs')).href)}).catch(() => process.exit(0));`] };
}
async function run(source, revision, rates, preflight, commitLimitBytes) {
  source = realpathSync(source);
  const root = mkdtempSync(path.join(process.env.LOCALAPPDATA, 'agent-comms-capacity-'));
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = [SELF, '--fixture', source];
  const fixtureOwned = ownedChild(process.execPath, args, { env: environment({
    AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'), AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker'),
    AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'client'), AGENT_COMMS_SERVICE_LABEL: `test.capacity.${randomUUID()}`,
  }), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  const control = controller(fixtureOwned, true);
  const supervisorOwned = ownedChild(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', JOB], {
    env: environment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const supervisor = controller(supervisorOwned);
  let attached = false, disposed = false, sampler, sampling, sampleFailure, outputFailure = false, diagnosticBytes = 0, original;
  let powershellVersion;
  const samples = [], stages = [], cleanupReceipt = { jobEmptyConfirmed: false, scratchRemoved: false };
  async function closeJob() {
    const receipt = await supervisor.request('close', {}, 10_000);
    assert.equal(receipt.jobEmptyConfirmed, true, 'job-exit-unconfirmed');
    for (const key of ['finalJobCpu100ns', 'peakJobCommitBytes']) {
      assert.ok(Number.isSafeInteger(receipt[key]) && receipt[key] >= 0, 'job-exit-unconfirmed');
    }
    Object.assign(cleanupReceipt, receipt);
    disposed = true;
  }
  fixtureOwned.child.stderr.on('data', (chunk) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > 1024 * 1024 || chunk.includes(CANARY) || chunk.includes(root) || chunk.includes(source)) outputFailure = true;
  });
  supervisorOwned.child.stderr.on('data', () => { outputFailure = true; });
  for (const stream of [fixtureOwned.child.stderr, supervisorOwned.child.stderr]) stream.on('error', () => { outputFailure = true; });
  function sample() {
    if (sampling) return sampling;
    sampling = supervisor.request('sample').then((value) => {
      assert.ok(samples.length < 240, 'sample-bound');
      for (const kind of ['main', 'relay', 'diagnostic', 'compiler']) {
        for (const key of ['count', 'workingSetBytes', 'cpu100ns']) assert.ok(Number.isSafeInteger(value.totals?.[kind]?.[key]) && value.totals[kind][key] >= 0);
      }
      samples.push({ ...value.totals, jobPeakCommitBytes: value.jobPeakCommitBytes, jobCpu100ns: value.jobCpu100ns, observer: value.observer });
      writeFileSync(path.join(output, 'partial-run.json'), `${JSON.stringify({ revision, requestedRates: rates, stages, samples }, null, 2)}\n`);
    }).catch((error) => { sampleFailure ??= error; }).finally(() => { sampling = null; });
    return sampling;
  }
  async function noRelays() {
    for (let i = 0; i < 20; i += 1) {
      await sample(); if (sampleFailure) throw sampleFailure;
      if (samples.at(-1).relay.count === 0 && samples.at(-1).compiler.count === 0) return;
      await sleep(100);
    }
    throw new Error('relay-exit-unconfirmed');
  }
  try {
    activeStage = 'paused-fixture-startup';
    assert.equal((await deadline(Promise.race([control.startup, fixtureOwned.exited.then(() => { throw new Error('fixture-terminal'); })]), 5000, 'fixture-deadline')).paused, true);
    const attachStarted = performance.now();
    activeStage = 'supervisor-startup';
    const ready = await deadline(Promise.race([supervisor.startup, supervisorOwned.exited.then(() => { throw new Error('control-closed'); })]), 15_000, 'control-deadline');
    if (ready.ok === false) throw supervisorFailure(ready);
    assert.equal(ready.phase, 'ready');
    activeStage = 'supervisor-attach';
    const attachment = await supervisor.request('attach', { pid: fixtureOwned.child.pid, parentPid: process.pid, nodeExecutable: realpathSync(process.execPath),
      shellExecutable: shell, fixtureArgs: args, ...productionArguments(source), commitLimitBytes,
      compilerExecutables: ['Framework', 'Framework64'].map((name) => path.join(process.env.SystemRoot, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe')),
      compilerTemp: realpathSync(process.env.TEMP) }, Math.max(1, 15_000 - (performance.now() - attachStarted)));
    attached = true; powershellVersion = attachment.powershellVersion;
    activeStage = 'production-startup';
    const startup = await control.request('start', {}, 90_000);
    assert.equal(startup.ready, true); assert.equal(startup.startupDeliveryChecks, 1);
    await noRelays();
    sampler = setInterval(sample, 1000);
    if (preflight === 'fault') {
      activeStage = 'startup-fault-preflight';
      clearInterval(sampler); if (sampling) await sampling;
      await assert.rejects(control.request('fault'), { message: 'owned-startup-fault' });
      const result = await deadline(fixtureOwned.exited, 15_000, 'natural-exit-unconfirmed');
      assert.equal(result.code, 1);
    } else if (preflight === 'forced') {
      activeStage = 'job-disposal-preflight';
      clearInterval(sampler); if (sampling) await sampling;
      await closeJob();
      await deadline(fixtureOwned.exited, 5000, 'natural-exit-unconfirmed');
    } else {
      for (const rate of rates) {
        activeStage = `offered-${rate}`;
        const response = await control.request('stage', { rate }, 25_000);
        stages.push(response.result);
        await noRelays(); if (sampleFailure) throw sampleFailure;
        if (!response.result.qualified) break;
      }
      activeStage = 'post-delivery-and-stop';
      assert.equal((await control.request('finish', {}, 60_000)).postDeliveryChecks, 1); await noRelays();
      clearInterval(sampler); if (sampling) await sampling;
      await control.request('stop', {}, 15_000);
      const result = await deadline(fixtureOwned.exited, 5000, 'natural-exit-unconfirmed');
      assert.equal(result.code, 0); assert.equal(result.signal, null);
    }
    if (preflight !== 'forced') {
      for (let i = 0; i < 20; i += 1) {
        if ((await supervisor.request('members')).activeMembers === 0) { cleanupReceipt.naturalJobEmptyConfirmed = true; break; }
        await sleep(100);
      }
      assert.equal(cleanupReceipt.naturalJobEmptyConfirmed, true, 'natural-exit-unconfirmed');
    }
    if (sampleFailure && preflight !== 'forced' && preflight !== 'fault') throw sampleFailure;
    assert.equal(outputFailure, false, 'diagnostic-output-invalid');
    return { revision, preflight: preflight || null, stages,
      deployment: 'one embedded production Broker/client; Identification PowerShell connector',
      requestedRates: rates, skippedRates: RATES.filter((rate) => !stages.some((stage) => stage.offeredRate === rate)),
      baselinePermittedRates: rates,
      skipReason: preflight ? 'preflight-no-offers' : stages.some((stage) => !stage.qualified) ? 'preceding-stage-unqualified' : rates.length < RATES.length ? 'baseline-did-not-reach-higher-stage' : null,
      diagnosticBytes, commitLimitBytes, samples, powershellVersion,
      deliveryChecks: preflight === 'fault' || preflight === 'forced' ? 1 : 2,
      sampledPeakJobWorkingSetBytes: Math.max(...samples.map((sample) => ['main','relay','diagnostic','compiler'].reduce((sum, kind) => sum + sample[kind].workingSetBytes, 0))),
      accountingScope: 'sampled private-job WorkingSet is not instantaneous peak; job CPU/peak committed bytes include short-lived descendants; observer excluded and separately reported',
      ownedTerminalConfirmed: fixtureOwned.terminal(), cleanup: cleanupReceipt };
  } catch (error) { original = failure(error); throw error; }
  finally {
    clearInterval(sampler); if (sampling) await sampling;
    const errors = [];
    if (!disposed) {
      try { await closeJob(); } catch { errors.push({ stage: 'cleanup', check: 'job-exit-unconfirmed' }); }
    }
    // Only owned handles are signalled. No PID kill occurs after fixture exit.
    if (!supervisorOwned.terminal()) supervisorOwned.child.stdin.end();
    try { await deadline(supervisorOwned.exited, 5000, 'job-exit-unconfirmed'); }
    catch {
      errors.push({ stage: 'cleanup', check: 'job-exit-unconfirmed' });
      supervisorOwned.child.kill();
      try { await deadline(supervisorOwned.exited, 5000, 'job-exit-unconfirmed'); }
      catch { errors.push({ stage: 'cleanup', check: 'forced-job-exit-unconfirmed' }); }
    }
    if (!attached && !fixtureOwned.terminal()) fixtureOwned.child.kill(); // paused: no runtime descendants yet
    try { await deadline(fixtureOwned.exited, 5000, 'natural-exit-unconfirmed'); }
    catch { errors.push({ stage: 'cleanup', check: 'natural-exit-unconfirmed' }); }
    if (errors.length) {
      const error = new Error('scratch-retained'); error.cleanup = errors; error.original = original; throw error;
    }
    assert.equal(cleanupReceipt.jobEmptyConfirmed, true, 'job-exit-unconfirmed');
    rmSync(root, { recursive: true, force: true }); cleanupReceipt.scratchRemoved = true;
  }
}

async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.AGENT_COMMS_CAPACITY_PROFILE_VERIFIED, '1');
  assert.equal(process.env.AGENT_COMMS_DISPOSABLE_WINDOWS, '1');
  const components = JSON.parse(readFileSync(new URL('../../tests/fixtures/windows-host-components.json', import.meta.url)));
  assert.equal(process.version, `v${components.node.version}`);
  assert.equal(process.env.AGENT_COMMS_NODE_ARCHIVE_SHA256, components.node.sha256['win-x64']);
  assert.equal(process.argv[2], '--old'); assert.equal(process.argv[4], '--new'); assert.equal(process.argv[6], '--output');
  assert.ok(process.argv.length === 8 || (process.argv.length === 9 && process.argv[8] === '--preflight'));
  const preflight = process.argv[8] === '--preflight';
  output = path.resolve(process.argv[7]); mkdirSync(output);
  const commitLimitBytes = Math.min(2 * 1024 ** 3, Math.floor(os.totalmem() / 4));
  if (commitLimitBytes < 512 * 1024 ** 2 || os.freemem() < commitLimitBytes + 512 * 1024 ** 2) throw new Error('memory-headroom-insufficient');
  const archives = {};
  for (const [revision, cwd] of [['old', process.argv[3]], ['new', process.argv[5]]]) {
    activeStage = 'archive-source';
    const { stdout: tree } = await exec('git.exe', ['rev-parse', `${PINS[revision]}^{tree}`], { cwd, encoding: 'utf8', windowsHide: true });
    const { stdout: bytes } = await exec('git.exe', ['archive', '--format=tar', PINS[revision]], { cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const archive = path.join(output, `${revision}.tar`), source = path.join(output, revision);
    writeFileSync(archive, bytes); mkdirSync(source);
    await exec('tar.exe', ['-xf', archive, '-C', source], { windowsHide: true });
    archives[revision] = { source, pin: PINS[revision], tree: tree.trim(), archiveSha256: hash(bytes) };
  }
  const result = { v: 1, scope: 'hosted standard-user Windows finite capacity pilot; no benchmark, desktop, host or 100/s support acceptance',
    storageType: 'not-measured', nodeArchiveSha256: components.node.sha256['win-x64'],
    node: process.version, nodeExecutableSha256: hash(readFileSync(process.execPath)),
    osRelease: os.release(), arch: process.arch, logicalCpus: os.availableParallelism(), physicalMemoryBytes: os.totalmem(), commitLimitBytes,
    runnerSha256: hash(readFileSync(SELF)), policySha256: hash(readFileSync(new URL('./windows-capacity-policy.mjs', import.meta.url))), supervisorSha256: hash(readFileSync(JOB)),
    archives: Object.fromEntries(Object.entries(archives).map(([key, { source, ...value }]) => [key, value])), runs: [] };
  const persist = () => writeFileSync(path.join(output, 'capacity.json'), `${JSON.stringify(result, null, 2)}\n`);
  persist();
  for (const revision of ['old', 'new']) {
    if (preflight) {
      for (const kind of ['normal', 'fault', 'forced']) { result.runs.push(await run(archives[revision].source, revision, [], kind, commitLimitBytes)); persist(); }
    } else {
      const rates = revision === 'old' ? RATES : result.runs[0].stages.map((stage) => stage.offeredRate);
      result.runs.push(await run(archives[revision].source, revision, rates, false, commitLimitBytes)); persist();
    }
  }
  result.status = preflight || result.runs.every((entry) => entry.stages.length === 3 && entry.stages.every((stage) => stage.qualified)) ? 'passed' : 'capacity-not-qualified';
  persist(); process.stdout.write(`${JSON.stringify({ status: result.status, preflight, runs: result.runs.length })}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
}
try {
  if (process.argv[2] === '--fixture') await fixture(process.argv[3]); else await main();
} catch (error) {
  if (fixtureCleanup) await fixtureCleanup().catch(() => {});
  const result = { status: 'failed', ...failure(error), ...(error.cleanup ? { cleanup: error.cleanup, original: error.original ?? null } : {}) };
  if (output) writeFileSync(path.join(output, 'failure.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (process.argv[2] !== '--fixture') process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 1;
}
