import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sha256 } from '../lib/broker.mjs';
import { admin, call, callPrincipal, loadCredential } from '../lib/client.mjs';
import { withBroker } from './helpers/broker.mjs';

const BIN = fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url));

// The seam is agent-bot's runSpawnHooks join call and child environment.
// No agent-bot install, daemon state files, or external services are used.
async function fixture(run) {
  return withBroker(async (f) => {
    const credential = loadCredential({ dir: path.join(f.root, 'client'), credential: path.join(f.root, 'client/credential.json') });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const proof = `${randomUUID()}.proof`;
    const secretHash = sha256(randomBytes(32));
    writeFileSync(path.join(f.paths.proofs, proof), secretHash, { mode: 0o644 });
    const pairing = await admin({ admin: f.paths.socket }, {
      op: 'daemon-pair-request', account: credential.account, proof, secretHash,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    });
    await admin(f.paths, { op: 'approve', code: pairing.code });
    const child = `agent_${randomUUID()}`;
    const parent = f.accounts.alice;
    const secret = randomBytes(32).toString('base64url');
    let mode = 'valid';
    let requests = 0;
    const daemon = http.createServer((req, res) => {
      requests += 1;
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v0/vouch');
      assert.equal(req.headers['x-agent-binding'], secret);
      assert.equal(req.headers.authorization, undefined);
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        assert.deepEqual(JSON.parse(body), { aud: 'agent-comms' });
        if (mode === 'refused') {
          res.writeHead(403);
          res.end('{}');
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const payload = { v: 1, aud: 'agent-comms', account: credential.account, agentId: child,
          parent, iat: now, exp: now + 300, nonce: randomUUID() };
        if (mode === 'expired') Object.assign(payload, { iat: now - 400, exp: now - 100 });
        let segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const signature = sign(null, Buffer.from(segment), privateKey).toString('base64url');
        if (mode === 'tampered') segment = Buffer.from(JSON.stringify({ ...payload, nonce: 'tampered' })).toString('base64url');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ token: `v1.${segment}.${signature}`, agentId: child, parent, exp: payload.exp }));
      });
    });
    daemon.listen(0, '127.0.0.1');
    await once(daemon, 'listening');
    try {
      const cwd = path.join(f.root, 'worktree');
      execFileSync('git', ['init', '-q', cwd]);
      const bindings = path.join(cwd, '.git', 'agent-bindings');
      mkdirSync(bindings);
      const binding = { v: 1, agentId: child, parent, account: credential.account,
        daemon: `http://127.0.0.1:${daemon.address().port}`, secret };
      const bindingFile = path.join(bindings, `${child}.json`);
      writeFileSync(bindingFile, JSON.stringify(binding), { mode: 0o600 });
      writeFileSync(path.join(cwd, '.git', 'agent-binding.json'), JSON.stringify({ ...binding, agentId: parent, parent: null }), { mode: 0o600 });
      const bin = path.join(f.root, 'bin');
      mkdirSync(bin);
      symlinkSync(BIN, path.join(bin, 'agent-comms'));
      const env = { ...f.env, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
        AGENT_BOT_BINDING: bindingFile, AGENT_BOT_ID: child, AGENT_BOT_PARENT_ID: parent,
        QWTS_AGENT_ID: child, QWTS_AGENT_PARENT_ID: parent };
      const execute = (file, args, overrides = {}, directory = cwd) => new Promise((resolve) => {
        execFile(file, args, { cwd: directory, env: { ...env, ...overrides } }, (error, stdout, stderr) => {
          let json;
          try { json = JSON.parse(stdout); } catch { /* non-JSON failure output */ }
          resolve({ exit: error?.code ?? 0, stdout, stderr, json });
        });
      });
      const cli = (args, overrides, directory) => execute(process.execPath, [BIN, ...args], overrides, directory);
      await run({ ...f, credential, child, parent, secret, bindingFile, cwd, cli,
        join: (overrides) => execute('agent-comms', ['join', '--name', 'child', '--harness', 'test'], overrides),
        setMode: (value) => { mode = value; }, requests: () => requests });
    } finally {
      await new Promise((resolve) => daemon.close(resolve));
    }
  });
}

function success(result) {
  assert.equal(result.exit, 0, result.stderr);
  return result.json;
}
function refused(result, code) {
  assert.equal(result.exit, 1, result.stderr);
  assert.equal(result.json.error.code, code);
}

test('agent-bot spawn join uses the child binding with verified provenance and preserves its mailbox', () => fixture(async (f) => {
  assert.equal(statSync(f.bindingFile).mode & 0o777, 0o600);
  const first = await f.join();
  const joined = success(first);
  assert.equal(joined.verification, 'verified');
  assert.equal(joined.address, `${f.credential.account}/${f.child}`);
  assert.equal(first.stderr, '');
  assert.equal(f.requests(), 1);
  assert.equal(f.broker.state.souls.get(f.child).parent, f.parent);
  assert.equal(f.broker.state.souls.get(f.child).verification, 'verified');
  assert.equal(f.broker.state.souls.get(f.parent).name, 'alice');
  const sent = await call(f.paths, f.credential, { op: 'send', agentId: f.parent, to: f.child, body: 'hello', key: 'hello' });
  success(await f.cli(['inbox', 'ack', sent.messageId]));
  const pending = await call(f.paths, f.credential, { op: 'send', agentId: f.parent, to: f.child, body: 'pending', key: 'pending' });
  success(await f.join());
  assert.deepEqual(f.broker.state.mailboxes.get(f.child), [sent.messageId, pending.messageId]);
  const unread = success(await f.cli(['inbox', 'read']));
  assert.deepEqual(unread.messages.map((message) => message.id), [pending.messageId]);
  assert.equal(unread.messages[0].body, 'pending');
  assert.equal(f.broker.state.acked.get(f.child).has(sent.messageId), true);
  const who = success(await f.cli(['whoami']));
  assert.equal(who.soul, f.child);
  assert.equal(who.source, 'binding');
  assert.equal(who.verification, 'verified');
  const peers = await call(f.paths, f.credential, { op: 'peers', agentId: f.parent });
  assert.equal(peers.peers.find((s) => s.agentId === f.child).verification, 'verified');
  const principalSecret = randomBytes(32).toString('hex');
  const principal = await call(f.paths, f.credential, { op: 'principal-pair-request', secretHash: sha256(principalSecret) });
  await admin(f.paths, { op: 'principal-approve', code: principal.code });
  const census = await callPrincipal(f.paths, { principal: principal.principal, secret: principalSecret, brokerUid: process.getuid() }, { op: 'census' });
  const row = census.souls.find((s) => s.agentId === f.child);
  assert.equal(row.verification, 'verified');
  assert.equal(row.parent, f.parent);
  assert.equal(row.name, 'child');
  assert.equal(row.harness, 'test');
  assert.equal(row.unacked, 1);
  assert.equal(census.souls.filter((s) => s.agentId === f.child).length, 1);
  success(await f.cli(['send', f.parent, '--body', 'from child']));
  const inbox = await call(f.paths, f.credential, { op: 'read', agentId: f.parent });
  assert.equal(inbox.messages[0].from.verification, 'verified');
  success(await f.cli(['leave']));
  success(await f.join());
  assert.equal(f.broker.state.souls.get(f.child).joined, true);
}));

test('hardened account refuses every tokenless soul operation but accepts the spawned binding', () => fixture(async (f) => {
  success(await f.join());
  success(await f.cli(['account', 'harden', f.credential.account]));
  for (const args of [['join'], ['whoami'], ['peers'], ['send', f.parent, '--body', 'impostor'],
    ['inbox', 'read'], ['inbox', 'ack', 'missing'], ['inbox', 'watch'], ['leave']]) {
    // Outside the git worktree: only the claimed ID and account credential remain.
    refused(await f.cli(args, { AGENT_BOT_BINDING: '', QWTS_AGENT_PARENT_ID: '' }, f.root), 'unverified');
  }
  success(await f.join());
  assert.equal(success(await f.cli(['whoami'])).verification, 'verified');
  success(await f.cli(['account', 'harden', f.credential.account, '--off']));
  assert.equal(success(await f.cli(['whoami'], { AGENT_BOT_BINDING: '' }, f.root)).verification, 'claimed');
}));

for (const mode of ['tampered', 'expired']) {
  test(`spawn join refuses a ${mode} soul token without joining or downgrading`, () => fixture(async (f) => {
    f.setMode(mode);
    const before = readFileSync(f.broker.log.file, 'utf8');
    refused(await f.join(), 'soul-token-invalid');
    assert.equal(f.broker.state.souls.has(f.child), false);
    assert.equal(readFileSync(f.broker.log.file, 'utf8'), before);
    success(await f.cli(['account', 'harden', f.credential.account]));
    refused(await f.join(), 'soul-token-invalid');
  }));
}

test('spawn join refuses inherited parent binding and identity mismatches', () => fixture(async (f) => {
  refused(await f.join({ AGENT_BOT_BINDING: path.join(f.cwd, '.git', 'agent-binding.json') }), 'soul-mismatch');
  refused(await f.join({ QWTS_AGENT_ID: f.parent }), 'soul-mismatch');
  refused(await f.join({ AGENT_BOT_BINDING: path.join(f.cwd, 'missing') }), 'binding-untrusted');
  assert.equal(f.requests(), 0);
  assert.equal(f.broker.state.souls.has(f.child), false);
  f.setMode('refused');
  const result = await f.join();
  refused(result, 'daemon-unreachable');
  assert.ok(!`${result.stdout}${result.stderr}`.includes(f.secret));
  assert.equal(f.broker.state.souls.has(f.child), false);
}));
