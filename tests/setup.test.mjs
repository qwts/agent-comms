import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { pairDaemonWithAgentBot, pairOwnDaemon, repairLauncher, setup, waitForBroker } from '../lib/setup.mjs';

function home(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-comms-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.local', 'bin'), { recursive: true });
  return dir;
}

// A broker double: pairings as the admin socket lists them, and the approvals
// and requests setup sends it.
function broker({ account = 'owner', paired = false, daemon = false, stalePending = null, daemonAnswer = { state: 'approved', autoApproved: true } } = {}) {
  const rows = [];
  if (paired) rows.push({ account, state: 'approved' });
  if (stalePending) rows.push({ account, state: 'pending', code: stalePending });
  if (daemon) rows.push({ account, kind: 'daemon', state: 'approved' });
  const calls = [];
  return {
    calls,
    install: () => { calls.push('install'); return { label: 'dev.qwts.agent-comms.broker', plist: '/LaunchAgents/x.plist' }; },
    listPairings: async () => ({ pairings: rows.map((row) => ({ ...row })) }),
    pairAccount: async () => {
      calls.push('pair-account');
      // Like the broker, a new account request replaces a pending one.
      rows.splice(0, rows.length, ...rows.filter((row) => row.kind === 'daemon' || row.account !== account));
      rows.push({ account, state: 'pending', code: 'ACCOUNT-CODE' });
      return { account, code: 'ACCOUNT-CODE', state: 'pending' };
    },
    approve: async (code) => {
      calls.push(`approve ${code}`);
      for (const row of rows) if (row.code === code) { row.state = 'approved'; delete row.code; }
      return { state: 'approved' };
    },
    pairDaemon: async () => {
      calls.push('pair-daemon');
      if (daemonAnswer.state === 'approved') rows.push({ account, kind: 'daemon', state: 'approved' });
      if (daemonAnswer.state === 'pending') rows.push({ account, kind: 'daemon', state: 'pending', code: daemonAnswer.code });
      return daemonAnswer;
    },
  };
}

const noRepair = () => ({ path: '/home/owner/.local/bin/agent-comms', state: 'absent' });

test('setup on a fresh machine installs, pairs and approves the account, then pairs the daemon', async () => {
  const fake = broker();
  const result = await setup({ account: 'owner', repair: noRepair, ...fake });
  assert.deepEqual(fake.calls, ['install', 'pair-account', 'approve ACCOUNT-CODE', 'pair-daemon']);
  assert.equal(result.ok, true);
  assert.equal(result.connected, true);
  assert.deepEqual(result.account, { name: 'owner', state: 'approved', existing: false });
  assert.deepEqual(result.daemon, { state: 'approved', autoApproved: true });
});

test('setup is idempotent: an already connected machine is only re-installed', async () => {
  const fake = broker({ paired: true, daemon: true });
  const result = await setup({ account: 'owner', repair: noRepair, ...fake });
  assert.deepEqual(fake.calls, ['install']);
  assert.equal(result.connected, true);
  assert.deepEqual(result.account, { name: 'owner', state: 'approved', existing: true });
  assert.deepEqual(result.daemon, { state: 'approved', existing: true });
});

test('setup replaces a pending account pairing from an earlier run and approves only its own code', async () => {
  const fake = broker({ stalePending: 'STALE-CODE' });
  const result = await setup({ account: 'owner', repair: noRepair, ...fake });
  assert.deepEqual(fake.calls, ['install', 'pair-account', 'approve ACCOUNT-CODE', 'pair-daemon']);
  assert.equal(result.connected, true);
  assert.deepEqual(result.account, { name: 'owner', state: 'approved', existing: false });
});

test('setup approves a pending daemon pairing from a broker without auto-approval', async () => {
  const fake = broker({ paired: true, daemonAnswer: { state: 'pending', code: 'DAEMON-CODE' } });
  const result = await setup({ account: 'owner', repair: noRepair, ...fake });
  assert.deepEqual(fake.calls, ['install', 'pair-daemon', 'approve DAEMON-CODE']);
  assert.equal(result.connected, true);
  assert.deepEqual(result.daemon, { state: 'approved', autoApproved: false });
});

test('setup without agent-bot reports not connected instead of claiming success', async () => {
  const fake = broker({ daemonAnswer: { state: 'unavailable', reason: 'agent-bot-not-found' } });
  const result = await setup({ account: 'owner', repair: noRepair, ...fake });
  assert.equal(result.ok, false);
  assert.equal(result.connected, false);
  assert.equal(result.account.state, 'approved');
  assert.deepEqual(result.daemon, { state: 'unavailable', reason: 'agent-bot-not-found' });
});

test('a daemon is never paired before its account is approved', async () => {
  const fake = broker();
  const result = await pairOwnDaemon({ account: 'owner', ...fake });
  assert.deepEqual(result, { state: 'skipped', reason: 'account-not-paired' });
  assert.deepEqual(fake.calls, []);
});

test('waitForBroker retries until the admin socket answers, and gives up with its error', async () => {
  let calls = 0;
  const answer = await waitForBroker(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('down'), { code: 'broker-unreachable' });
    return { pairings: [] };
  }, { sleep: async () => {} });
  assert.deepEqual(answer, { pairings: [] });
  assert.equal(calls, 3);
  await assert.rejects(waitForBroker(async () => { throw new Error('still down'); }, { attempts: 2, sleep: async () => {} }),
    { message: 'still down' });
});

test('repairLauncher removes only a symlink whose target is gone', (t) => {
  const dir = home(t);
  const file = path.join(dir, '.local', 'bin', 'agent-comms');
  assert.equal(repairLauncher({ home: dir }).state, 'absent');

  symlinkSync(path.join(dir, 'GeniusBar.app', 'agent-comms'), file);
  const removed = repairLauncher({ home: dir });
  assert.equal(removed.state, 'removed');
  assert.throws(() => lstatSync(file), { code: 'ENOENT' });

  const live = path.join(dir, 'live-agent-comms');
  writeFileSync(live, '#!/bin/sh\n');
  symlinkSync(live, file);
  assert.equal(repairLauncher({ home: dir }).state, 'kept');
  assert.equal(lstatSync(file).isSymbolicLink(), true);

  rmSync(file);
  writeFileSync(file, '#!/bin/sh\n');
  assert.equal(repairLauncher({ home: dir }).state, 'kept');
  assert.equal(lstatSync(file).isFile(), true);
});

test('pairDaemonWithAgentBot runs agent-bot pair-comms and keeps only the pairing state', async () => {
  const seen = [];
  const run = (file, args, options, callback) => {
    seen.push({ file, args, timeout: options.timeout });
    callback(null, JSON.stringify({ account: 'owner', state: 'approved', autoApproved: true, secret: 'CANARY' }));
  };
  assert.deepEqual(await pairDaemonWithAgentBot({ run }), { state: 'approved', autoApproved: true });
  assert.deepEqual(seen, [{ file: 'agent-bot', args: ['daemon', 'pair-comms', '--json'], timeout: 30000 }]);

  const pending = (file, args, options, callback) => callback(null, JSON.stringify({ state: 'pending', code: 'C0DE' }));
  assert.deepEqual(await pairDaemonWithAgentBot({ run: pending }), { state: 'pending', autoApproved: false, code: 'C0DE' });
  const missing = (file, args, options, callback) => callback(Object.assign(new Error('spawn agent-bot ENOENT'), { code: 'ENOENT' }));
  assert.deepEqual(await pairDaemonWithAgentBot({ run: missing }), { state: 'unavailable', reason: 'agent-bot-not-found' });
  const failed = (file, args, options, callback) => callback(Object.assign(new Error('exit 1'), { code: 1 }), 'CANARY-output');
  assert.deepEqual(await pairDaemonWithAgentBot({ run: failed }), { state: 'unavailable', reason: 'agent-bot-pair-failed' });
  const garbled = (file, args, options, callback) => callback(null, 'not json');
  assert.deepEqual(await pairDaemonWithAgentBot({ run: garbled }), { state: 'unavailable', reason: 'agent-bot-pair-failed' });
});
