import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { resolveBinding, soulContext, vouch } from '../lib/client.mjs';
import { CommsError } from '../lib/errors.mjs';

const makeBinding = (daemon) => ({ v: 1, agentId: 'agent_binding_test', parent: 'agent_parent_test', account: 'test', daemon, secret: 'binding-secret' });
function folder(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-comms-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function save(file, value, mode = 0o600) {
  writeFileSync(file, JSON.stringify(value), { mode });
  chmodSync(file, mode);
}
function signedToken(agentId, parent, privateKey) {
  const payload = Buffer.from(JSON.stringify({ v: 1, aud: 'agent-comms', agentId, parent, exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
  return `v1.${payload}.${sign(null, Buffer.from(payload), privateKey).toString('base64url')}`;
}

test('binding resolution accepts the explicit file and rejects untrusted permissions and soul mismatch', (t) => {
  const root = folder(t);
  const file = path.join(root, 'binding.json');
  const binding = makeBinding('http://127.0.0.1:1');
  save(file, binding);
  assert.deepEqual(resolveBinding({ AGENT_BOT_BINDING: file }, root), binding);
  execFileSync('git', ['init', '-q', root]);
  const gitBinding = makeBinding(binding.daemon);
  save(path.join(root, '.git', 'agent-binding.json'), gitBinding);
  assert.deepEqual(resolveBinding({}, root), gitBinding);
  assert.deepEqual(soulContext({ AGENT_BOT_BINDING: file }, root), {
    agentId: binding.agentId, parent: binding.parent, source: 'binding', binding,
  });
  assert.throws(() => soulContext({ AGENT_BOT_BINDING: file, QWTS_AGENT_ID: 'agent_other' }, root), { code: 'soul-mismatch' });
  chmodSync(file, 0o644);
  assert.throws(() => resolveBinding({ AGENT_BOT_BINDING: file }, root), { code: 'binding-untrusted' });
});

test('vouch sends the binding secret and audience, signs a token, and reuses one token per process', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v0/vouch');
    assert.equal(req.headers['x-agent-binding'], 'binding-secret');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      assert.deepEqual(JSON.parse(body), { aud: 'agent-comms' });
      const token = signedToken('agent_binding_test', 'agent_parent_test', privateKey);
      const [, payload, signature] = token.split('.');
      assert.equal(verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64url')), true);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token, agentId: 'agent_binding_test', parent: 'agent_parent_test', exp: JSON.parse(Buffer.from(payload, 'base64url')).exp }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const context = { ...soulContext({ AGENT_BOT_BINDING: saveContext(t, makeBinding(`http://127.0.0.1:${address.port}`)) }), binding: makeBinding(`http://127.0.0.1:${address.port}`) };
  const first = await vouch(context);
  assert.match(first, /^v1\./);
  assert.deepEqual(await vouch(context), first);
  assert.equal(requests, 1);
});

function saveContext(t, binding) {
  const root = folder(t);
  const file = path.join(root, 'binding.json');
  save(file, binding);
  return file;
}

test('vouch fails closed when the daemon refuses the request and names its start command', async () => {
  const context = { agentId: 'agent_binding_test', binding: makeBinding('http://127.0.0.1:1') };
  await assert.rejects(vouch(context), (error) => error instanceof CommsError
    && error.code === 'daemon-unreachable' && /agent-bot daemon start/.test(error.message));
});

test('a binding whose daemon is not loopback HTTP is untrusted, so its secret never leaves the machine', (t) => {
  const root = folder(t);
  const file = path.join(root, 'binding.json');
  for (const daemon of ['http://example.com:80', 'https://127.0.0.1:1', 'http://10.0.0.1:1', 'http://localhost.evil:1']) {
    save(file, makeBinding(daemon));
    assert.throws(() => resolveBinding({ AGENT_BOT_BINDING: file }, root), { code: 'binding-untrusted' }, daemon);
  }
  save(file, makeBinding('http://[::1]:1'));
  assert.equal(resolveBinding({ AGENT_BOT_BINDING: file }, root).daemon, 'http://[::1]:1');
});
