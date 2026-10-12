// Optional native Windows historical-state upgrade acceptance for #127.
// Only newly generated state; no old reader ever opens upgraded authoritative state.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { windowsPowershellEnvironment } from '../lib/platform/windows-environment.mjs';
import { writeWindowsAcceptanceReport } from './windows-acceptance-cleanup.mjs';
import { taskQueryProvesAbsence, safeFailure, assertOriginalRetry, assertRetainedMessage } from './windows-upgrade-evidence.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.env.AGENT_COMMS_DISPOSABLE_WINDOWS, '1');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--historical-comms', '--current-comms', '--bot', '--components', '--report'].includes(process.argv[i]) && process.argv[i + 1]);
  options[process.argv[i].slice(2)] = path.resolve(process.argv[i + 1]);
}
for (const name of ['historical-comms', 'current-comms', 'bot', 'components', 'report']) assert.ok(options[name]);
const components = JSON.parse(readFileSync(options.components));
assert.equal(process.version, `v${components.node.version}`);
assert.equal(process.env.AGENT_COMMS_NODE_ARCHIVE_SHA256, components.node.sha256['win-x64']);
const repository = fileURLToPath(new URL('../', import.meta.url));
const currentRelease = { tag: 'v0.4.1', ref: '0ff470bd92f67b205eb1f5e121416960e7317420' }; // Test pin, not a host manifest.
const root = mkdtempSync(path.join(process.env.LOCALAPPDATA, "agent-comms upgrade's "));
const reportRelative = path.relative(root, options.report);
assert.ok(reportRelative === '..' || reportRelative.startsWith(`..${path.sep}`) || path.isAbsolute(reportRelative), 'report must be outside disposable runtime');
const label = `test.agent-comms.${randomUUID()}`;
const env = { ...process.env,
  AGENT_COMMS_SERVICE_LABEL: label, AGENT_COMMS_CREDENTIAL_NAME: `${label}.principal`,
  AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'), AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker state'),
  AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'client state'), AGENT_COMMS_LOG_DIR: path.join(root, 'logs'),
  AGENT_BOT_COMMS_DAEMON_PATH: path.join(root, 'daemon credential.json'), XDG_STATE_HOME: path.join(root, 'bot state'),
};
const selected = new Set(['AGENT_COMMS_SERVICE_LABEL', 'AGENT_COMMS_CREDENTIAL_NAME', 'AGENT_COMMS_SHARED_DIR',
  'AGENT_COMMS_BROKER_STATE_DIR', 'AGENT_COMMS_CLIENT_STATE_DIR', 'AGENT_COMMS_LOG_DIR', 'AGENT_BOT_COMMS_DAEMON_PATH']);
for (const key of Object.keys(env)) {
  if (((key.startsWith('AGENT_COMMS_') || key.startsWith('AGENT_BOT_')) && !selected.has(key)) || /^(QWTS_AGENT_|GH_APP_HOOK_)/.test(key) || key === 'NODE_OPTIONS') {
    delete env[key]; delete process.env[key];
  }
}
Object.assign(process.env, env);
const exec = promisify(execFile);
const historicalBin = path.join(options['historical-comms'], 'bin/agent-comms.mjs');
const currentBin = path.join(options['current-comms'], 'bin/agent-comms.mjs');
const result = { platform: process.platform, architecture: process.arch, node: process.version, osRelease: os.release(), osVersion: os.version(),
  fixtureSource: components.fixtureSource, componentsSha256: hash(readFileSync(options.components)),
  nodeExecutableSha256: hash(readFileSync(process.execPath)), nodeArchiveSha256: components.node.sha256['win-x64'], cases: [],
  scope: 'native v0.3.16 foreground engine state upgraded by released v0.4.1 scheduled engine',
  untested: ['historical scheduled-task conversion', 'host installer/updater', 'packaged tuple', 'logoff/logon', 'downgrade'] };
let stage = 'source-provenance';
let failed = false;
let owned;
let taskAttempted = false;
let client;
let paths;
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function command(file, args, childEnv = env) {
  try { return { exit: 0, ...await exec(file, args, { env: file === 'powershell.exe' ? windowsPowershellEnvironment(childEnv) : childEnv,
    windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }) }; }
  catch (error) { return { exit: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}
async function cli(bin, args) {
  const response = await command(process.execPath, [bin, ...args]);
  let body;
  try { body = JSON.parse(response.stdout); } catch { /* no raw output in report */ }
  if (response.exit !== 0) throw Object.assign(new Error('CLI refused'), { code: safeFailure(body?.error).code });
  return body;
}
async function until(check, code, timeout = 40000) {
  stage = code;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw Object.assign(new Error(code), { code });
}
async function record(name, run) {
  stage = name;
  try { result.cases.push({ name, status: 'passed', ...await run() }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { result.cases.push({ name, status: 'failed', ...safeFailure(error, stage) }); throw error; }
}
function startOwned(bin, childEnv = env, logName = 'historical-startup.log') {
  assert.equal(owned, undefined);
  const fd = openSync(path.join(root, logName), 'a');
  const child = spawn(process.execPath, [bin, 'broker', 'run', '--single-account'], { env: childEnv, windowsHide: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const entry = { child, closed: false };
  entry.done = new Promise(resolve => { child.once('error', error => { entry.error = safeFailure(error); }); child.once('close', (code, signal) => { entry.closed = true; entry.exit = code; entry.signal = signal; resolve(); }); });
  owned = entry;
  return entry;
}
async function stopOwned() {
  if (!owned) return;
  const entry = owned;
  if (!entry.closed) entry.child.kill(); // Own ChildProcess handle, never PID discovery or generic termination.
  await until(() => entry.closed, 'owned-foreground-stop-timeout', 10000);
  owned = undefined;
}
async function endpointAbsent() {
  try { await client.admin(paths, { op: 'pairings' }); return false; }
  catch (error) { if (error.code === 'broker-unreachable') return true; throw error; }
}
async function installCurrent() {
  stage = 'install-current-task'; taskAttempted = true;
  const installation = await cli(currentBin, ['broker', 'install', '--single-account']);
  assert.equal(installation.installed, true);
  const xml = readFileSync(installation.plist).toString('utf16le').replace(/^\uFEFF/, '');
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(xml);
  assert.ok(encoded, 'current task must own its process tree');
  const launch = Buffer.from(encoded[1], 'base64').toString('utf16le');
  for (const executable of [process.execPath, currentBin]) assert.ok(launch.includes(executable.replaceAll("'", "''")));
  await until(async () => { try { await client.admin(paths, { op: 'pairings' }); return true; } catch (error) { if (error.code === 'broker-unreachable') return false; throw error; } }, 'current-broker-ready-timeout');
}
async function stopCurrent() {
  stage = 'stop-current-task';
  await cli(currentBin, ['broker', 'uninstall']);
  assert.ok(taskQueryProvesAbsence(await command('schtasks.exe', ['/Query', '/TN', label])));
  await until(endpointAbsent, 'current-endpoint-stop-timeout');
}
try {
  const inputs = [['harness', repository], ['historical', options['historical-comms']], ['current', options['current-comms']], ['bot', options.bot]];
  result.sources = {};
  for (const [name, directory] of inputs) {
    const dirty = await exec('git', ['-C', directory, 'status', '--porcelain', '--untracked-files=normal']);
    assert.equal(dirty.stdout.trim(), '', 'clean source checkout required');
    const ref = (await exec('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim();
    const version = JSON.parse(readFileSync(path.join(directory, 'package.json'))).version;
    result.sources[name] = { ref, version };
  }
  assert.equal(result.sources.historical.ref, components.components['agent-comms'].ref);
  assert.equal(`v${result.sources.historical.version}`, components.components['agent-comms'].tag);
  assert.equal(result.sources.bot.ref, components.components['agent-bot'].ref);
  assert.equal(`v${result.sources.bot.version}`, components.components['agent-bot'].tag);
  assert.equal(result.sources.current.ref, currentRelease.ref);
  assert.equal(`v${result.sources.current.version}`, currentRelease.tag);
  result.currentRelease = currentRelease;
  const load = (directory, name) => import(pathToFileURL(path.join(directory, name)));
  const [oldClient, oldPaths, oldPrincipal, newClient, newPaths, newPrincipal, hostModule, secrets, isolation, bot, vouch] = await Promise.all([
    load(options['historical-comms'], 'lib/client.mjs'), load(options['historical-comms'], 'lib/paths.mjs'), load(options['historical-comms'], 'lib/principal-client.mjs'),
    load(options['current-comms'], 'lib/client.mjs'), load(options['current-comms'], 'lib/paths.mjs'), load(options['current-comms'], 'lib/principal-client.mjs'),
    load(options['current-comms'], 'lib/host-config.mjs'), load(options['current-comms'], 'lib/platform/secret-store.mjs'),
    load(options['current-comms'], 'lib/platform/account-isolation.mjs'), load(options.bot, 'comms-client.mjs'), load(options.bot, 'vouch.mjs'),
  ]);
  client = oldClient; paths = oldPaths.brokerPaths(env);
  assert.deepEqual(paths, newPaths.brokerPaths(env));
  const host = hostModule.readHostConfig(env);
  const clientPaths = newPaths.clientPaths(env);
  const sid = isolation.currentUid();
  const souls = [0, 1].map(() => `agent_${randomUUID()}`);
  const botHome = path.join(root, 'bot home'); mkdirSync(botHome);
  let principal, originalPrincipalId, account, key, original, acknowledged, principalReply, baseline, approvedPairings, approvedPrincipals, originalEnvelope;
  const unreadPayload = { to: null, body: 'historical retained Unicode ☃ mail', key: randomUUID(), refs: ['opaque:historical-reference'], correlation: 'upgrade-continuity' };
  const token = soul => vouch.signSoulToken({ account: account.account, agentId: soul, parent: null }, key.privateKey);
  const request = (soul, op, fields = {}) => client.call(paths, account, { op, agentId: soul, soulToken: token(soul), ...fields });
  const durableFiles = () => ({ brokerIdentity: path.join(paths.state, 'identity.json'), brokerPrivateKey: path.join(paths.state, 'identity.key'),
    accountCredential: clientPaths.credential, principalDpapi: path.join(clientPaths.dir, secrets.dpapiFileName(host)),
    daemonCredential: bot.commsCredentialFile({ env, home: botHome }), vouchPrivateKey: key.file });
  const credentialHashes = () => Object.fromEntries(Object.entries(durableFiles()).map(([name, file]) => [name, hash(readFileSync(file))]));
  const logHash = () => hash(readFileSync(path.join(paths.state, 'events.jsonl')));
  await record('historical-foreground-seeds-native-credentials-mail-and-ack', async () => {
    const historical = startOwned(historicalBin);
    await until(async () => { if (historical.closed) throw Object.assign(new Error('historical broker stopped'), { code: 'historical-startup-failed' }); try { await client.admin(paths, { op: 'pairings' }); return true; } catch (error) { if (error.code === 'broker-unreachable') return false; throw error; } }, 'historical-ready-timeout');
    const paired = await cli(historicalBin, ['account', 'pair']); await cli(historicalBin, ['broker', 'approve', paired.code]);
    account = client.loadCredential(oldPaths.clientPaths(env)); assert.equal(account.brokerUid, sid);
    const pairedPrincipal = await cli(historicalBin, ['principal', 'pair', '--name', 'Historical upgrade acceptance']);
    await cli(historicalBin, ['admin', 'principal-approve', pairedPrincipal.code]);
    rmSync(path.join(clientPaths.dir, hostModule.principalFileName(host)));
    principal = oldPrincipal.createPrincipalClient({ env }); originalPrincipalId = pairedPrincipal.principal; assert.equal(principal.principal, originalPrincipalId);
    const pairedDaemon = await bot.pairDaemonComms({ env, home: botHome }); await cli(historicalBin, ['broker', 'approve', pairedDaemon.code]);
    key = vouch.loadOrCreateVouchKey(vouch.vouchStateDir({ env, home: botHome })); assert.equal(key.created, false);
    for (const soul of souls) await request(soul, 'join', { name: 'historical synthetic soul', harness: 'acceptance' });
    unreadPayload.to = `${account.account}/${souls[1]}`;
    original = await principal.send(unreadPayload);
    originalEnvelope = (await request(souls[1], 'read')).messages.find(message => message.id === original.messageId);
    assert.ok(originalEnvelope);
    acknowledged = await principal.send({ ...unreadPayload, to: `${account.account}/${souls[0]}`, key: randomUUID() });
    assert.equal((await request(souls[0], 'ack', { ids: [acknowledged.messageId] })).acknowledged, 1);
    principalReply = await request(souls[0], 'send', { to: principal.principal, body: 'historical principal inbox', key: randomUUID() });
    approvedPairings = (await client.admin(paths, { op: 'pairings' })).pairings;
    approvedPrincipals = (await client.admin(paths, { op: 'principals' })).principals;
    assert.ok(approvedPairings.every(pairing => pairing.state === 'approved'));
    baseline = credentialHashes();
    await stopOwned(); await until(endpointAbsent, 'historical-endpoint-stop-timeout');
    const records = readFileSync(path.join(paths.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(records.every(record => record.t !== 'checkpoint'), 'seed must be historical event-log state');
    result.historicalLogSha256 = logHash(); result.credentialSha256 = baseline;
    result.approvedPairingsSha256 = hash(Buffer.from(JSON.stringify(approvedPairings)));
    result.originalPrincipalId = originalPrincipalId;
    return { historicalScheduledTaskInstalled: false, foregroundTermination: 'owned-child-handle', nativeDpapiOnlyProbe: true,
      originalMessage: { messageId: original.messageId, seq: original.seq }, acknowledgedMessageId: acknowledged.messageId };
  });
  async function continuity() {
    assert.deepEqual(credentialHashes(), baseline);
    assert.deepEqual((await client.admin(paths, { op: 'pairings' })).pairings, approvedPairings);
    assert.deepEqual((await client.admin(paths, { op: 'principals' })).principals, approvedPrincipals);
    principal = newPrincipal.createPrincipalClient({ env });
    assert.equal(principal.principal, originalPrincipalId);
    const census = await principal.census();
    for (const soul of souls) assert.equal(census.souls.find(row => row.agentId === soul).verification, 'verified');
    assertRetainedMessage((await request(souls[1], 'read')).messages, original, unreadPayload, originalEnvelope);
    assert.ok(!(await request(souls[0], 'read')).messages.some(message => message.id === acknowledged.messageId));
    assert.deepEqual(await request(souls[0], 'ack', { ids: [acknowledged.messageId] }), { ok: true, acknowledged: 0, alreadyAcknowledged: 1 });
    assert.equal((await request(souls[0], 'message-status', { id: acknowledged.messageId })).status, 'retained');
    assert.ok((await principal.inbox()).messages.some(message => message.id === principalReply.messageId && message.body === 'historical principal inbox'));
    assertOriginalRetry(original, await principal.send(unreadPayload));
    await assert.rejects(principal.send({ ...unreadPayload, body: 'conflicting changed body' }), { code: 'conflict' });
    return { unchangedCredentials: true, originalUnackedMail: true, originalAck: true, principalInbox: true, originalRetryOutcome: true };
  }
  await record('current-released-task-upgrades-historical-state', async () => {
    client = newClient; paths = newPaths.brokerPaths(env);
    await installCurrent(); const evidence = await continuity();
    const checkpoint = JSON.parse(readFileSync(path.join(paths.state, 'events.jsonl'), 'utf8').split('\n')[0]);
    assert.equal(checkpoint.t, 'checkpoint'); assert.equal(checkpoint.version, 3);
    result.upgradedLogSha256 = logHash();
    return { ...evidence, checkpointVersion: 3 };
  });
  await record('current-task-restart-preserves-upgraded-outcomes', async () => {
    await stopCurrent(); result.beforeRestartLogSha256 = logHash(); await installCurrent();
    const evidence = await continuity(); result.afterRestartLogSha256 = logHash(); return evidence;
  });
  await record('future-record-copy-refuses-and-original-compatible-state-recovers', async () => {
    await stopCurrent();
    const copyState = path.join(root, 'future state'); cpSync(paths.state, copyState, { recursive: true });
    const file = path.join(copyState, 'events.jsonl'); const bytes = Buffer.concat([readFileSync(file), Buffer.from('{"t":"acceptance-future-record"}\n')]); writeFileSync(file, bytes);
    const copyEnv = { ...env, AGENT_COMMS_SERVICE_LABEL: `${label}.future`, AGENT_COMMS_SHARED_DIR: path.join(root, 'future shared'), AGENT_COMMS_BROKER_STATE_DIR: copyState };
    const probe = startOwned(currentBin, copyEnv, 'future-startup.log');
    await until(() => probe.closed, 'future-copy-refusal-timeout', 10000);
    assert.notEqual(probe.exit, 0);
    assert.ok(readFileSync(path.join(root, 'future-startup.log'), 'utf8').includes('unknown log record type acceptance-future-record'), 'refusal must identify the unsupported future record');
    assert.deepEqual(readFileSync(file), bytes); owned = undefined;
    assert.deepEqual(credentialHashes(), baseline);
    await installCurrent(); return { ...await continuity(), authoritativeOldReaderOpened: false, futureCopySha256: hash(bytes), copyUnchanged: true };
  });
  result.testedAccountSid = sid;
  result.custodyScope = 'Owner/type predicates and native CurrentUser DPAPI behavior; same-account code can access its own files. ACL rights are not enumerated.';
  result.pathCustody = ['shared', 'proofs', 'state'].map(name => { isolation.assertOwnedDir(paths[name], sid); return { location: name, creator: 'broker', osAccount: 'tested-account-SID', predicate: 'real-directory-current-account-SID' }; });
  isolation.assertOwnedDir(clientPaths.dir, sid);
  result.pathCustody.push({ location: 'client-state-and-DPAPI', creator: 'historical-CLI', osAccount: 'tested-account-SID', predicate: 'real-directory-current-account-SID-and-CurrentUser-DPAPI' });
} catch (error) { failed = true; result.failure = safeFailure(error, stage); }
finally {
  const errors = [];
  const note = (operation, error) => errors.push({ operation, ...safeFailure(error) });
  try { await stopOwned(); } catch (error) { note('stop-owned-foreground', error); }
  if (taskAttempted) {
    await command('schtasks.exe', ['/End', '/TN', label]); await command('schtasks.exe', ['/Delete', '/TN', label, '/F']);
  }
  const absent = taskQueryProvesAbsence(await command('schtasks.exe', ['/Query', '/TN', label]));
  if (!absent) note('verify-task-absence');
  if (client && paths) { try { await until(endpointAbsent, 'cleanup-endpoint-stop-timeout', 10000); } catch (error) { note('verify-endpoint-absence', error); } }
  if (errors.length) failed = true;
  if (!failed) {
    for (const directory of [path.join(env.LOCALAPPDATA, label), root]) {
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch (error) { failed = true; note('remove-disposable-directory', error); break; }
    }
  }
  if (failed && existsSync(root)) result.retainedRuntimeDirectory = root;
  result.cleanup = errors.length ? 'failed' : 'owned-foreground-stopped-and-namespaced-task-absent';
  if (errors.length) result.cleanupErrors = errors;
  result.requiredUpgradeChecks = failed ? 'failed' : 'passed';
  writeWindowsAcceptanceReport(options.report, result); process.exitCode = failed ? 1 : 0;
}
