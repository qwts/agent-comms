// The Windows branches of the secret store and service startup seams
// (GeniusBar ADR-0046, decisions 3 and 4). Every runner is a fake that records
// what it was handed: nothing here runs powershell.exe or schtasks.exe, and
// nothing touches the real HOME.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createSecretStore, dpapiFileName } from '../lib/platform/secret-store.mjs';
import { createServiceStartup } from '../lib/platform/service-startup.mjs';
import { createAccountIsolation } from '../lib/platform/account-isolation.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { readHostConfig } from '../lib/host-config.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'ac-win32-'));
after(() => rmSync(root, { recursive: true, force: true }));

const LABEL = 'org.example.broker';
const home = path.join(root, 'home');
const env = {
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  USERDOMAIN: 'DESK',
  USERNAME: 'owner',
  AGENT_COMMS_SERVICE_LABEL: LABEL,
  AGENT_COMMS_CREDENTIAL_NAME: 'org.example.principal',
  AGENT_COMMS_LOG_DIR: path.join(home, 'AppData', 'Local', LABEL, 'Logs'),
  AGENT_COMMS_CLIENT_STATE_DIR: path.join(home, 'AppData', 'Local', LABEL, 'client'),
  AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'),
  AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker'),
};
const host = readHostConfig(env, home);
const client = clientPaths(env, host);
const tasksDir = path.join(env.LOCALAPPDATA, LABEL);
const taskFile = path.join(tasksDir, `${LABEL}.xml`);
// The injected makeDir below only records; the directories exist up front.
mkdirSync(tasksDir, { recursive: true });
mkdirSync(host.logDir, { recursive: true });
const credential = { principal: 'principal_test', secret: 'private & <quoted>', brokerUid: 501, mode: 'single-account' };
const hex = Buffer.from(JSON.stringify(credential)).toString('hex');

// A DPAPI stand-in: Protect reverses the bytes and Unprotect reverses them
// back, so a round trip proves the seam carries the bytes faithfully without
// any real cryptography. The script arrives on stdin, as the real one must.
const powershell = (log) => (file, args, options) => {
  log.push({ file, args, input: options.input, stdio: options.stdio });
  const protect = /\$hex = '([0-9a-f]*)'/.exec(options.input);
  if (protect) {
    const bytes = Buffer.from(protect[1], 'hex');
    return { status: 0, stdout: Buffer.from(bytes).reverse().toString('base64'), stderr: '' };
  }
  const unprotect = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(options.input);
  if (unprotect) {
    const bytes = Buffer.from(unprotect[1], 'base64').reverse();
    return { status: 0, stdout: bytes.toString('hex').toUpperCase(), stderr: '' };
  }
  return { status: 1, stdout: '', stderr: 'no such script' };
};

test('win32 secret store round-trips the principal through DPAPI on stdin, never on argv', () => {
  const calls = [];
  const store = createSecretStore('win32', { run: powershell(calls) });
  store.savePrincipalCredential(credential, host, env);
  const file = path.join(client.dir, dpapiFileName(host));
  assert.equal(file, path.join(client.dir, 'principal.org.example.principal.dpapi'));
  assert.ok(existsSync(file), 'the protected file is written to the client state directory');
  assert.deepEqual(store.readPrincipalCredential(client, host, env), credential);

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.file, 'powershell.exe');
    assert.deepEqual(call.args, ['-NoProfile', '-NonInteractive', '-Command', '-']);
    assert.deepEqual(call.stdio, ['pipe', 'pipe', 'pipe']);
    // The secret travels inside the script, hex-encoded; argv carries only flags.
    assert.ok(!call.args.join(' ').includes('principal_test'));
    assert.ok(!call.args.join(' ').includes(hex));
    assert.ok(!call.input.includes('principal_test'), 'the JSON never appears in clear, even on stdin');
  }
  const [protect, unprotect] = calls.map((call) => call.input);
  assert.ok(protect.includes(`$hex = '${hex}'`));
  assert.ok(protect.includes("[System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')"));
  assert.ok(unprotect.includes(`FromBase64String('${readFileSync(file, 'utf8').trim()}')`));
  assert.ok(unprotect.includes("[System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, 'CurrentUser')"));
  // `-Command -` executes stdin line by line, so each statement is one line
  // and the script ends with a blank line after the last one.
  for (const script of [protect, unprotect]) {
    assert.ok(script.endsWith('\n\n'));
    assert.ok(script.startsWith("$ErrorActionPreference = 'Stop'\n"));
  }
});

test('win32 secret store reports a failed Protect and a failed or garbled Unprotect', () => {
  const unwritable = createSecretStore('win32', { run: () => ({ status: 1, stdout: '', stderr: 'Exception calling "Protect"' }) });
  assert.throws(() => unwritable.savePrincipalCredential(credential, host, env), {
    code: 'keychain-write-failed',
    message: 'principal saved locally, but could not be saved to the Windows credential store',
  });
  // A script that exits 0 having written nothing has nothing worth a file.
  const silent = createSecretStore('win32', { run: () => ({ status: 0, stdout: '', stderr: '' }) });
  assert.throws(() => silent.savePrincipalCredential(credential, host, env), { code: 'keychain-write-failed' });

  const unreadable = createSecretStore('win32', { run: () => ({ status: 1, stdout: '', stderr: 'Key not valid for use in specified state.' }) });
  assert.throws(() => unreadable.readPrincipalCredential(client, host, env), {
    code: 'keychain-read-failed',
    message: 'cannot read the principal from the Windows credential store',
  });
  const garbled = createSecretStore('win32', { run: () => ({ status: 0, stdout: Buffer.from('not json').toString('hex'), stderr: '' }) });
  assert.throws(() => garbled.readPrincipalCredential(client, host, env), { code: 'credential-invalid' });

  // No file at all is a read failure, not a crash, and nothing runs for it.
  const missing = createSecretStore('win32', { run: () => assert.fail('must not run without a file') });
  const elsewhere = { dir: path.join(root, 'never-paired') };
  assert.throws(() => missing.readPrincipalCredential(elsewhere, host, env), { code: 'keychain-read-failed' });

  // A file whose bytes are not base64 is refused before they reach a script.
  const tampered = path.join(client.dir, dpapiFileName(host));
  const kept = readFileSync(tampered);
  writeFileSync(tampered, "x'); Remove-Item -Recurse $HOME #\n");
  try {
    assert.throws(() => missing.readPrincipalCredential(client, host, env), { code: 'credential-invalid' });
  } finally {
    writeFileSync(tampered, kept);
  }
});

test('win32 secret store honours AGENT_COMMS_NO_KEYCHAIN like the macOS branch', () => {
  const store = createSecretStore('win32', { run: () => assert.fail('must not run PowerShell with the store off') });
  const plain = { ...env, AGENT_COMMS_NO_KEYCHAIN: '1' };
  store.savePrincipalCredential(credential, host, plain);
  // The plain file is the account-isolation seam's; this runner's own branch
  // writes it the way the CLI does, and the win32 store reads it back through
  // the same seam.
  const paths = { ...client, credential: path.join(client.dir, 'principal.org.example.principal.json') };
  createAccountIsolation(process.platform).saveCredential(paths, credential);
  assert.deepEqual(store.readPrincipalCredential(client, host, plain), credential);
});

// A schtasks stand-in: /Create registers, /Delete drops, /Query answers for a
// registered task and fails for one it does not know, as the real one does.
function fakeSchtasks({ status = 'Ready', fail = null } = {}) {
  const calls = [];
  let registered = false;
  const run = (args) => {
    calls.push(args.join(' '));
    if (fail && args[0] === fail) throw new Error(`Command failed: schtasks.exe ${args.join(' ')}\nERROR: Access is denied.`);
    if (args[0] === '/Create') registered = true;
    if (args[0] === '/Delete' || args[0] === '/End') {
      const was = registered;
      if (args[0] === '/Delete') registered = false;
      if (!was) throw new Error('ERROR: The system cannot find the file specified.');
    }
    if (args[0] === '/Query') {
      if (!registered) throw new Error('ERROR: The system cannot find the file specified.');
      return `\nFolder: \\\nHostName:      DESK\nTaskName:      \\${LABEL}\nNext Run Time: N/A\nStatus:        ${status}\nLogon Mode:    Interactive only\n`;
    }
    return '';
  };
  return { calls, run, isRegistered: () => registered };
}

const service = createServiceStartup('win32');
const options = (over = {}) => service.installOptions({
  home, env, host, node: '/bundle/node.exe', entry: '/bundle/bin/agent-comms.mjs', paths: { socket: '/pipe/broker' }, ...over,
});

test('win32 renders a logon task that restarts the broker and appends its output to the log files', () => {
  const logDir = path.join(root, 'Logs & <more>');
  const xml = service.renderTask({
    label: 'org.example.a&b<c', args: ['/x/node.exe', '/x/agent-comms.mjs', 'broker', 'run', '--single-account'], logDir,
    environment: { AGENT_COMMS_LOG_DIR: logDir, AGENT_COMMS_CLIENT_STATE_DIR: '/x/client' }, userId: 'DESK\\owner',
  });
  const expect = (fragment) => assert.ok(xml.includes(fragment), `missing ${fragment}`);
  expect('<?xml version="1.0" encoding="UTF-16"?>');
  expect('<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">');
  expect('<URI>\\org.example.a&amp;b&lt;c</URI>');
  expect('<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>DESK\\owner</UserId>\n    </LogonTrigger>');
  expect('<Principal id="Author">\n      <UserId>DESK\\owner</UserId>\n      <LogonType>InteractiveToken</LogonType>\n      <RunLevel>LeastPrivilege</RunLevel>');
  for (const setting of ['<Hidden>true</Hidden>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '<RestartOnFailure>\n      <Interval>PT1M</Interval>\n      <Count>999</Count>\n    </RestartOnFailure>',
    '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>', '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>', '<StartWhenAvailable>true</StartWhenAvailable>']) expect(setting);
  expect('<Command>%SystemRoot%\\System32\\cmd.exe</Command>');
  const escapedLog = escapeXml(logDir);
  expect(`<Arguments>/S /C "set "AGENT_COMMS_CLIENT_STATE_DIR=/x/client" &amp;&amp; set "AGENT_COMMS_LOG_DIR=${escapedLog}" &amp;&amp; "/x/node.exe" "/x/agent-comms.mjs" "broker" "run" "--single-account" 1&gt;&gt;"${escapedLog}${path.sep}broker.log" 2&gt;&gt;"${escapedLog}${path.sep}broker.err.log""</Arguments>`);
  expect(`<WorkingDirectory>${escapedLog}</WorkingDirectory>`);
  // Markup in a label or path is text, never structure.
  assert.ok(!xml.includes('<c</URI>'));
  assert.ok(!xml.includes('& <more>'));
  // A stock install pins no environment.
  const stock = service.renderTask({ label: LABEL, args: ['/x/node.exe', '/x/cli.mjs', 'broker', 'run', '--single-account'], logDir, userId: 'DESK\\owner' });
  assert.ok(stock.includes('<Arguments>/S /C ""/x/node.exe" "/x/cli.mjs"'));
  assert.ok(!stock.includes('set "'));
  // The same document under the macOS name, so a caller never branches.
  assert.equal(service.renderPlist, service.renderTask);
  assert.equal(service.parseLaunchctlPrint, service.parseSchtasksQuery);
  assert.equal(service.printPlist, service.printTask);
  assert.equal(service.systemLaunchctl, service.systemSchtasks);
  // A quote or a percent sign has no faithful form on a cmd.exe line.
  for (const bad of ['/x/"quoted"/node.exe', '/x/%TEMP%/node.exe']) {
    assert.throws(() => service.renderTask({ label: LABEL, args: [bad], logDir, userId: 'u' }), { code: 'usage' });
  }
});

function escapeXml(text) {
  return text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
}

test('win32 install writes the task XML under LOCALAPPDATA, registers it with schtasks and runs it', () => {
  const schtasks = fakeSchtasks();
  const made = [];
  const result = service.install(options({ schtasks: schtasks.run, makeDir: (dir) => made.push(dir) }));
  assert.deepEqual(result, {
    installed: true, label: LABEL, plist: taskFile, logDir: host.logDir, group: null, gid: null,
    args: ['/bundle/node.exe', '/bundle/bin/agent-comms.mjs', 'broker', 'run', '--single-account'],
  });
  assert.deepEqual(made, [host.logDir, path.dirname(taskFile)]);
  // Stop and delete whatever was there, then create from the file, then run.
  assert.deepEqual(schtasks.calls, [
    `/End /TN ${LABEL}`,
    `/Delete /TN ${LABEL} /F`,
    `/Create /TN ${LABEL} /XML ${taskFile} /F`,
    `/Run /TN ${LABEL}`,
  ]);
  // The file is what Task Scheduler's own export is: UTF-16 with a byte-order mark.
  const bytes = readFileSync(taskFile);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  const xml = bytes.subarray(2).toString('utf16le');
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>'));
  assert.ok(xml.includes(`<URI>\\${LABEL}</URI>`));
  assert.ok(xml.includes('<UserId>DESK\\owner</UserId>'));
  assert.ok(xml.includes(`<Arguments>/S /C "set "AGENT_COMMS_BROKER_STATE_DIR=`), 'a non-default host configuration is pinned on the command line');
  // Read back the way status does.
  const unit = JSON.parse(service.printTask(taskFile));
  assert.equal(unit.Command, '%SystemRoot%\\System32\\cmd.exe');
  assert.ok(unit.Arguments.startsWith('/S /C "set "AGENT_COMMS_BROKER_STATE_DIR='));
  assert.equal(unit.WorkingDirectory, host.logDir);
  // The environment goes into the XML once, so a path with markup is read back as written.
  assert.ok(!unit.Arguments.includes('&amp;'));

  // A re-install on a machine with no task registered is not an error: /End
  // and /Delete fail, /Create answers.
  schtasks.calls.length = 0;
  service.install(options({ schtasks: schtasks.run, makeDir: () => {} }));
  assert.equal(schtasks.calls.at(-2), `/Create /TN ${LABEL} /XML ${taskFile} /F`);
  rmSync(taskFile, { force: true });
});

test('win32 install that schtasks refuses reports its stderr, and leaves no file on a first install', () => {
  const schtasks = fakeSchtasks({ fail: '/Create' });
  assert.throws(() => service.install(options({ schtasks: schtasks.run, makeDir: () => {} })), {
    code: 'launchagent-load-failed',
    message: /schtasks would not register org\.example\.broker: .*ERROR: Access is denied\./s,
  });
  assert.ok(!existsSync(taskFile));

  // With a previous install, it is put back and registered again.
  writeFileSync(taskFile, 'previous');
  const flaky = fakeSchtasks();
  let creates = 0;
  const run = (args) => {
    if (args[0] === '/Create' && creates++ === 0) throw new Error('ERROR: The task XML is malformed.');
    return flaky.run(args);
  };
  assert.throws(() => service.install(options({ schtasks: run, makeDir: () => {} })), {
    code: 'launchagent-load-failed',
    message: /malformed.*; the previous scheduled task was restored and is registered/s,
  });
  assert.equal(readFileSync(taskFile, 'utf8'), 'previous');
  rmSync(taskFile, { force: true });
});

test('win32 uninstall ends and deletes the task and removes its XML; a task never installed is not a failure', () => {
  const schtasks = fakeSchtasks();
  service.install(options({ schtasks: schtasks.run, makeDir: () => {} }));
  schtasks.calls.length = 0;
  const removed = service.uninstall(service.jobOptions({ home, env, host, schtasks: schtasks.run }));
  assert.deepEqual(removed, { installed: false, label: LABEL, plist: taskFile, unloaded: true });
  assert.deepEqual(schtasks.calls, [`/End /TN ${LABEL}`, `/Delete /TN ${LABEL} /F`]);
  assert.ok(!existsSync(taskFile));
  assert.equal(schtasks.isRegistered(), false);

  const again = service.uninstall(service.jobOptions({ home, env, host, schtasks: schtasks.run }));
  assert.equal(again.unloaded, false);

  // A delete refused for another reason is the owner's to see.
  const denied = fakeSchtasks({ fail: '/Delete' });
  denied.run(['/Create']);
  assert.throws(() => service.uninstall(service.jobOptions({ home, env, host, schtasks: denied.run })), {
    code: 'launchagent-unload-failed', message: /schtasks would not delete org\.example\.broker: .*Access is denied/s,
  });
});

test('win32 status parses the schtasks query and never fails on a stopped or missing task', async () => {
  const query = `\nFolder: \\\nHostName:      DESK\nTaskName:      \\${LABEL}\nNext Run Time: N/A\nStatus:        Running\n`;
  assert.deepEqual(service.parseSchtasksQuery(query, LABEL), { found: true, running: true, pid: null });
  assert.deepEqual(service.parseSchtasksQuery(query.replace('Running', 'Ready'), LABEL), { found: true, running: false, pid: null });
  assert.deepEqual(service.parseSchtasksQuery(query.replace('Running', 'Disabled'), LABEL), { found: true, running: false, pid: null });
  assert.deepEqual(service.parseSchtasksQuery('ERROR: The system cannot find the file specified.', LABEL), { found: false, running: false, pid: null });
  // Another task's dump never counts for this label.
  assert.deepEqual(service.parseSchtasksQuery(query, 'org.example.other'), { found: false, running: false, pid: null });
  // Field names are the OS language's; the task name is found whatever they are.
  assert.deepEqual(service.parseSchtasksQuery(`Aufgabenname:  \\${LABEL}\nStatus:        Bereit\n`, LABEL), { found: true, running: false, pid: null });

  const schtasks = fakeSchtasks({ status: 'Running' });
  const base = { home, env, host, paths: { socket: '/pipe/broker' }, schtasks: schtasks.run };
  const before = await service.status(base);
  assert.deepEqual(before, {
    label: LABEL, installed: false, running: false, pid: null,
    group: { name: null, gid: null, source: null },
    socket: { path: '/pipe/broker', present: null, mode: null, gid: null },
    pairings: { total: null, approved: null, pending: null },
    daemons: null,
    program: null,
  });
  assert.deepEqual(schtasks.calls, [`/Query /TN ${LABEL} /FO LIST /V`]);

  service.install(options({ schtasks: schtasks.run, makeDir: () => {} }));
  const running = await service.status({
    ...base,
    listPairings: async () => ({ pairings: [{ state: 'approved', account: 'owner' }, { state: 'pending', account: 'guest' }] }),
    listDaemonWatches: async () => ({ daemons: [{ account: 'owner', watching: true }] }),
  });
  assert.equal(running.installed, true);
  assert.equal(running.running, true);
  assert.equal(running.pid, null);
  assert.deepEqual(running.pairings, { total: 2, approved: 1, pending: 1, accounts: [{ account: 'owner', hardened: false }, { account: 'guest', hardened: false }] });
  assert.deepEqual(running.daemons, [{ account: 'owner', watching: true }]);
  assert.equal(running.program.args[0], '%SystemRoot%\\System32\\cmd.exe');
  assert.ok(running.program.args[1].includes('"/bundle/node.exe" "/bundle/bin/agent-comms.mjs" "broker" "run" "--single-account"'));
  assert.deepEqual([running.program.cellarPinned, running.program.repair], [false, null]);

  const stopped = await service.status({ ...base, schtasks: fakeSchtasks({ status: 'Ready' }).run });
  assert.equal(stopped.installed, false, 'the stand-in knows no task until one is created through it');
  const ready = fakeSchtasks({ status: 'Ready' });
  ready.run(['/Create']);
  const idle = await service.status({ ...base, schtasks: ready.run });
  assert.deepEqual([idle.installed, idle.running, idle.pid], [true, false, null]);
  rmSync(taskFile, { force: true });
});

test('win32 refuses a group install and a label outside the host-config grammar before anything runs', () => {
  const schtasks = fakeSchtasks();
  assert.throws(() => options({ group: 'agents', mode: 'group', schtasks: schtasks.run }), { code: 'platform-not-implemented' });
  assert.throws(() => options({ group: 'agents', schtasks: schtasks.run }), { code: 'platform-not-implemented' });
  assert.throws(() => options({ mode: 'sideways', schtasks: schtasks.run }), { code: 'usage' });
  // The label enters the task name, the file name and the schtasks argv, so
  // the host-config grammar refuses it where every other seam does.
  assert.throws(() => readHostConfig({ ...env, AGENT_COMMS_SERVICE_LABEL: 'broker /Delete' }, home), { code: 'usage' });
  assert.throws(() => readHostConfig({ ...env, AGENT_COMMS_SERVICE_LABEL: '.\\..\\other' }, home), { code: 'usage' });
  assert.deepEqual(schtasks.calls, []);
  assert.ok(!existsSync(taskFile), 'nothing was written');
});

test('win32 job options fall back to the profile when LOCALAPPDATA is unset and accept the generic runner name', () => {
  const bare = { ...env };
  delete bare.LOCALAPPDATA;
  const job = service.jobOptions({ home, env: bare, host, launchctl: () => 'generic' });
  assert.equal(job.plist, path.join(home, 'AppData', 'Local', LABEL, `${LABEL}.xml`));
  assert.equal(job.userId, 'DESK\\owner');
  assert.equal(job.schtasks([]), 'generic');
  assert.equal(job.launchctl, job.schtasks);
  const noDomain = service.jobOptions({ home, env: { ...bare, USERDOMAIN: '' }, host, schtasks: () => '' });
  assert.equal(noDomain.userId, 'owner');
});
