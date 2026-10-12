import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { DIAGNOSTIC_EXPORT_LIMITS as LIMITS } from '../lib/diagnostic-export.mjs';

const BIN = fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url));
const EXPORT = new URL('../lib/diagnostic-export.mjs', import.meta.url).href;
const CANARY = 'CANARY-private-export-input-path-secret';
function root(t) { const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-export-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function record() { return { v: 1, component: 'agent-comms-broker', buildVersion: '0.5.3', buildSource: 'running',
  event: 'broker.started', eventId: randomUUID(), sessionId: randomUUID(), operation: 'broker.lifecycle', stage: 'startup',
  code: 'ready', outcome: 'succeeded', observedAtUnixMs: 100 }; }
function launch(t, args, { stdin, consume = true, env = process.env, fixture = false } = {}) {
  const child = spawn(process.execPath, fixture ? args : [BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stdout = ''; let stderr = ''; const messages = [];
  if (consume) child.stdout.on('data', (chunk) => { stdout += chunk; assert.ok(Buffer.byteLength(stdout) <= LIMITS.outputBytes + 1024); });
  child.stderr.on('data', (chunk) => { stderr += chunk; assert.ok(stderr.length < 4096); });
  child.on('message', (message) => messages.push(message));
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('owned export CLI terminal deadline')); }, 10000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, messages }); });
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); child.stdin.destroy(); child.stdout.destroy(); await closed.catch(() => {}); });
  if (stdin !== undefined) child.stdin.end(stdin);
  return { child, closed, messages };
}
async function gone(pid) {
  for (let i = 0; i < 100; i += 1) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('owned export helper did not disappear');
}
async function messageWhere(messages, predicate) {
  for (let i = 0; i < 100; i += 1) {
    const found = messages.find(predicate); if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('owned export helper receipt deadline');
}

test('explicit file/stdin export needs no credentials or broker and makes no network calls', { timeout: 15000 }, async (t) => {
  const dir = root(t); const file = path.join(dir, CANARY); const event = record();
  writeFileSync(file, `${JSON.stringify(event)}\n${CANARY}\n`);
  const preload = path.join(dir, 'no-network.mjs');
  writeFileSync(preload, "import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; net.createConnection=net.connect=http.request=https.request=()=>{throw new Error('network call forbidden');};globalThis.fetch=()=>{throw new Error('network call forbidden');};\n");
  const env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, AGENT_COMMS_SHARED_DIR: CANARY,
    AGENT_COMMS_CLIENT_STATE_DIR: CANARY, AGENT_BOT_DAEMON_URL: 'http://127.0.0.1:1', AGENT_BOT_ID: '' };
  const result = await launch(t, ['diagnostics', 'export', '--input', file, '--from-unix-ms', '100', '--until-unix-ms', '101'], { env }).closed;
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ''); assert.ok(!result.stdout.includes(CANARY));
  const artifact = JSON.parse(result.stdout); assert.deepEqual(artifact.events, [event]); assert.equal(artifact.coverage.rejectedLines, 1);
  assert.equal(artifact.coverage.sourceChanged, false); assert.equal(artifact.source.authenticity, 'unverified');
  const piped = await launch(t, ['diagnostics', 'export', '--input', '-'], { stdin: `${JSON.stringify(event)}\n` }).closed;
  assert.equal(piped.code, 0, piped.stderr); assert.deepEqual(JSON.parse(piped.stdout).events, [event]);
});

test('named source refusals and invalid arguments expose fixed errors without supplied text', { timeout: 15000 }, async (t) => {
  const dir = root(t);
  for (const args of [[], ['--input', path.join(dir, CANARY)], ['--input', dir], ['--input', '-', '--from-unix-ms', CANARY], ['--input', '-', `--${CANARY}`]]) {
    const result = await launch(t, ['diagnostics', 'export', ...args], { stdin: '' }).closed;
    assert.notEqual(result.code, 0); assert.ok(!result.stdout.includes(CANARY)); assert.ok(!result.stderr.includes(CANARY));
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
  if (process.platform !== 'win32') {
    const fifo = path.join(dir, CANARY); execFileSync('mkfifo', [fifo]);
    const result = await launch(t, ['diagnostics', 'export', '--input', fifo]).closed;
    assert.equal(result.code, 1); assert.ok(!result.stderr.includes(CANARY));
  }
});

test('idle stdin with a live writer returns partial input-timeout artifact and actual terminal', { timeout: 12000 }, async (t) => {
  const started = performance.now();
  const { child, closed } = launch(t, ['diagnostics', 'export', '--input', '-']);
  // Keep this process's pipe writer open and idle throughout the child deadline.
  assert.equal(child.stdin.destroyed, false);
  const result = await closed;
  assert.equal(result.code, 1, result.stderr); assert.equal(result.signal, null);
  const artifact = JSON.parse(result.stdout);
  assert.equal(artifact.status, 'input-failed'); assert.deepEqual(artifact.coverage.reasons, ['input-timeout']);
  assert.equal(artifact.coverage.reachedEof, false); assert.ok(performance.now() - started < 8000);
});

function writerFixture(outputFile) {
  return ['--input-type=module', '-e', `import {readFileSync} from 'node:fs'; import {writeDiagnosticExportOwned} from ${JSON.stringify(EXPORT)};
    process.on('disconnect',()=>{});
    try {await writeDiagnosticExportOwned(readFileSync(${JSON.stringify(outputFile)},'utf8'),{
      onOwnedChild:c=>process.send({supervisor:c.pid}),onOwnedWriter:pid=>process.send({writer:pid})});
      process.send({done:true},()=>process.exit(0));
    } catch(e){process.stderr.write(e.code+'\\n');process.send({done:false},()=>process.exit(1));}`];
}

test('actual unread output pipe times out and closes both owned helpers', { timeout: 12000 }, async (t) => {
  const dir = root(t); const file = path.join(dir, 'artifact.json'); writeFileSync(file, ' '.repeat(LIMITS.outputBytes));
  const started = performance.now(); const run = launch(t, writerFixture(file), { fixture: true, consume: false });
  const supervisor = await messageWhere(run.messages, (message) => message.supervisor);
  const writer = await messageWhere(run.messages, (message) => message.writer);
  const result = await run.closed;
  assert.equal(result.code, 1); assert.equal(result.signal, null); assert.equal(result.stderr, 'diagnostic-output-timeout\n');
  await gone(writer.writer); await gone(supervisor.supervisor);
  assert.ok(performance.now() - started < 7000);
});

test('actual parent loss while output is unread lets supervisor kill and reap its writer', { timeout: 12000 }, async (t) => {
  const dir = root(t); const file = path.join(dir, 'artifact.json'); writeFileSync(file, ' '.repeat(LIMITS.outputBytes));
  const run = launch(t, writerFixture(file), { fixture: true, consume: false });
  const supervisor = await messageWhere(run.messages, (message) => message.supervisor);
  const writer = await messageWhere(run.messages, (message) => message.writer);
  await new Promise((resolve) => setTimeout(resolve, 100));
  run.child.kill('SIGKILL');
  await run.closed;
  await gone(writer.writer); await gone(supervisor.supervisor);
});
