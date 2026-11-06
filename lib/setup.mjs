// One-command single-account setup (#280): repair a stale launcher, install
// the broker, pair this account and its agent-bot daemon, then verify both.
// Every side effect is a seam so tests never touch launchd or agent-bot.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAEMON_PAIR_TIMEOUT_MS = 30_000;

// A link left by an earlier install (a host app's bundle, an old keg) shadows
// the working CLI on PATH. Only a symlink whose target is gone is removed.
export function repairLauncher({ home = os.homedir(), fs = { existsSync, lstatSync, readlinkSync, rmSync } } = {}) {
  const file = path.join(home, '.local', 'bin', 'agent-comms');
  let stat;
  try { stat = fs.lstatSync(file); } catch { return { path: file, state: 'absent' }; }
  if (!stat.isSymbolicLink()) return { path: file, state: 'kept' };
  const target = path.resolve(path.dirname(file), fs.readlinkSync(file));
  if (fs.existsSync(target)) return { path: file, state: 'kept' };
  fs.rmSync(file, { force: true });
  return { path: file, state: 'removed', target };
}

// `agent-bot daemon pair-comms` holds the daemon's credential; agent-comms
// never reads it. Its output is reduced to the fields setup reports.
export function pairDaemonWithAgentBot({ run = execFile, env = process.env, timeoutMs = DAEMON_PAIR_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    run('agent-bot', ['daemon', 'pair-comms', '--json'], {
      env, timeout: timeoutMs, maxBuffer: 65536, windowsHide: true, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) {
        resolve({ state: 'unavailable', reason: error.code === 'ENOENT' ? 'agent-bot-not-found' : 'agent-bot-pair-failed' });
        return;
      }
      let answer;
      try { answer = JSON.parse(stdout); } catch { answer = null; }
      if (!answer || !['approved', 'pending'].includes(answer.state)) {
        resolve({ state: 'unavailable', reason: 'agent-bot-pair-failed' });
        return;
      }
      resolve({ state: answer.state, autoApproved: answer.autoApproved === true,
        ...(answer.state === 'pending' && typeof answer.code === 'string' ? { code: answer.code } : {}) });
    });
  });
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// launchd starts the job asynchronously, so the admin socket may not answer yet.
export async function waitForBroker(listPairings, { attempts = 50, stepMs = 200, sleep = sleepFor } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await listPairings(); }
    catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(stepMs);
    }
  }
}

const accountRow = (rows, account) => rows.find((row) => row.account === account && row.kind !== 'daemon');
const daemonApproved = (rows, account) => rows.some((row) => row.account === account && row.kind === 'daemon' && row.state === 'approved');

// A daemon pairing needs the account approved first. A pending daemon pairing
// (an older broker without auto-approval) is approved by the owner running this.
export async function pairOwnDaemon({ account, listPairings, approve, pairDaemon }) {
  const rows = (await listPairings()).pairings ?? [];
  if (accountRow(rows, account)?.state !== 'approved') return { state: 'skipped', reason: 'account-not-paired' };
  const result = await pairDaemon();
  if (result.state === 'pending' && result.code) {
    await approve(result.code);
    return { state: 'approved', autoApproved: false };
  }
  return result;
}

export async function setup({ account = os.userInfo().username, repair = repairLauncher, install, listPairings,
  pairAccount, approve, pairDaemon = pairDaemonWithAgentBot, wait = waitForBroker }) {
  const launcher = repair();
  const broker = install();
  const before = (await wait(listPairings)).pairings ?? [];
  const accountExisting = accountRow(before, account)?.state === 'approved';
  // A pending row from an earlier run is not approved: its secret may not be the
  // one saved locally. A new request replaces it, and only its own code is approved.
  if (!accountExisting) {
    const request = await pairAccount();
    await approve(request.code);
  }
  const daemon = accountExisting && daemonApproved(before, account)
    ? { state: 'approved', existing: true }
    : await pairOwnDaemon({ account, listPairings, approve, pairDaemon });
  const after = (await listPairings()).pairings ?? [];
  const accountState = accountRow(after, account)?.state ?? 'absent';
  const connected = accountState === 'approved' && daemonApproved(after, account);
  return { ok: connected, connected, launcher, broker: { label: broker.label, plist: broker.plist },
    account: { name: account, state: accountState, existing: accountExisting }, daemon };
}
