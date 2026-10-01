import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { listen, shareSocket, socketModeFor, socketStat } from '../lib/broker/server.mjs';
import {
  install, installOptions, jobOptions, LABEL, parseLaunchctlPrint, printPlist, renderPlist, status, systemGroupId, uninstall,
} from '../lib/broker/launchagent.mjs';
import { brokerPaths } from '../lib/paths.mjs';

const AGENT_GROUP = 'agent-comms';
const MISSING_GROUP = 'agent-comms-no-such-group';
const UID = 501;
const root = mkdtempSync(path.join(os.tmpdir(), 'ac-launchagent-'));
const brokerHome = path.join(root, 'home');
const logDir = path.join(brokerHome, 'Library', 'Logs', 'agent-comms');
const plist = path.join(brokerHome, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const env = {
  ...process.env,
  AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'),
  AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker'),
};
const paths = brokerPaths(env);
const calls = [];
const launchctl = (args) => {
  calls.push(args.join(' '));
  return '';
};

// The CLI hands install its own launchctl, launchd paths, and group lookup, so
// nothing here reaches the real launchctl or changes a real group.
const options = (over = {}) => installOptions({
  group: AGENT_GROUP,
  home: brokerHome,
  uid: UID,
  paths,
  env,
  gidOf: () => 800,
  launchctl,
  ...over,
});

// plutil is what launchd parses the plist with, and it is a macOS tool, so the
// checks that read the parsed document skip on the CI runner.
const parseable = existsSync('/usr/bin/plutil');
const readPlist = (file = plist) => JSON.parse(printPlist(file));
const exists = (file) => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

after(() => rmSync(root, { recursive: true, force: true }));

test('the plist runs the broker the way the owner would by hand', () => {
  // The owner's own command, resolved to absolute paths: launchd has no shell,
  // so this must be the shape `broker install --group G` produces.
  const stock = options({ env: {} });
  assert.deepEqual(stock.args.slice(-4), ['broker', 'run', '--group', AGENT_GROUP]);
  const raw = renderPlist({ label: stock.label, args: stock.args, logDir: stock.logDir });
  assert.ok(raw.includes('<key>RunAtLoad</key>'), 'the job must start at load, not wait for a login event');
  assert.ok(!raw.includes('<key>UserName</key>'), 'a LaunchAgent runs as its owner; naming a user is a daemon');
  assert.ok(!raw.includes('<key>ProgramPrivileges</key>'), 'the broker must never ask for privilege');
  assert.ok(!raw.includes('EnvironmentVariables'), 'a stock install pins nothing');
});

test('install refuses a group that does not exist, before any side effect', () => {
  assert.throws(() => options({ gidOf: () => systemGroupId(MISSING_GROUP) }), (error) => {
    assert.equal(error.code, 'broker-group-missing');
    assert.match(error.message, new RegExp(MISSING_GROUP));
    return true;
  });
  assert.throws(() => options({ group: null }), { code: 'usage' });
  assert.throws(() => options({ gidOf: () => undefined }), { code: 'broker-group-missing' });
  assert.equal(exists(path.dirname(plist)), false);
  assert.equal(exists(logDir), false);
  assert.deepEqual(calls, []);
});

test('a group name that could address another job, or this label, is refused', () => {
  assert.throws(() => options({ group: LABEL }), { code: 'usage' });
  assert.throws(() => options({ group: '../../etc' }), { code: 'usage' });
  assert.throws(() => options({ group: 'Staff; rm -rf' }), { code: 'usage' });
});

test('install writes an absolute plist that launchd can run and then loads it', () => {
  const result = install(options());
  assert.equal(result.installed, true);
  assert.equal(result.gid, 800);
  assert.deepEqual(result.args.slice(-4), ['broker', 'run', '--group', AGENT_GROUP]);
  // launchd expands nothing, so every path it is handed must already be one.
  for (const arg of result.args.slice(0, 2)) assert.ok(path.isAbsolute(arg), `${arg} must be absolute`);

  const raw = readFileSync(plist, 'utf8');
  assert.match(raw, /<key>RunAtLoad<\/key>\n  <true\/>/);
  assert.match(raw, /<key>KeepAlive<\/key>\n  <true\/>/);
  assert.ok(!raw.includes('UserName'), 'a LaunchAgent must not name a user');
  assert.ok(!raw.includes('ProgramPrivileges'), 'no privilege escalation key');
  assert.ok(raw.includes(path.join(logDir, 'broker.log')));
  assert.ok(raw.includes(path.join(logDir, 'broker.err.log')));
  assert.deepEqual(calls, [`bootout gui/${UID}/${LABEL}`, `bootstrap gui/${UID} ${plist}`]);
  assert.equal(exists(logDir), true);
  assert.equal(statSync(plist).mode & 0o777, 0o644);
});

test('launchd reads the plist as written', { skip: parseable ? false : 'plutil is a macOS tool' }, () => {
  const { Label, ProgramArguments, KeepAlive, RunAtLoad, StandardOutPath, StandardErrorPath } = readPlist();
  assert.equal(Label, LABEL);
  assert.deepEqual(ProgramArguments, options().args);
  assert.equal(RunAtLoad, true);
  assert.equal(KeepAlive, true);
  assert.equal(StandardOutPath, path.join(logDir, 'broker.log'));
  assert.equal(StandardErrorPath, path.join(logDir, 'broker.err.log'));
  // A non-default shared and state directory has to survive into the job.
  const pinned = readPlist().EnvironmentVariables;
  assert.equal(pinned.AGENT_COMMS_SHARED_DIR, env.AGENT_COMMS_SHARED_DIR);
  assert.equal(pinned.AGENT_COMMS_BROKER_STATE_DIR, env.AGENT_COMMS_BROKER_STATE_DIR);
});

test('a stock install pins nothing, so the job uses the default paths', () => {
  const stock = options({ home: path.join(root, 'stock'), env: {} });
  assert.deepEqual(stock.environment, {});
  install(stock);
  try {
    assert.ok(!readFileSync(stock.plist, 'utf8').includes('EnvironmentVariables'));
  } finally {
    uninstall(stock);
  }
});

test('markup in a path cannot become plist structure', () => {
  const marked = options({
    home: path.join(root, 'home <b>&</b>'),
    entry: path.join(root, 'my entry &amp; <b>', 'agent-comms.mjs'),
  });
  install(marked);
  try {
    const raw = readFileSync(marked.plist, 'utf8');
    assert.ok(!raw.includes('<b>'), 'the markup must arrive escaped, as data');
    assert.ok(raw.includes('&lt;b&gt;'));
    if (parseable) assert.deepEqual(readPlist(marked.plist).ProgramArguments, marked.args);
  } finally {
    uninstall(marked);
  }
});

test('a load that fails leaves no plist behind', () => {
  const broken = options({ load: () => { throw new Error('Load failed: 5: Input/output error'); } });
  assert.throws(() => install(broken), (error) => {
    assert.equal(error.code, 'launchagent-load-failed');
    assert.match(error.message, /Input\/output error/);
    return true;
  });
  assert.equal(exists(broken.plist), false);
});

test('a re-install boots the old job out instead of failing on it', () => {
  const job = options();
  install(job);
  calls.length = 0;
  install(job);
  assert.deepEqual(calls, [`bootout gui/${UID}/${LABEL}`, `bootstrap gui/${UID} ${plist}`]);
  uninstall(job);
});

test('an unload that fails is not the answer a failed load is given', () => {
  const stuck = options({
    unload: () => { throw new Error('Boot-out failed: 3: No such process'); },
    load: () => { throw new Error('Load failed: 5: Input/output error'); },
  });
  assert.throws(() => install(stuck), { code: 'launchagent-load-failed' });
  assert.equal(exists(stuck.plist), false);
});

test('uninstall boots the job out and removes the plist', () => {
  const result = uninstall(options());
  assert.deepEqual(result, { installed: false, label: LABEL, plist, unloaded: true });
  assert.equal(exists(plist), false);
  assert.ok(calls.includes(`bootout gui/${UID}/${LABEL}`));
});

test('uninstall on a machine that never installed one is not a failure', () => {
  calls.length = 0;
  assert.equal(uninstall(options({ unload: () => { throw new Error(`Could not find service "${LABEL}"`); } })).unloaded, false);
  assert.throws(() => uninstall(options({ unload: () => { throw new Error('Boot-out failed: 3: No such process'); } })), {
    code: 'launchagent-unload-failed',
  });
});

test('status reports the job and the socket, and never fails on a stopped one', async () => {
  const dumps = {
    running: `gui/${UID}/${LABEL} = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n\tlabel = ${LABEL}\n}`,
    stopped: `gui/${UID}/${LABEL} = {\n\tstate = not running\n\tlast exit code = 1\n\tlabel = ${LABEL}\n}`,
  };
  const asLaunchctl = (job) => (args) => {
    if (args[0] === 'print' && args.at(-1).endsWith(LABEL)) {
      if (job === 'missing') throw new Error(`Could not find service "${LABEL}"`);
      return dumps[job];
    }
    return '';
  };
  const over = { group: AGENT_GROUP, paths, uid: UID, launchctl: asLaunchctl('running') };

  // Before the install: launchctl knows no such job, so status says so rather
  // than failing.
  const before = await status(options({ ...over, launchctl: asLaunchctl('missing') }));
  assert.deepEqual(before, {
    label: LABEL,
    installed: false,
    running: false,
    pid: null,
    group: { name: AGENT_GROUP, gid: null, source: null },
    socket: { path: paths.socket, present: false, mode: null, gid: null },
    pairings: { total: null, approved: null, pending: null },
    daemons: null,
  });

  const running = await status(options(over));
  assert.equal(running.installed, true);
  assert.equal(running.running, true);
  assert.equal(running.pid, 4242);

  const stopped = await status(options({ ...over, launchctl: asLaunchctl('stopped') }));
  assert.equal(stopped.installed, true);
  assert.equal(stopped.running, false);
  assert.equal(stopped.pid, null);

  // launchctl print failing is how an uninstalled job looks; report it.
  const gone = await status(options({ ...over, launchctl: asLaunchctl('missing') }));
  assert.equal(gone.installed, false);
  assert.equal(gone.pid, null);
});

test('status reads the socket mode and the socket group', async () => {
  mkdirSync(paths.shared, { recursive: true, mode: 0o755 });
  // A real socket, so the mode and gid are the kernel's answer, not a fixture.
  const server = net.createServer();
  await new Promise((resolve) => {
    server.listen(paths.socket, () => resolve());
  });
  shareSocket(paths.socket, socketModeFor(800));
  try {
    const over = {
      group: AGENT_GROUP,
      paths,
      uid: UID,
      launchctl: () => `gui/${UID}/${LABEL} = {\n\tstate = running\n\tpid = ${process.pid}\n\tlabel = ${LABEL}\n}`,
    };
    const snapshot = await status(options(over));
    assert.equal(snapshot.socket.present, true);
    assert.equal(snapshot.socket.mode, '0660');
    assert.equal(snapshot.socket.gid, process.getgid());
    assert.equal(snapshot.group.gid, process.getgid());
    assert.equal(snapshot.group.source, 'socket');
    assert.equal(snapshot.pid, process.pid);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('status counts pairings from the broker, and reports null when it cannot ask', async () => {
  const answered = await status(options({
    listPairings: async () => ({ pairings: [{ state: 'approved' }, { state: 'approved' }, { state: 'pending' }] }),
  }));
  assert.deepEqual(answered.pairings, { total: 3, approved: 2, pending: 1, accounts: Array.from({ length: 3 }, () => ({ account: undefined, hardened: false })) });

  const down = await status(options({ listPairings: async () => { throw new Error('broker-unreachable'); } }));
  assert.deepEqual(down.pairings, { total: null, approved: null, pending: null });
  assert.equal(down.daemons, null);

  const watching = await status(options({
    listDaemonWatches: async () => ({ daemons: [{ account: 'owner', watching: true }, { account: 'other', watching: false }] }),
  }));
  assert.deepEqual(watching.daemons, [{ account: 'owner', watching: true }, { account: 'other', watching: false }]);

  const unreachable = await status(options({
    listDaemonWatches: async () => { throw new Error('broker-unreachable'); },
  }));
  assert.equal(unreachable.daemons, null);
});

test('a path that is not a socket is reported as absent, not as a socket', () => {
  const decoy = path.join(root, 'decoy');
  writeFileSync(decoy, '');
  assert.equal(socketStat(decoy), null);
  assert.equal(socketStat(path.join(root, 'nothing-here')), null);
});

test('status and uninstall need no group, only the job they act on', async () => {
  // The owner removes and inspects the job by label; making either command ask
  // for --group would put a name in the way of the two commands that matter
  // when something is broken.
  const bare = jobOptions({ home: brokerHome, uid: UID, paths, launchctl });
  assert.equal(bare.job, `gui/${UID}/${LABEL}`);
  assert.equal(bare.group, undefined);
  const snapshot = await status({ ...bare, launchctl: () => { throw new Error(`Could not find service "${LABEL}"`); } });
  assert.equal(snapshot.installed, false);
  assert.equal(snapshot.group.name, null);
  assert.equal(uninstall(bare).unloaded, true);
});

test('the socket is readable and writable only inside the group', () => {
  const mode = socketModeFor(800);
  assert.equal(mode, 0o660);
  assert.equal(socketModeFor(null), 0o600);
  assert.equal(mode & 0o007, 0, 'accounts outside the group must have no access');

  const dir = path.join(root, 'share-mode');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sock');
  writeFileSync(file, '');
  shareSocket(file, mode); // no group supplied: the mode alone, no chown
  assert.equal(statSync(file).mode & 0o777, 0o660);

  let applied = false;
  shareSocket(file, mode, { setGroup: () => { applied = true; return process.getgid(); } });
  assert.equal(applied, true);
  assert.equal(statSync(file).mode & 0o777, 0o660);
});

test('an owner-only socket never touches a group', () => {
  const dir = path.join(root, 'share-owner');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sock');
  writeFileSync(file, '');
  let called = false;
  shareSocket(file, socketModeFor(null), { setGroup: () => { called = true; return process.getgid(); } });
  assert.equal(called, false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('listen gives the socket to the group the caller hands it', async () => {
  const dir = path.join(root, 'listen-group');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'broker.sock');
  const broker = { connections: new Set() };
  const server = await listen(broker, file, () => ({ ok: 1 }), socketModeFor(800), () => process.getgid());
  try {
    assert.equal(statSync(file).mode & 0o777, 0o660);
    assert.equal(statSync(file).gid, process.getgid());
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('listen without a group leaves the owner-only socket as it was', async () => {
  const dir = path.join(root, 'listen-owner');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'broker.sock');
  const server = await listen({ connections: new Set() }, file, () => ({ ok: 1 }), socketModeFor(null));
  try {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a group that cannot be applied refuses the listen instead of hanging', async () => {
  const dir = path.join(root, 'listen-refused');
  mkdirSync(dir, { recursive: true });
  const refused = listen({ connections: new Set() }, path.join(dir, 'broker.sock'), () => ({}), socketModeFor(800), () => {
    throw new Error('no such gid');
  });
  await assert.rejects(refused, /no such gid/);
});

test('the pid comes from a running job, never from a leftover field', () => {
  assert.deepEqual(parseLaunchctlPrint(`state = running\npid = 7\nlabel = ${LABEL}`), { found: true, running: true, pid: 7 });
  assert.deepEqual(parseLaunchctlPrint(`state = exited\nlast exit code = 1\nlabel = ${LABEL}`), { found: true, running: false, pid: null });
  assert.deepEqual(parseLaunchctlPrint(''), { found: false, running: false, pid: null });
  // A dump naming another label is not our job, whatever it says about state.
  assert.equal(parseLaunchctlPrint('state = running\npid = 7\nlabel = dev.qwts.other').found, false);
});
