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

// macOS implementation. POSIX test runners retain the existing Unix behaviour.
// Select before invoking an operation so win32 never reaches a Unix API.
export function createServiceStartup(platform = process.platform) {
  if (platform === 'win32') {
    const unavailable = () => fail('platform-not-implemented', 'service-startup not implemented on win32');
    return Object.freeze(Object.fromEntries(['renderPlist', 'parseLaunchctlPrint', 'printPlist', 'systemLaunchctl', 'jobOptions', 'installOptions', 'install', 'uninstall', 'status'].map((name) => [name, unavailable])));
  }
  // launchd's gui domain, not a system one: a LaunchAgent never needs root, and
  // the owner's login is what keeps the broker alive in this phase.
  const domain = (uid) => `gui/${uid}`;
  const escape = (text) => String(text).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
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

  function readPrevious(file) {
    try {
      return readFileSync(file);
    } catch {
      return null;
    }
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

export const { renderPlist, parseLaunchctlPrint, printPlist, systemLaunchctl, jobOptions, installOptions, install, uninstall, status } = createServiceStartup();
