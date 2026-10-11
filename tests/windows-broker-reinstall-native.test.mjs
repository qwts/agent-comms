import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { admin } from '../lib/client.mjs';
import { brokerPaths } from '../lib/paths.mjs';
import { readHostConfig } from '../lib/host-config.mjs';

const cli = fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(check, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
}

test('native CLI reinstall waits for the previous broker and preserves authenticated admin service', {
  skip: process.platform !== 'win32' || process.env.AGENT_COMMS_NATIVE_BROKER_REINSTALL !== '1', timeout: 180000,
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'comms-native-reinstall-'));
  const label = `org.qwts.comms.reinstall.${process.pid}.${Date.now()}`;
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENT_COMMS_|AGENT_BOT_|QWTS_AGENT_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
  const env = { ...cleanEnv, AGENT_COMMS_SERVICE_LABEL: label,
    AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'), AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'state'),
    AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'client'), AGENT_COMMS_LOG_DIR: path.join(root, 'logs') };
  const paths = brokerPaths(env, readHostConfig(env));
  const run = (...args) => execFileSync(process.execPath, [cli, 'broker', ...args], { env, encoding: 'utf8', timeout: 45000 });
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, env: cleanEnv });
  const sentinelExit = new Promise(resolve => sentinel.once('exit', resolve));
  const knownPids = new Set();
  let failure;
  try {
    run('install', '--single-account');
    for (let cycle = 0; cycle < 3; cycle++) {
      await until(async () => (await admin(paths, { op: 'pairings' }, { timeoutMs: 1000 })).ok, 'broker admin did not become reachable');
      const oldPid = Number(readFileSync(path.join(paths.state, 'broker.lock'), 'utf8'));
      assert.ok(Number.isSafeInteger(oldPid) && alive(oldPid));
      knownPids.add(oldPid);
      run('install', '--single-account'); // production default stop helper; no injected seam
      assert.equal(alive(oldPid), false, 'install returned before the old broker exited');
      await until(async () => (await admin(paths, { op: 'pairings' }, { timeoutMs: 1000 })).ok, 'replacement broker admin did not become reachable');
      const newPid = Number(readFileSync(path.join(paths.state, 'broker.lock'), 'utf8'));
      knownPids.add(newPid);
      assert.notEqual(newPid, oldPid);
      assert.equal(alive(sentinel.pid), true, 'an unrelated process was stopped');
    }
    const finalPid = Number(readFileSync(path.join(paths.state, 'broker.lock'), 'utf8'));
    run('uninstall');
    assert.equal(alive(finalPid), false);
    run('uninstall');
  } catch (error) { failure = error; throw error; }
  finally {
    const cleanupErrors = [];
    try {
      try { knownPids.add(Number(readFileSync(path.join(paths.state, 'broker.lock'), 'utf8'))); } catch {}
      try { run('uninstall'); } catch (error) { cleanupErrors.push(error); }
      try {
        const script = `$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); try { $null=$s.GetFolder('\\').GetTask('${label}'); [Console]::Out.Write('present') } catch { if ($_.Exception.HResult -eq -2147024894) { [Console]::Out.Write('absent') } else { throw } }`;
        const state = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: cleanEnv, encoding: 'utf8', timeout: 10000 });
        assert.equal(state, 'absent', 'fixture scheduled task is still registered');
        for (const pid of knownPids) if (Number.isSafeInteger(pid) && pid > 0) assert.equal(alive(pid), false, 'a known fixture broker remains alive');
      } catch (error) { cleanupErrors.push(error); }
    } finally {
      sentinel.kill(); // Only the process this test spawned, never a discovered PID.
      let timer;
      try {
        await Promise.race([sentinelExit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture sentinel did not exit')), 10000); })]);
      } catch (error) { cleanupErrors.push(error); }
      finally { clearTimeout(timer); }
    }
    if (!cleanupErrors.length) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      console.error('Native broker cleanup failed; fixture preserved:', root, cleanupErrors.map(error => error.message));
      if (!failure) throw new AggregateError(cleanupErrors, 'native broker cleanup failed; fixture preserved');
    }
  }
});
