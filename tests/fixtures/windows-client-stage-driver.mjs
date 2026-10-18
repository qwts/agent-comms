// Isolated harness: real connector/handshake/client code, deterministic child
// streams. This does not exercise native Windows APIs or qualify acceptance.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

const scenario = process.argv[2], root = mkdtempSync(path.join(os.tmpdir(), 'ac-client-stage-'));
const cleanupCase = scenario.startsWith('cleanup-');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(path.join(root, 'identity.json'), JSON.stringify({ v: 1, algorithm: 'ed25519', publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }));
Object.defineProperty(process, 'platform', { value: cleanupCase ? 'darwin' : 'win32' });
let child, socket, kills = 0, destroys = 0, stageReads = 0;
const deadlines = [];
if (scenario === 'startup-timeout') {
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => {
    deadlines.push(ms);
    return originalTimeout(callback, deadlines.length === 1 ? 1 : ms, ...args);
  };
}
if (cleanupCase) {
  socket = new EventEmitter(); socket.write = () => true;
  socket.destroy = () => {
    destroys += 1;
    socket.emit('error', new Error('CANARY-late-cleanup-error'));
    socket.emit('close');
    throw new Error('CANARY-disposal-throw');
  };
  net.createConnection = () => socket;
} else {
  // Keep the real artifact verifier in the integration path with an inert PE.
  // These isolated file reads never build or execute a native Windows helper.
  const originalRead = fs.readFileSync;
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const binaryFile = path.join(repo, 'bin', 'windows', 'agent-comms-pipe-relay.exe');
  const manifestFile = path.join(repo, 'bin', 'windows', 'relay-build.json');
  const source = originalRead(path.join(repo, 'native', 'windows', 'AgentCommsPipeRelay.cs'));
  const binary = Buffer.alloc(256);
  binary.write('MZ'); binary.writeUInt32LE(64, 0x3c);
  binary.write('PE\0\0', 64); binary.writeUInt16LE(0x10b, 88); binary.writeUInt16LE(2, 156);
  const digest = value => createHash('sha256').update(value).digest('hex');
  const manifest = Buffer.from(JSON.stringify({ format: 1, sourceCommit: 'a'.repeat(40),
    sourceSha256: digest(source), binarySha256: digest(binary), subsystem: 'windows' }));
  fs.readFileSync = (file, ...options) => {
    if (file === binaryFile) return binary;
    if (file === manifestFile) return manifest;
    if (file === path.join(repo, 'RELEASE_COMMIT')) return 'a'.repeat(40);
    return originalRead(file, ...options);
  };
  childProcess.spawnSync = (file) => {
    assert.equal(file, 'whoami.exe');
    return { status: 0, stdout: '"test","S-1-5-21-123"\n' };
  };
  childProcess.spawn = (file, args, options) => {
    assert.match(file, /agent-comms-pipe-relay\.exe$/);
    child = new EventEmitter();
    for (const key of ['stdin','stdout','stderr']) child[key] = new PassThrough();
    child.exitCode = child.signalCode = null;
    child.kill = () => { kills += 1; child.signalCode = 'SIGTERM'; child.emit('close'); return true; };
    if (scenario === 'success' || scenario === 'remote-injection') {
      child.stdin.on('data', (buffer) => {
        const frame = JSON.parse(buffer.toString());
        if (frame.hello) {
          const pipe = `\\\\.\\pipe\\${options.env.AGENT_COMMS_PIPE_NAME}`;
          const message = Buffer.from(`agent-comms broker handshake v1\n${pipe}\n${frame.hello}\n`);
          child.stdout.write(JSON.stringify({ v: 1, proof: sign(null, message, privateKey).toString('base64') })+'\n');
        } else child.stdout.write(JSON.stringify(scenario === 'success' ? { ok: true, value: 'actual-response' }
          : { ok: false, error: { code: 'permission-denied', message: 'ordinary refusal', windowsPipeStage: 'startup-timeout' } })+'\n');
      });
    }
    return child;
  };
}
syncBuiltinESMExports();
const { admin } = await import('../../lib/client.mjs');
const { CommsError, publicError } = await import('../../lib/errors.mjs');
const { projectWindowsPipeStage } = await import('../../lib/platform/windows-pipe-stage.mjs');
try {
  const pending = admin({ admin: path.join(root, 'admin.sock'), state: root }, { op: 'status' }, { diagnostic() {} });
  if (cleanupCase) {
    if (scenario === 'cleanup-success') socket.emit('data', Buffer.from('{"ok":true,"value":"actual-response"}\n'));
    else if (scenario === 'cleanup-typed') socket.emit('error', new CommsError('broker-untrusted', 'ordinary typed refusal'));
    else {
      const error = Object.assign(new Error('ordinary transport refusal'), { code: 'ECONNREFUSED' });
      if (scenario === 'cleanup-getter') Object.defineProperty(error, 'windowsPipeStage', { get() { stageReads += 1; throw new Error('CANARY-getter'); } });
      else error.windowsPipeStage = scenario === 'cleanup-unknown' ? 'CANARY-unknown' : 'pipe-refused';
      socket.emit('error', error);
    }
  } else if (scenario === 'typed-refusal') {
    child.stderr.write('CONNECTED\n'); child.stdout.write('{"v":1,"proof":"CANARY-invalid-proof"}\n');
  } else if (scenario === 'success' || scenario === 'remote-injection') child.stderr.write('CONNECTED\n');
  else if (scenario === 'pipe-refused') child.stderr.write('REFUSED\n');
  else if (scenario === 'host-stderr') child.stderr.write('CANARY-private-path/body\n');
  else if (scenario === 'host-clixml') child.stderr.write('#< CLIXML\r\nCANARY-private-path/body');
  else if (scenario === 'process-error') child.emit('error', new Error('CANARY-private-command'));
  else if (scenario === 'premature-close') child.emit('close');
  let result, error;
  try { result = await pending; } catch (caught) { error = caught; }
  // Duplicate post-settlement events cannot replace the original result.
  if (cleanupCase) { socket.emit('error', new Error('CANARY-duplicate')); socket.emit('close'); }
  else { child.stderr.emit('error', new Error('CANARY-duplicate')); child.emit('close'); }
  await new Promise(resolve => setImmediate(resolve));
  const stage = projectWindowsPipeStage(error);
  if (error) assert.equal(Object.keys(error).includes('windowsPipeStage'), false);
  process.stdout.write(JSON.stringify({ result, code: error?.code, stage, public: error && publicError(error), kills, destroys, stageReads, deadlines }));
} finally { rmSync(root, { recursive: true, force: true }); }
