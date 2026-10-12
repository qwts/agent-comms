import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const diagnostics = new URL('../lib/diagnostics.mjs', import.meta.url).href;
const brokerHelper = new URL('./helpers/broker.mjs', import.meta.url).href;
function run(source, policy) {
  const env = { ...process.env };
  delete env.AGENT_COMMS_DIAGNOSTICS;
  if (policy !== undefined) env.AGENT_COMMS_DIAGNOSTICS = policy;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8', timeout: 15000 });
}

test('process-start opt-out never enters diagnostic clock, randomness, serialization or helper paths', () => {
  const result = run(`
    import assert from 'node:assert/strict';
    import crypto from 'node:crypto';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { performance } from 'node:perf_hooks';
    const { brokerDiagnostic, clientDiagnostic } = await import(${JSON.stringify(diagnostics)});
    let calls = 0;
    const forbidden = () => { calls++; throw new Error('forbidden diagnostic work'); };
    crypto.randomUUID = forbidden; childProcess.spawn = forbidden;
    syncBuiltinESMExports();
    Date.now = forbidden; JSON.stringify = forbidden;
    Object.defineProperty(performance, 'now', { value: forbidden });
    process.env.AGENT_COMMS_DIAGNOSTICS = 'on';
    for (let i = 0; i < 1000; i++) {
      brokerDiagnostic('broker-started', 0);
      clientDiagnostic('transport-ready', 0);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
  `, 'off');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('unset and nonexact policies retain default diagnostics after environment mutation', async () => {
  for (const policy of [undefined, 'OFF', '0', '']) {
    const env = { ...process.env };
    delete env.AGENT_COMMS_DIAGNOSTICS;
    if (policy !== undefined) env.AGENT_COMMS_DIAGNOSTICS = policy;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { brokerDiagnostic } = await import(${JSON.stringify(diagnostics)});
      process.env.AGENT_COMMS_DIAGNOSTICS = 'off';
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(0));
      brokerDiagnostic('broker-started', 0);
    `], { env, stdio: ['pipe', 'ignore', 'pipe'] });
    let observed = false;
    let stderr = '';
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); }, 5000);
      child.on('error', reject);
      child.stderr.on('data', chunk => {
        stderr += chunk;
        if (!observed && stderr.includes('"event":"broker.started"') && stderr.includes('\n')) {
          observed = true;
          child.stdin.end('done');
        }
      });
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.equal(observed, true, stderr);
    assert.deepEqual(result, { code: 0, signal: null });
  }
});

test('producer opt-out preserves explicit offline export without enabling producers', () => {
  const cli = new URL('../bin/agent-comms.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(cli), 'diagnostics', 'export', '--input', '-'], {
    env: { ...process.env, AGENT_COMMS_DIAGNOSTICS: 'off' }, input: '', encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const artifact = JSON.parse(result.stdout);
  assert.equal(artifact.status, 'input-processed');
  assert.deepEqual(artifact.events, []);
});

test('disabled real broker and CLI still pair, join, send, read, acknowledge and refuse bad authentication',
  { skip: process.platform === 'win32', timeout: 20000 }, () => {
    const result = run(`
      import assert from 'node:assert/strict';
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      let spawned = 0;
      const original = childProcess.spawn;
      childProcess.spawn = (...args) => { spawned++; return original(...args); };
      const execFile = childProcess.execFile;
      let childDiagnostic = false;
      childProcess.execFile = (...args) => {
        const callback = args.pop();
        return execFile(...args, (error, stdout, stderr) => {
          if (stderr.includes('"component":"agent-comms-')) childDiagnostic = true;
          callback(error, stdout, stderr);
        });
      };
      syncBuiltinESMExports();
      const { withBroker } = await import(${JSON.stringify(brokerHelper)});
      await withBroker(async ({ cli, accounts }) => {
        const sent = await cli(['send', accounts.bob, '--body', 'opt-out-body', '--key', 'opt-out-key']);
        assert.equal(sent.exit, 0, JSON.stringify(sent));
        const read = await cli(['inbox', 'read'], accounts.bob);
        assert.equal(read.exit, 0, JSON.stringify(read));
        assert.equal(read.json.messages.length, 1);
        const ack = await cli(['inbox', 'ack', read.json.messages[0].id], accounts.bob);
        assert.equal(ack.exit, 0, JSON.stringify(ack));
        const empty = await cli(['inbox', 'read'], accounts.bob);
        assert.equal(empty.json.messages.length, 0);
        const refused = await cli(['inbox', 'read'], accounts.bob,
          { AGENT_COMMS_CLIENT_STATE_DIR: '/nonexistent-opt-out-credential' });
        assert.notEqual(refused.exit, 0);
      }, { brokerOptions: { mode: 'single-account' } });
      assert.equal(spawned, 0, 'broker must not launch a diagnostic helper');
      assert.equal(childDiagnostic, false, 'CLI children must not emit structured diagnostics');
    `, 'off');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
