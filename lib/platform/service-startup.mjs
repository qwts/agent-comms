import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { HOST_CONFIG, readHostConfig } from '../host-config.mjs';
import { fail } from '../errors.mjs';
import { socketStat } from './local-channel.mjs';
import { assertGroupName, systemGroupId } from './account-isolation.mjs';
export const LABEL = HOST_CONFIG.serviceLabel;

// #74: Homebrew keg paths are versioned (`.../Cellar/<formula>/<version>/...`)
// and vanish on `brew upgrade` + `brew cleanup`, leaving launchd looping on a
// missing binary. The `.../opt/<formula>/...` link survives upgrades, so the
// LaunchAgent records the opt form. Paths with no Cellar segment, such as a
// host app bundle's, are already stable and pass through untouched.
const HOMEBREW_CELLAR_SEGMENT = /^(.*)\/Cellar\/([^/]+)\/[^/]+(\/.*)$/;

export function stableHomebrewPath(file) {
  if (typeof file !== 'string') return file;
  const match = file.match(HOMEBREW_CELLAR_SEGMENT);
  return match ? `${match[1]}/opt/${match[2]}${match[3]}` : file;
}

const escape = (text) => String(text).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));

function readPrevious(file) {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
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

// macOS implementation. POSIX test runners retain the existing Unix behaviour.
// Select before invoking an operation so win32 never reaches a Unix API.
export function createServiceStartup(platform = process.platform) {
  if (platform === 'win32') return createScheduledTaskStartup();
  // launchd's gui domain, not a system one: a LaunchAgent never needs root, and
  // the owner's login is what keeps the broker alive in this phase.
  const domain = (uid) => `gui/${uid}`;
  const octal = (mode) => (mode === null || mode === undefined ? null : (mode & 0o7777).toString(8).padStart(4, '0'));

  // A plist is XML, so every interpolated value is escaped, and the document is
  // assembled one key per entry: a group name or home path carrying markup must
  // not become structure.
  function renderPlist({ label, args, logDir, runAtLoad = true, keepAlive = true, environment = {} }) {
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
  function parseLaunchctlPrint(raw, label = LABEL) {
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

  const printPlist = (file) => execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });

  // launchctl says why it refused on stderr ("Bootstrap failed: 5: Input/output
  // error", "Could not find service"). Piping it, rather than ignoring it, puts
  // that reason into execFileSync's error message, which is what install reports
  // and what uninstall's not-loaded check reads.
  const systemLaunchctl = (args) => execFileSync('/bin/launchctl', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });

  // install runs synchronously from the CLI, so the waits below block rather
  // than yield.
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  const launcher = (entry) => fileURLToPath(new URL(`../../bin/${entry}`, import.meta.url));

  // A default install has no environment block at all, and a non-default one
  // pins the host configuration, because launchd starts the job without
  // their shell environment.
  // The job, the plist, the log directory, and the launchctl seam. Nothing here
  // names a group, so uninstall and status need no --group: what the owner has to
  // remove and to look at is the same whoever the accounts are.
  function jobOptions({
    home = os.homedir(),
    env = process.env,
    host = readHostConfig(env, home),
    label = host.serviceLabel,
    uid = process.getuid(),
    paths,
    launchctl = systemLaunchctl,
    readPlist = printPlist,
    agentsDir = path.join(home, 'Library', 'LaunchAgents'),
    logDir = host.logDir,
    job = `${domain(uid)}/${label}`,
    listPairings = null,
    listDaemonWatches = null,
    load = (plist) => launchctl(['bootstrap', domain(uid), plist]),
    unload = () => launchctl(['bootout', job]),
    // print exits non-zero for a label launchd no longer knows.
    isLoaded = () => {
      try {
        launchctl(['print', job]);
        return true;
      } catch {
        return false;
      }
    },
    sleep = sleepSync,
    settleMs = 10_000,
    loadAttempts = 3,
  } = {}) {
    return {
      uid,
      label,
      job,
      plist: path.join(path.resolve(agentsDir), `${label}.plist`),
      logDir: path.resolve(logDir),
      paths,
      launchctl,
      readPlist,
      listPairings,
      listDaemonWatches,
      load,
      unload,
      isLoaded,
      sleep,
      settleMs,
      loadAttempts,
    };
  }

  // Absolute paths are the install's first side effect, so every one of them is
  // resolved before anything is written or loaded, and the group is resolved
  // first of all: a typo in it must leave no plist, no log directory, and no
  // half-loaded job behind.
  function installOptions({
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
      args: [stableHomebrewPath(path.resolve(node)), stableHomebrewPath(path.resolve(entry)), 'broker', 'run', ...(mode === 'group' ? ['--group', group] : ['--single-account'])],
      environment: { ...environment },
      writeFile,
      makeDir,
    };
  }

  // A job that is not loaded is the ordinary state of a machine that never
  // installed one, or of one already booted out by hand, so launchctl's not-found
  // answer means the job is gone.
  const notLoaded = (error) => /Could not find service|not found/i.test(error.message);

  // #80: bootout returns before launchd has finished tearing a running job
  // down, and a bootstrap of a label still registered is refused with
  // "Bootstrap failed: 5: Input/output error". So the install waits, bounded,
  // for the old job to be gone, and gives the bootstrap a few tries.
  function waitUntilGone(options) {
    const step = 100;
    for (let waited = 0; options.isLoaded() && waited < options.settleMs; waited += step) options.sleep(step);
  }

  function loadWithRetry(options, plist) {
    let lastError;
    for (let attempt = 1; attempt <= options.loadAttempts; attempt += 1) {
      try {
        options.load(plist);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < options.loadAttempts) {
          options.sleep(500);
          waitUntilGone(options);
        }
      }
    }
    throw lastError;
  }

  function install(options) {
    const plist = renderPlist({ label: options.label, args: options.args, logDir: options.logDir, environment: options.environment });
    options.makeDir(options.logDir); // launchd creates neither the log directory nor the plist's
    options.makeDir(path.dirname(options.plist));
    const previous = readPrevious(options.plist);
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
      waitUntilGone(options);
      loadWithRetry(options, options.plist);
    } catch (error) {
      // The old job is already booted out, so removing the new file alone would
      // leave no broker at all. Put the previous install back and start it
      // again; with no previous install, roll the file back rather than leave a
      // job only a hand-written launchctl call could start.
      let restored = '';
      if (previous) {
        options.writeFile(options.plist, previous, { mode: 0o644 });
        try {
          waitUntilGone(options);
          loadWithRetry(options, options.plist);
          restored = '; the previous LaunchAgent was restored and is loaded';
        } catch (restoreError) {
          restored = `; the previous LaunchAgent was restored but would not load either: ${restoreError.message.trim()}`;
        }
      } else {
        rmSync(options.plist, { force: true });
      }
      fail('launchagent-load-failed', `launchctl would not load ${options.label}: ${error.message.trim()}${restored}`);
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

  function uninstall(options) {
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

  // Everything an owner needs to tell a healthy broker from a broken one, with
  // every field nullable: a stopped job, an unloadable one, and a missing socket
  // are states to report, not reasons to fail the command. status needs no
  // --group to read the kernel's gid from the socket: it discovers the boundary
  // from the system, never from the install.
  async function status(options) {
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
    // A unit written before #74 pins Cellar paths and stops starting after the
    // next upgrade and cleanup; a re-install rewrites it with opt paths.
    let program = null;
    try {
      const args = JSON.parse(base.readPlist(base.plist))?.ProgramArguments;
      if (Array.isArray(args)) {
        const cellarPinned = args.some((arg) => arg !== stableHomebrewPath(arg));
        program = { args, cellarPinned, repair: cellarPinned ? 'agent-comms broker install' : null };
      }
    } catch {
      // no plist, or no plutil off macOS: nothing to report
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
      program,
    };
  }

  return Object.freeze({ renderPlist, parseLaunchctlPrint, printPlist, systemLaunchctl, jobOptions, installOptions, install, uninstall, status });
}


// Windows (docs/windows.md, the host's ADR-0046 decision 4): the broker is a per-user scheduled
// task named after the service label, registered from an XML definition
// through `schtasks /Create /XML` because the `/SC ONLOGON` shorthand cannot
// express restart on failure. Registering a task for the current user needs
// no administrator. The operations keep the macOS names, with the Windows
// name beside each, so a caller outside the seam never branches on the
// platform: the unit it writes is the task's XML instead of a plist.
const TASK_NAMESPACE = 'http://schemas.microsoft.com/windows/2004/02/mit/task';
const UTF16_BOM = Buffer.from([0xff, 0xfe]);

// Task Scheduler takes the user as DOMAIN\name; the account's SID belongs to
// the account-isolation seam, which has no Windows branch yet.
const currentUserId = (env) => {
  const name = env.USERNAME || os.userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name;
};

function createScheduledTaskStartup() {
  // A quote has no escape on a cmd.exe line and a percent sign expands, so a
  // path carrying either cannot be put on one faithfully; refusing is the
  // honest answer. Everything else is literal inside the quotes.
  function quoteForCmd(value) {
    const text = String(value);
    if (/["%\r\n]/.test(text)) fail('usage', `${text} cannot be put on a cmd.exe command line`);
    return `"${text}"`;
  }

  // Task Scheduler has no stdout or stderr path and `broker run` takes no log
  // directory, so cmd.exe appends them to the log files. It also has no
  // environment block, so a non-default host configuration is set on the
  // same line. `/S` with the whole line quoted makes cmd strip exactly the
  // outer pair and keep every inner quote.
  function commandLine({ args, logDir, environment }) {
    const pins = Object.keys(environment).sort().map((key) => `set ${quoteForCmd(`${key}=${environment[key]}`)} && `).join('');
    const program = args.map(quoteForCmd).join(' ');
    const out = quoteForCmd(path.join(logDir, 'broker.log'));
    const err = quoteForCmd(path.join(logDir, 'broker.err.log'));
    return `/S /C "${pins}${program} 1>>${out} 2>>${err}"`;
  }

  // Every interpolated value is XML-escaped, as in the plist: a label or path
  // carrying markup must not become structure.
  function renderTask({ label, args, logDir, environment = {}, userId }) {
    const element = (name, value) => `<${name}>${escape(value)}</${name}>`;
    const user = userId ?? currentUserId(process.env);
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="${TASK_NAMESPACE}">
  <RegistrationInfo>
    ${element('URI', `\\${label}`)}
    ${element('Description', `agent-comms broker (${label})`)}
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      ${element('UserId', user)}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      ${element('UserId', user)}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%SystemRoot%\\System32\\cmd.exe</Command>
      ${element('Arguments', commandLine({ args, logDir, environment }))}
      ${element('WorkingDirectory', logDir)}
    </Exec>
  </Actions>
</Task>
`;
  }

  // Task Scheduler's own export is UTF-16 with a byte-order mark, which is the
  // one encoding `schtasks /Create /XML` is known to read back.
  const taskFileBytes = (xml) => Buffer.concat([UTF16_BOM, Buffer.from(xml, 'utf16le')]);
  const readTaskFile = (file) => {
    const bytes = readFileSync(file);
    return bytes.subarray(0, 2).equals(UTF16_BOM) ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
  };

  // Read `schtasks /Query /TN <label> /FO LIST /V` for what a status needs. The
  // task is found whenever a field carries its name, whatever the field is
  // called, so this works on a non-English Windows too; Running is the one
  // word schtasks localizes that matters here, so a non-English status reads
  // as not running rather than as absent. Task Scheduler reports no pid.
  function parseSchtasksQuery(raw, label = LABEL) {
    let found = false;
    let status = null;
    for (const line of String(raw ?? '').split(/\r?\n/)) {
      const match = /^([^:]+):\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (value === `\\${label}` || value === label) found = true;
      if (key.trim() === 'Status') status = value;
    }
    return { found, running: found && status === 'Running', pid: null };
  }

  const unescape = (text) => text.replace(/&(lt|gt|amp);/g, (_, name) => ({ lt: '<', gt: '>', amp: '&' }[name]));

  // The plist is read back through plutil as JSON; the task's XML is read
  // back here, as the three Exec fields, in the same JSON-string shape.
  function printTask(file) {
    const xml = readTaskFile(file);
    const field = (name) => {
      const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
      return match ? unescape(match[1]) : null;
    };
    return JSON.stringify({ Command: field('Command'), Arguments: field('Arguments'), WorkingDirectory: field('WorkingDirectory') });
  }

  // schtasks says why it refused on stderr ("ERROR: The system cannot find the
  // file specified."); piping it puts that reason into the thrown error.
  const systemSchtasks = (args) => execFileSync('schtasks.exe', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });

  const launcher = (entry) => fileURLToPath(new URL(`../../bin/${entry}`, import.meta.url));

  // The task, its XML, the log directory, and the schtasks seam. `launchctl` is
  // accepted as the generic name for the runner so a caller written against
  // the macOS options needs no change; `schtasks` is the same injection.
  function jobOptions({
    home = os.homedir(),
    env = process.env,
    host = readHostConfig(env, home),
    label = host.serviceLabel,
    userId = currentUserId(env),
    paths,
    launchctl = systemSchtasks,
    schtasks = launchctl,
    readPlist = printTask,
    tasksDir = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), label),
    logDir = host.logDir,
    job = label,
    listPairings = null,
    listDaemonWatches = null,
    // /Create /F replaces a registered task; /Run starts it now rather than at
    // the next logon.
    load = (file) => {
      schtasks(['/Create', '/TN', label, '/XML', file, '/F']);
      schtasks(['/Run', '/TN', label]);
    },
    // /End stops a running instance and fails for a task that has none, which
    // is not the answer; /Delete's is.
    unload = () => {
      try {
        schtasks(['/End', '/TN', label]);
      } catch {
        // nothing was running
      }
      schtasks(['/Delete', '/TN', label, '/F']);
    },
    isLoaded = () => {
      try {
        schtasks(['/Query', '/TN', label]);
        return true;
      } catch {
        return false;
      }
    },
  } = {}) {
    return {
      userId,
      label,
      job,
      // `plist` keeps its name: it is the unit file a caller reads back and
      // removes, whichever format it holds.
      plist: path.join(path.resolve(tasksDir), `${label}.xml`),
      logDir: path.resolve(logDir),
      paths,
      launchctl: schtasks,
      schtasks,
      readPlist,
      listPairings,
      listDaemonWatches,
      load,
      unload,
      isLoaded,
    };
  }

  // One account only (ADR-0046, decision 1): a group install would need the
  // account-isolation seam's Windows branch, which does not exist yet, so it
  // is refused before anything is written.
  function installOptions({
    group,
    mode = 'single-account',
    env = process.env,
    home = os.homedir(),
    host = readHostConfig(env, home),
    node = process.execPath,
    entry = launcher('agent-comms.mjs'),
    environment = host.environment,
    writeFile = writeFileSync,
    makeDir = (dir) => mkdirSync(dir, { recursive: true }),
    ...job
  } = {}) {
    if (!['group', 'single-account'].includes(mode)) fail('usage', `unknown install mode ${mode}`);
    if (mode === 'group' || group) fail('platform-not-implemented', 'persona-accounts (--group) is not implemented on win32; install with --single-account');
    return {
      ...jobOptions({ ...job, env, home, host }),
      group: null,
      gid: null,
      mode,
      args: [path.resolve(node), path.resolve(entry), 'broker', 'run', '--single-account'],
      environment: { ...environment },
      writeFile,
      makeDir,
    };
  }

  // A task that is not registered is the ordinary state of a machine that
  // never installed one, or of one already deleted by hand.
  const notLoaded = (error) => /cannot find the file specified|not found|does not exist/i.test(error.message);

  function install(options) {
    const xml = renderTask({ label: options.label, args: options.args, logDir: options.logDir, environment: options.environment, userId: options.userId });
    options.makeDir(options.logDir); // Task Scheduler creates neither the log directory nor the XML's
    options.makeDir(path.dirname(options.plist));
    const previous = readPrevious(options.plist);
    options.writeFile(options.plist, taskFileBytes(xml));
    try {
      // Stop and delete first, so install is a re-install: a running instance
      // would otherwise keep the arguments of the install before this one.
      try {
        options.unload();
      } catch {
        // reported by the create below, if it matters
      }
      options.load(options.plist);
    } catch (error) {
      // The old task is already deleted, so removing the new file alone would
      // leave no broker at all. Put the previous install back and start it
      // again; with no previous install, roll the file back.
      let restored = '';
      if (previous) {
        options.writeFile(options.plist, previous);
        try {
          options.load(options.plist);
          restored = '; the previous scheduled task was restored and is registered';
        } catch (restoreError) {
          restored = `; the previous scheduled task was restored but would not register either: ${restoreError.message.trim()}`;
        }
      } else {
        rmSync(options.plist, { force: true });
      }
      fail('launchagent-load-failed', `schtasks would not register ${options.label}: ${error.message.trim()}${restored}`);
    }
    return {
      installed: true,
      label: options.label,
      plist: options.plist,
      logDir: options.logDir,
      group: null,
      gid: null,
      args: options.args,
    };
  }

  function uninstall(options) {
    let unloaded = false;
    try {
      options.unload();
      unloaded = true;
    } catch (error) {
      if (!notLoaded(error)) {
        fail('launchagent-unload-failed', `schtasks would not delete ${options.label}: ${error.message.trim()}`);
      }
    }
    rmSync(options.plist, { force: true }); // the task is gone; the XML is only its source
    return { installed: false, label: options.label, plist: options.plist, unloaded };
  }

  // Same fields as the macOS status, every one nullable. The local channel has
  // no Windows branch yet, so the socket fields say it was not asked, and there
  // is no group to report in one-account mode.
  async function status(options) {
    const base = jobOptions(options);
    let loaded = { found: false, running: false, pid: null };
    try {
      // schtasks /Query exits non-zero for a task it does not know, which is
      // the ordinary answer before the install and after the uninstall.
      loaded = parseSchtasksQuery(base.schtasks(['/Query', '/TN', base.label, '/FO', 'LIST', '/V']), base.label);
    } catch {
      // reported as not installed below
    }
    let pairings = { total: null, approved: null, pending: null };
    let daemons = null;
    try {
      pairings = await pairingCounts(base.listPairings);
    } catch {
      // A broker that is down cannot be asked; the job field says why.
    }
    try {
      daemons = await daemonWatchList(base.listDaemonWatches);
    } catch {
      daemons = null;
    }
    // The task runs cmd.exe with one argument string, so that is what args
    // holds: the command and its arguments as Task Scheduler sees them.
    let program = null;
    try {
      const unit = JSON.parse(base.readPlist(base.plist));
      if (unit?.Command) program = { args: [unit.Command, unit.Arguments ?? ''], cellarPinned: false, repair: null };
    } catch {
      // no task file: nothing to report
    }
    return {
      label: base.label,
      installed: loaded.found,
      running: loaded.running,
      pid: loaded.pid,
      group: { name: null, gid: null, source: null },
      socket: { path: base.paths?.socket ?? null, present: null, mode: null, gid: null },
      pairings,
      daemons,
      program,
    };
  }

  return Object.freeze({
    renderPlist: renderTask,
    renderTask,
    parseLaunchctlPrint: parseSchtasksQuery,
    parseSchtasksQuery,
    printPlist: printTask,
    printTask,
    systemLaunchctl: systemSchtasks,
    systemSchtasks,
    jobOptions,
    installOptions,
    install,
    uninstall,
    status,
  });
}

export const { renderPlist, parseLaunchctlPrint, printPlist, systemLaunchctl, jobOptions, installOptions, install, uninstall, status } = createServiceStartup();
