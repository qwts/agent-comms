import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { brokerPaths } from '../lib/paths.mjs';
import { readHostConfig } from '../lib/host-config.mjs';

const cli = fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url));
const configuredClientImports = `import { admin } from ${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)};
import { brokerPaths } from ${JSON.stringify(new URL('../lib/paths.mjs', import.meta.url).href)};
import { HOST_CONFIG } from ${JSON.stringify(new URL('../lib/host-config.mjs', import.meta.url).href)};
if (HOST_CONFIG.serviceLabel !== process.env.AGENT_COMMS_SERVICE_LABEL) throw new Error('admin client host label mismatch');`;

test('fresh admin client imports use the fixture label for the native pipe namespace', () => {
  const label = `org.qwts.probe.${process.pid}`;
  const script = `${configuredClientImports}
import { pipeNameFor } from ${JSON.stringify(new URL('../lib/platform/local-channel.mjs', import.meta.url).href)};
console.log(JSON.stringify({label:HOST_CONFIG.serviceLabel,pipe:pipeNameFor(brokerPaths().admin,{sid:'S-1-5-21-1'})}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, AGENT_COMMS_SERVICE_LABEL: label }, encoding: 'utf8', timeout: 5000,
  }));
  assert.equal(result.label, label);
  assert.ok(result.pipe.endsWith(`${label}.admin.S-1-5-21-1`));
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(check, message) {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) { try { if (await check(Math.max(1, deadline - Date.now()))) return; } catch (error) { lastError = error; } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`${message}; last probe: ${lastError?.message ?? 'no successful response'}`);
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
  // local-channel captures HOST_CONFIG at module load. Set the fixture's
  // environment before importing the native client, rather than mixing a
  // parent-process channel singleton with paths from a different host.
  const probeScript = `${configuredClientImports}
try { console.log(JSON.stringify(await admin(brokerPaths(), {op:'pairings'}, {timeoutMs:Number(process.argv[1])}))); }
catch(error) { console.log(JSON.stringify({ok:false,error:{code:error.code,message:error.message}})); process.exitCode=1; }`;
  const probe = remainingMs => {
    const childMs = Math.min(10000, remainingMs);
    const requestMs = Math.min(5000, Math.max(1, childMs - 1000));
    try { return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probeScript, String(requestMs)], { env, encoding: 'utf8', timeout: childMs })).ok; }
    catch (error) {
      let result;
      try { result = JSON.parse(String(error.stdout)); } catch {}
      throw new Error(result?.error ? `${result.error.code}: ${result.error.message}` : `native admin probe failed: ${error.code ?? error.status}`);
    }
  };
  let stage = 'initial install';
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, env: cleanEnv });
  const sentinelExit = new Promise(resolve => sentinel.once('exit', resolve));
  const knownPids = new Set();
  let failure;
  try {
    run('install', '--single-account');
    for (let cycle = 0; cycle < 3; cycle++) {
      stage = `cycle ${cycle + 1} before reinstall`;
      await until(probe, 'broker admin did not become reachable');
      const oldPid = Number(readFileSync(path.join(paths.state, 'broker.lock'), 'utf8'));
      assert.ok(Number.isSafeInteger(oldPid) && alive(oldPid));
      knownPids.add(oldPid);
      stage = `cycle ${cycle + 1} reinstall`;
      run('install', '--single-account'); // production default stop helper; no injected seam
      assert.equal(alive(oldPid), false, 'install returned before the old broker exited');
      stage = `cycle ${cycle + 1} replacement reachability`;
      await until(probe, 'replacement broker admin did not become reachable');
      const newPid = Number(readFileSync(path.join(paths.state, 'broker.lock'), 'utf8'));
      knownPids.add(newPid);
      assert.notEqual(newPid, oldPid);
      assert.equal(alive(sentinel.pid), true, 'an unrelated process was stopped');
    }
    const finalPid = Number(readFileSync(path.join(paths.state, 'broker.lock'), 'utf8'));
    stage = 'explicit uninstall';
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
    if (!failure && !cleanupErrors.length) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (failure || cleanupErrors.length) {
      writeFileSync(path.join(root, 'native-result.json'), `${JSON.stringify({ stage, failure: failure?.message ?? null, cleanupErrors: cleanupErrors.map(error => error.message), knownBrokerPids: [...knownPids], label }, null, 2)}\n`);
      console.error('Native broker fixture preserved:', root);
    }
    if (cleanupErrors.length) {
      console.error('Native broker cleanup failed; fixture preserved:', root, cleanupErrors.map(error => error.message));
      if (!failure) throw new AggregateError(cleanupErrors, 'native broker cleanup failed; fixture preserved');
    }
  }
});
