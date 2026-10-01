// A LaunchAgent in the owner's account, so the broker starts with the login
// and comes back after a crash (ADR-0006 decision 2). Everything the plist
// needs is resolved at install time: launchd expands nothing and inherits no
// shell environment, so paths and arguments are absolute and pre-split.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { HOST_CONFIG, readHostConfig } from '../host-config.mjs';
import { fail } from '../errors.mjs';
import { socketStat } from './server.mjs';

export const LABEL = HOST_CONFIG.serviceLabel;
// launchd's gui domain, not a system one: a LaunchAgent never needs root, and
// the owner's login is what keeps the broker alive in this phase.
const domain = (uid) => `gui/${uid}`;
// A label is a single job, so a group sharing one would make launchctl address
// the wrong job on every later call. The rest of the shape is what dseditgroup
// accepts, hyphens included: the value lands in one plist string, never in a
// shell, so the check is about a group, not about escaping.
const GROUP_NAME = /^[a-z_][a-z0-9_.-]{0,30}$/;

export function assertGroupName(name, label = LABEL) {
  if (!GROUP_NAME.test(String(name)) || name === label) {
    fail('usage', `--group takes a group name like agent-comms, not ${name}`);
  }
  return name;
}

const escape = (text) => String(text).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
const octal = (mode) => (mode === null || mode === undefined ? null : (mode & 0o7777).toString(8).padStart(4, '0'));

// A plist is XML, so every interpolated value is escaped, and the document is
// assembled one key per entry: a group name or home path carrying markup must
// not become structure.
export function renderPlist({ label, args, logDir, runAtLoad = true, keepAlive = true, environment = {} }) {
  const string = (value) => `    <string>${escape(value)}</string>\n`;
  const array = (values) => `  <array>\n${values.map((value) => `    <string>${escape(value)}</string>\n`).join('')}  </array>\n`;
  const dict = (values) => `  <dict>\n${Object.keys(values).sort().map((key) => `    <key>${escape(key)}</key>\n${string(values[key])}`).join('')}  </dict>\n`;
  const environmentKeys = Object.keys(environment);
  const entries = [
    ['Label', string(label)],
    ['ProgramArguments', array(args)],
    // Only a non-default directory is pinned, so a stock install asks launchd
    // for nothing.
    ...(environmentKeys.length === 0 ? [] : [['EnvironmentVariables', dict(environment)]]),
    ['RunAtLoad', `  <${runAtLoad ? 'true' : 'false'}/>\n`],
    ['KeepAlive', `  <${keepAlive ? 'true' : 'false'}/>\n`],
    ['ProcessType', string('Background')],
    ['StandardOutPath', string(path.join(logDir, 'broker.log'))],
    ['StandardErrorPath', string(path.join(logDir, 'broker.err.log'))],
  ];
  const body = entries.map(([key, value]) => `  <key>${key}</key>\n${value}`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}</dict>
</plist>
`;
}

// Read the launchctl print fields a status needs out of a flat indentation
// tree, and report a pid only while launchd calls the job running. The job is
// reported as found whenever the dump names the label, so a stopped agent reads
// as not running rather than as absent.
export function parseLaunchctlPrint(raw, label = LABEL) {
  const fields = new Map();
  let found = false;
  for (const line of String(raw ?? '').split('\n')) {
    const match = /^\s*([\w.-]+) = (.+?);?\s*$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'label' && value === label) found = true;
    fields.set(key, value);
  }
  const running = fields.get('state') === 'running' || (!fields.has('state') && fields.has('pid'));
  return { found, running, pid: running && /^\d+$/.test(fields.get('pid') ?? '') ? Number(fields.get('pid')) : null };
}

export const printPlist = (file) => execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
});

// A group is a macOS Directory Service object, so it is looked up there and
// never created here: the owner makes groups, the broker only names one.
export function systemGroupId(name) {
  assertGroupName(name);
  if (process.platform !== 'darwin') {
    fail('broker-group-missing', `group ${name} is a macOS construct, and this broker release runs on macOS only`);
  }
  try {
    // macOS keeps groups in Directory Service, not in /etc/group.
    const out = execFileSync('/usr/bin/dscl', ['.', '-read', `/Groups/${name}`, 'PrimaryGroupID'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const id = out.match(/PrimaryGroupID:\s*(\d+)/)?.[1];
    if (id) return Number(id);
  } catch {
    // no such group
  }
  fail('broker-group-missing', `no group named ${name}; create it and add each agent account, then install again`);
}

export const systemLaunchctl = (args) => execFileSync('/bin/launchctl', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
});

const launcher = (entry) => fileURLToPath(new URL(`../../bin/${entry}`, import.meta.url));

// A default install has no environment block at all, and a non-default one
// pins the host configuration, because launchd starts the job without
// their shell environment.
// The job, the plist, the log directory, and the launchctl seam. Nothing here
// names a group, so uninstall and status need no --group: what the owner has to
// remove and to look at is the same whoever the accounts are.
export function jobOptions({
  home = os.homedir(),
  env = process.env,
  host = readHostConfig(env, home),
  label = host.serviceLabel,
  uid = process.getuid(),
  paths,
  launchctl = systemLaunchctl,
  agentsDir = path.join(home, 'Library', 'LaunchAgents'),
  logDir = host.logDir,
  job = `${domain(uid)}/${label}`,
  listPairings = null,
  listDaemonWatches = null,
  load = (plist) => launchctl(['bootstrap', domain(uid), plist]),
  unload = () => launchctl(['bootout', job]),
} = {}) {
  return {
    uid,
    label,
    job,
    plist: path.join(path.resolve(agentsDir), `${label}.plist`),
    logDir: path.resolve(logDir),
    paths,
    launchctl,
    listPairings,
    listDaemonWatches,
    load,
    unload,
  };
}

// Absolute paths are the install's first side effect, so every one of them is
// resolved before anything is written or loaded, and the group is resolved
// first of all: a typo in it must leave no plist, no log directory, and no
// half-loaded job behind.
export function installOptions({
  group,
  mode = 'group',
  env = process.env,
  home = os.homedir(),
  host = readHostConfig(env, home),
  node = process.execPath,
  entry = launcher('agent-comms.mjs'),
  environment = host.environment,
  gidOf = systemGroupId,
  writeFile = writeFileSync,
  makeDir = (dir) => mkdirSync(dir, { recursive: true, mode: 0o755 }),
  ...job
} = {}) {
  if (!['group', 'single-account'].includes(mode)) fail('usage', `unknown install mode ${mode}`);
  if (mode === 'group' && !group) fail('usage', 'name the agent group: agent-comms broker install --group GROUP');
  if (mode === 'single-account' && group) fail('usage', 'single-account install cannot use --group');
  let gid = null;
  if (mode === 'group') {
    assertGroupName(group, host.serviceLabel);
    gid = gidOf(group);
    if (!Number.isInteger(gid) || gid <= 0) fail('broker-group-missing', `group ${group} has no usable gid`);
  }
  return {
    ...jobOptions({ ...job, home, host }),
    group,
    gid,
    mode,
    args: [path.resolve(node), path.resolve(entry), 'broker', 'run', ...(mode === 'group' ? ['--group', group] : ['--single-account'])],
    environment: { ...environment },
    writeFile,
    makeDir,
  };
}

// A job that is not loaded is the ordinary state of a machine that never
// installed one, or of one already booted out by hand, so launchctl's not-found
// answer means the job is gone.
const notLoaded = (error) => /Could not find service|not found/i.test(error.message);

export function install(options) {
  const plist = renderPlist({ label: options.label, args: options.args, logDir: options.logDir, environment: options.environment });
  options.makeDir(options.logDir); // launchd creates neither the log directory nor the plist's
  options.makeDir(path.dirname(options.plist));
  options.writeFile(options.plist, plist, { mode: 0o644 });
  try {
    // Boot out first, so install is a re-install: launchctl refuses to
    // bootstrap a label that is already loaded, and a loaded job would
    // otherwise keep running the arguments of the install before this one. An
    // unload failure is not the answer here; the bootstrap is.
    try {
      options.unload();
    } catch {
      // reported by the bootstrap below, if it matters
    }
    options.load(options.plist);
  } catch (error) {
    // Roll the file back rather than leave a job only a hand-written launchctl
    // call could start.
    rmSync(options.plist, { force: true });
    fail('launchagent-load-failed', `launchctl would not load ${options.label}: ${error.message.trim()}`);
  }
  return {
    installed: true,
    label: options.label,
    plist: options.plist,
    logDir: options.logDir,
    group: options.group,
    gid: options.gid,
    args: options.args,
  };
}

export function uninstall(options) {
  let unloaded = false;
  try {
    options.unload();
    unloaded = true;
  } catch (error) {
    if (!notLoaded(error)) {
      fail('launchagent-unload-failed', `launchctl would not unload ${options.label}: ${error.message.trim()}`);
    }
  }
  rmSync(options.plist, { force: true }); // no plist means no job at the next login
  return { installed: false, label: options.label, plist: options.plist, unloaded };
}

// The admin socket is 0600 in the owner's own state directory, so the owner can
// ask the broker for its pairings and no client account can. Null counts mean
// the probe was not supplied or the broker is not answering, never zero.
async function pairingCounts(listPairings) {
  if (typeof listPairings !== 'function') return { total: null, approved: null, pending: null };
  const answer = await listPairings();
  const pairings = answer?.pairings ?? [];
  return {
    total: pairings.length,
    approved: pairings.filter((pairing) => pairing.state === 'approved').length,
    pending: pairings.filter((pairing) => pairing.state === 'pending').length,
    accounts: pairings.filter((pairing) => pairing.kind !== 'daemon')
      .map(({ account, hardened = false }) => ({ account, hardened })),
  };
}

// Null means the broker could not be asked. An empty list means it answered
// and no account it knows has a daemon stream open.
async function daemonWatchList(listDaemonWatches) {
  if (typeof listDaemonWatches !== 'function') return null;
  const answer = await listDaemonWatches();
  return (answer?.daemons ?? []).map((row) => ({ account: row.account, watching: row.watching === true }));
}

// Everything an owner needs to tell a healthy broker from a broken one, with
// every field nullable: a stopped job, an unloadable one, and a missing socket
// are states to report, not reasons to fail the command. status needs no
// --group to read the kernel's gid from the socket: it discovers the boundary
// from the system, never from the install.
export async function status(options) {
  const base = jobOptions(options);
  const label = base.label;
  const job = base.job;
  let loaded = { found: false, running: false, pid: null };
  try {
    // launchctl print exits non-zero for a job it does not know, which is the
    // ordinary answer before the install and after the uninstall.
    loaded = parseLaunchctlPrint(base.launchctl(['print', job]), label);
  } catch {
    // reported as not installed below
  }
  const stat = socketStat(base.paths.socket);
  // The socket's own group is the boundary the kernel enforces at connect(2),
  // so it is the gid worth reporting, whatever the install asked for.
  const group = { name: options.group ?? null, gid: stat?.gid ?? null, source: stat ? 'socket' : null };
  let pairings = { total: null, approved: null, pending: null };
  let daemons = null;
  try {
    pairings = await pairingCounts(base.listPairings);
  } catch {
    // A broker that is down cannot be asked; the job and socket fields say why.
  }
  try {
    daemons = await daemonWatchList(base.listDaemonWatches);
  } catch {
    daemons = null;
  }
  return {
    label,
    installed: loaded.found,
    running: loaded.running,
    pid: loaded.pid,
    group,
    socket: {
      path: base.paths.socket,
      present: Boolean(stat),
      mode: octal(stat?.mode),
      gid: stat?.gid ?? null,
    },
    pairings,
    daemons,
  };
}
