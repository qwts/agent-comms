// Real Windows engine acceptance for #127. Run only in a disposable runner.
// No platform, process, credential-store, transport or OS runner is injected.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  assert.ok(['--bot', '--released-comms', '--components', '--report'].includes(flag), 'unknown acceptance argument');
  assert.ok(process.argv[index + 1], 'acceptance argument needs a path');
  options[flag.slice(2)] = path.resolve(process.argv[index + 1]);
}
for (const required of ['bot', 'released-comms', 'components', 'report']) assert.ok(options[required], `--${required} is required`);
assert.equal(process.platform, 'win32', 'this harness requires real Windows');
assert.equal(process.env.AGENT_COMMS_DISPOSABLE_WINDOWS, '1', 'set AGENT_COMMS_DISPOSABLE_WINDOWS=1 only for a disposable Windows account');

const components = JSON.parse(readFileSync(options.components));
assert.equal(process.version, `v${components.node.version}`, 'run with the host-selected Node sidecar');
assert.equal(process.env.AGENT_COMMS_NODE_ARCHIVE_SHA256, components.node.sha256['win-x64'], 'the workflow must verify the actual Node archive');
const result = {
  platform: process.platform, architecture: process.arch, node: process.version,
  nodeArchiveSha256: process.env.AGENT_COMMS_NODE_ARCHIVE_SHA256,
  nodeExecutableSha256: hash(readFileSync(process.execPath)),
  engineOnly: true, cases: [],
  fixtureSource: components.fixtureSource,
  untested: ['published Windows host package', 'window/tray lifecycle', 'signed installer/updater',
    'non-administrator account installation', 'actual logoff/logon', 'host service migration', 'owner-decision custody (#77)'],
};
const local = process.env.LOCALAPPDATA;
assert.ok(local && path.isAbsolute(local), 'Windows profile LOCALAPPDATA is required');
const root = mkdtempSync(path.join(local, 'agent-comms acceptance '));
const label = `test.agent-comms.${randomUUID()}`;
const taskLabels = new Set([label]);
const env = { ...process.env,
  AGENT_COMMS_SERVICE_LABEL: label, AGENT_COMMS_CREDENTIAL_NAME: `${label}.principal`,
  AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'),
  AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker state'),
  AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'client state'),
  AGENT_COMMS_LOG_DIR: path.join(root, 'logs'),
  XDG_STATE_HOME: path.join(root, 'bot state'),
};
for (const name of ['NODE_OPTIONS', 'AGENT_COMMS_BROKER_ACCOUNT', 'AGENT_COMMS_MODE', 'AGENT_COMMS_NO_KEYCHAIN',
  'AGENT_BOT_ID', 'QWTS_AGENT_ID', 'AGENT_BOT_BINDING', 'AGENT_BOT_COMMS_DAEMON_PATH']) {
  delete env[name];
  delete process.env[name];
}
Object.assign(process.env, env);
const candidateBin = path.join(repository, 'bin', 'agent-comms.mjs');
const releasedBin = path.join(options['released-comms'], 'bin', 'agent-comms.mjs');
let supervisor;
let failed = false;

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function command(file, args, childEnv = env, timeout = 30_000) {
  try {
    const out = await exec(file, args, { env: childEnv, timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { exit: 0, stdout: out.stdout, stderr: out.stderr };
  } catch (error) {
    return { exit: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}
async function cli(args, { bin = candidateBin, childEnv = env, ok = true } = {}) {
  const out = await command(process.execPath, [bin, ...args], childEnv);
  let json;
  try { json = JSON.parse(out.stdout); } catch { json = null; }
  if (ok) assert.equal(out.exit, 0, `CLI ${args.slice(0, 2).join(' ')} failed (${json?.error?.code ?? 'no-json-response'})`);
  return { ...out, json };
}
async function until(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${description} did not become ready`);
}
async function record(name, run) {
  try {
    const evidence = await run();
    result.cases.push({ name, status: 'passed', ...evidence });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    result.cases.push({ name, status: 'failed', code: error.code ?? error.name });
    process.stderr.write(`FAIL ${name}: ${error.code ?? error.name}\n`);
    throw error;
  }
}
async function ready() {
  let lastReply;
  try {
    await until(async () => {
      lastReply = await cli(['broker', 'pairings'], { ok: false });
      return lastReply.exit === 0;
    }, 'real broker');
  } catch (error) {
    // Keep diagnostics useful without copying arbitrary CLI output or logs,
    // which may contain credentials after a later restart in this harness.
    const safeCode = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null;
    const diagnostic = { cliExit: lastReply?.exit ?? null, cliCode: safeCode(lastReply?.json?.error?.code) };
    const task = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; $task=Get-ScheduledTask -TaskName $env:AGENT_COMMS_SERVICE_LABEL; $info=Get-ScheduledTaskInfo -InputObject $task; @{state=$task.State.ToString();lastTaskResult=$info.LastTaskResult;lastRunTime=$info.LastRunTime.ToString("o")} | ConvertTo-Json -Compress']);
    try {
      const info = JSON.parse(task.stdout);
      diagnostic.task = { state: safeCode(info.state), lastTaskResult: Number(info.lastTaskResult), lastRunTime: info.lastRunTime };
    } catch { diagnostic.taskQueryExit = task.exit; }
    diagnostic.logs = [];
    for (const name of ['broker.log', 'broker.err.log']) {
      let bytes;
      try { bytes = readFileSync(path.join(env.AGENT_COMMS_LOG_DIR, name)); } catch { continue; }
      const text = bytes.toString('utf8');
      diagnostic.logs.push({ name, bytes: bytes.length, sha256: hash(bytes),
        errorNames: [...new Set(text.match(/\b[A-Z][A-Za-z]{1,40}Error\b/g) ?? [])],
        systemCodes: [...new Set(text.match(/\b(?:ENOENT|EACCES|EPERM|EADDRINUSE|ECONNREFUSED|EINVAL|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b/g) ?? [])],
        errorCodes: [...new Set([...text.matchAll(/"code"\s*:\s*"([a-zA-Z0-9_-]{1,80})"/g)].map(match => match[1]))],
        shellFailure: /not recognized as an internal or external command/i.test(text) ? 'command-not-recognized'
          : /system cannot find the (?:path|file) specified/i.test(text) ? 'path-or-file-not-found'
            : /access is denied/i.test(text) ? 'access-denied'
              : /syntax of the command is incorrect/i.test(text) ? 'command-syntax' : null,
      });
    }
    result.readinessFailures ??= [];
    result.readinessFailures.push(diagnostic);
    error.code = 'broker-not-ready';
    throw error;
  }
}
async function stopTask(bin = candidateBin) {
  await cli(['broker', 'uninstall'], { bin });
}
async function installTask(bin = candidateBin) {
  // The unique label is already tracked for cleanup if registration fails.
  const { json } = await cli(['broker', 'install', '--single-account'], { bin });
  assert.equal(json.installed, true);
  await ready();
  const xml = readFileSync(json.plist).subarray(2).toString('utf16le');
  assert.ok(xml.includes(bin.replaceAll('&', '&amp;')), 'registered unit must select the tested engine');
  assert.ok(xml.includes(process.execPath.replaceAll('&', '&amp;')), 'unit must use the sidecar Node');
  return { task: label, unit: path.basename(json.plist) };
}

try {
  result.candidate = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  for (const [key, directory] of [['agent-bot', options.bot], ['agent-comms', options['released-comms']]]) {
    const commit = (await exec('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(commit, components.components[key].ref, 'fixture must match the host component pin');
      const version = JSON.parse(readFileSync(path.join(directory, 'package.json'))).version;
      assert.equal(`v${version}`, components.components[key].tag, 'release tag/version must agree');
      result[key] = { commit, version };
  }
  const [{ createPrincipalClient }, client, { brokerPaths, clientPaths }, { readHostConfig, principalFileName }, store, isolation] = await Promise.all([
    import('../lib/principal-client.mjs'), import('../lib/client.mjs'), import('../lib/paths.mjs'),
    import('../lib/host-config.mjs'), import('../lib/platform/secret-store.mjs'), import('../lib/platform/account-isolation.mjs'),
  ]);
  const paths = brokerPaths(env);
  const host = readHostConfig(env);
  const sid = isolation.currentUid();
  assert.match(sid, /^S-1-5-/);
  result.accountSid = sid;
  let principal;
  let account;
  let soulToken;
  let nativeVouchKey;
  const soul = `agent_${randomUUID()}`;
  const durableFiles = () => [path.join(paths.state, 'identity.json'), path.join(paths.state, 'identity.key'),
    clientPaths(env).credential, path.join(clientPaths(env).dir, store.dpapiFileName(host))];
  let durableHashes;
  let originalMessage;

  await record('real scheduled-task broker install and custom profile namespace', async () => {
    const installed = await installTask();
    const status = (await cli(['broker', 'status'])).json;
    assert.equal(status.label, label);
    assert.equal(status.installed, true);
    assert.equal(status.running, true);
    assert.equal(status.socket.path, paths.socket);
    return installed;
  });
  await record('native account and DPAPI principal pairing', async () => {
    const pair = (await cli(['account', 'pair'])).json;
    await cli(['broker', 'approve', pair.code]);
    account = client.loadCredential(clientPaths(env));
    assert.equal(account.brokerUid, sid);
    assert.ok(account.brokerKey);
    const paired = (await cli(['principal', 'pair', '--name', 'Disposable Windows acceptance'])).json;
    await cli(['admin', 'principal-approve', paired.code]);
    const dpapi = path.join(clientPaths(env).dir, store.dpapiFileName(host));
    assert.match(readFileSync(dpapi, 'utf8').trim(), /^[A-Za-z0-9+/]+=*$/);
    // Remove the known legacy plaintext copy to prove the default library
    // actually loads DPAPI, without claiming pairing no longer writes it.
    rmSync(path.join(clientPaths(env).dir, principalFileName(host)));
    principal = createPrincipalClient({ env });
    assert.equal(principal.principal, paired.principal);
    assert.ok(Array.isArray((await principal.census()).souls));
    return { plainCopyRemovedForProbe: true, custody: 'CurrentUser; same-account processes remain authorized' };
  });
  await record('real SID custody and profile-path refusal', async () => {
    for (const directory of [paths.shared, paths.proofs, paths.state, clientPaths(env).dir]) isolation.assertOwnedDir(directory, sid);
    assert.throws(() => isolation.assertOwnedDir(paths.state, 'S-1-5-21-1-2-3-9999'), { code: 'broker-untrusted' });
    const notDirectory = path.join(root, 'not-a-directory');
    writeFileSync(notDirectory, 'fixture');
    assert.throws(() => isolation.assertOwnedDir(notDirectory, sid), { code: 'broker-untrusted' });
  });
  await record('DPAPI corruption and broker-key mismatch refuse', async () => {
    const dpapi = path.join(clientPaths(env).dir, store.dpapiFileName(host));
    const encrypted = readFileSync(dpapi);
    try {
      writeFileSync(dpapi, Buffer.from('not a DPAPI credential').toString('base64'));
      assert.throws(() => createPrincipalClient({ env }), { code: 'keychain-read-failed' });
    } finally { writeFileSync(dpapi, encrypted); }
    const saved = store.readPrincipalCredential(clientPaths(env), host, env);
    const wrongKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    await assert.rejects(client.callPrincipal(paths, { ...saved, brokerKey: wrongKey }, { op: 'census' }), { code: 'broker-untrusted' });
    assert.ok(Array.isArray((await createPrincipalClient({ env }).census()).souls));
  });
  const bot = await import(pathToFileURL(path.join(options.bot, 'comms-client.mjs')));
  const vouch = await import(pathToFileURL(path.join(options.bot, 'vouch.mjs')));
  const freshToken = () => vouch.signSoulToken({ account: account.account, agentId: soul, parent: null }, nativeVouchKey.privateKey);
  await record('released bot pairs using its normal native vouch-key provider', async () => {
    const paired = await bot.pairDaemonComms({ env });
    await cli(['broker', 'approve', paired.code]);
    const key = vouch.loadOrCreateVouchKey(vouch.vouchStateDir({ env }));
    nativeVouchKey = key;
    assert.equal(key.created, false, 'pairing must already have created the real key');
    const keyHash = hash(readFileSync(key.file));
    assert.equal(hash(readFileSync(vouch.loadOrCreateVouchKey(vouch.vouchStateDir({ env })).file)), keyHash);
    soulToken = freshToken();
    await client.call(paths, account, { op: 'join', agentId: soul, soulToken, name: 'native acceptance', harness: 'acceptance' });
    assert.equal((await principal.census()).souls.find(row => row.agentId === soul).verification, 'verified');
    supervisor = bot.createCommsSupervisor({ env });
    supervisor.start();
    await until(() => supervisor.getState().connected, 'released bot account-watch');
    originalMessage = await principal.send({ to: `${account.account}/${soul}`, body: 'Windows durable acceptance', key: randomUUID() });
    await until(() => supervisor.getState().lastWake?.messageIds.includes(originalMessage.messageId), 'real daemon wake');
    durableHashes = durableFiles().map(file => hash(readFileSync(file)));
    return { providerInjected: false, nativeWatch: true, signedSoulVerified: true };
  });
  await record('scheduled-task restart preserves credentials, identity and mailbox', async () => {
    await stopTask();
    await installTask();
    await until(() => supervisor.getState().connected && supervisor.getState().reconnects > 0, 'released bot reconnect');
    assert.deepEqual(durableFiles().map(file => hash(readFileSync(file))), durableHashes);
    const inbox = await client.call(paths, account, { op: 'read', agentId: soul, soulToken: freshToken() });
    assert.ok(inbox.messages.some(message => message.id === originalMessage.messageId));
    await client.call(paths, account, { op: 'ack', agentId: soul, soulToken: freshToken(), ids: [originalMessage.messageId] });
  });
  await record('released comms and candidate reopen the same native state', async () => {
    await stopTask();
    await installTask(releasedBin);
    assert.deepEqual(durableFiles().map(file => hash(readFileSync(file))), durableHashes);
    assert.equal((await principal.census()).souls.find(row => row.agentId === soul).verification, 'verified');
    assert.ok(!(await client.call(paths, account, { op: 'read', agentId: soul, soulToken: freshToken() })).messages.some(message => message.id === originalMessage.messageId));
    await stopTask(releasedBin);
    await installTask();
    assert.deepEqual(durableFiles().map(file => hash(readFileSync(file))), durableHashes);
    return { writer: result.candidate, releasedReader: result['agent-comms'].commit, candidateReopened: true };
  });
  await record('group install refuses before registering another task', async () => {
    const otherLabel = `${label}.group`;
    taskLabels.add(otherLabel);
    const refused = await cli(['broker', 'install', '--group', 'agents'], { childEnv: { ...env, AGENT_COMMS_SERVICE_LABEL: otherLabel }, ok: false });
    assert.notEqual(refused.exit, 0);
    assert.equal(refused.json?.error?.code, 'platform-not-implemented');
    assert.notEqual((await command('schtasks.exe', ['/Query', '/TN', otherLabel])).exit, 0);
  });
  await record('candidate and released broker refuse an unknown future record without changing log bytes', async () => {
    const futureState = path.join(root, 'future state');
    mkdirSync(futureState);
    const futureLog = path.join(futureState, 'events.jsonl');
    const bytes = Buffer.concat([readFileSync(path.join(paths.state, 'events.jsonl')),
      Buffer.from('{"t":"acceptance-future-record"}\n')]);
    writeFileSync(futureLog, bytes);
    const futureEnv = { ...env, AGENT_COMMS_SERVICE_LABEL: `${label}.future`,
      AGENT_COMMS_BROKER_STATE_DIR: futureState, AGENT_COMMS_SHARED_DIR: path.join(root, 'future shared') };
    for (const bin of [candidateBin, releasedBin]) {
      const refused = await cli(['broker', 'run', '--single-account'], { bin, childEnv: futureEnv, ok: false });
      assert.notEqual(refused.exit, 0);
      assert.ok(`${refused.stdout}${refused.stderr}`.includes('unknown log record type acceptance-future-record'));
      assert.deepEqual(readFileSync(futureLog), bytes);
    }
  });
  await record('supervised bot broker-environment regression is measured', async () => {
    const module = await import(pathToFileURL(path.join(options.bot, 'daemon-supervisor.mjs')));
    const unitEnv = module.supervisorEnvironment({ env });
    const unit = module.renderScheduledTask({ programArguments: [process.execPath, path.join(options.bot, 'agent-bot.mjs'), 'daemon', 'run'],
      environment: unitEnv, label: `${label}.bot-probe`, logPath: path.join(root, 'daemon.log') });
    const settings = ['AGENT_COMMS_SERVICE_LABEL', 'AGENT_COMMS_SHARED_DIR', 'AGENT_COMMS_BROKER_STATE_DIR'];
    const missing = settings.filter(name => unitEnv[name] !== env[name]);
    if (missing.length !== settings.length) {
      result.cases.push({ name: 'supervised bot custom-namespace restart', status: 'needs-retriage', missing });
      throw new Error('released supervisor behavior changed; revalidate the recorded blocker');
    }
    for (const name of settings) assert.ok(!unit.includes(name), 'the actual rendered task must omit the missing setting');
    // Execute the real Windows pairing entry point in the environment a task
    // actually pins. It must fail at the exact missing-shared-dir guard,
    // before key creation, pairing or an accidental default-broker request.
    const taskEnv = { ...env, ...unitEnv };
    for (const name of settings) delete taskEnv[name];
    delete taskEnv.XDG_STATE_HOME;
    await assert.rejects(bot.pairDaemonComms({ env: taskEnv }), error => error.code === 'usage'
      && error.message === 'AGENT_COMMS_SHARED_DIR must match the Windows broker host configuration');
    result.cases.push({ name: 'supervised bot custom-namespace restart', status: 'blocked-observed',
      missing, dependency: 'true-line/geniusbar#46 comment 6104555216; distinct from agent-bot#865' });
    return { expectedNegative: true, fullDaemonTaskAcceptance: false };
  });
  await record('uninstall removes only the disposable task and preserves state', async () => {
    supervisor.stop();
    await stopTask();
    assert.notEqual((await command('schtasks.exe', ['/Query', '/TN', label])).exit, 0);
    assert.deepEqual(durableFiles().map(file => hash(readFileSync(file))), durableHashes);
  });
} catch (error) {
  failed = true;
  result.failure = { code: error.code ?? error.name };
} finally {
  supervisor?.stop();
  for (const task of taskLabels) {
    // Every possible registration attempt is namespaced and tracked before
    // invoking the CLI, including a group-mode regression that registered.
    await command('schtasks.exe', ['/End', '/TN', task]);
    await command('schtasks.exe', ['/Delete', '/TN', task, '/F']);
    const remaining = await command('schtasks.exe', ['/Query', '/TN', task]);
    if (remaining.exit === 0 || remaining.exit === -1) {
      failed = true;
      result.cleanup = 'failed-task-absence-unverified';
    }
    rmSync(path.join(local, task), { recursive: true, force: true });
  }
  result.cleanup ??= 'namespaced-tasks-absent';
  rmSync(root, { recursive: true, force: true });
  result.requiredEngineChecks = failed ? 'failed' : 'passed';
  result.completeEmbeddingAcceptance = false;
  mkdirSync(path.dirname(options.report), { recursive: true });
  writeFileSync(options.report, `${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = failed ? 1 : 0;
}
