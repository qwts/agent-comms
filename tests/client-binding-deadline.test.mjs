import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { bindingPost } from '../lib/client.mjs';

async function fixture(t, respond) {
  const server = http.createServer((req, res) => {
    assert.equal(JSON.stringify(req.headers).includes('private-binding-secret'), false);
    respond(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { binding: { daemon: `http://127.0.0.1:${server.address().port}`, secret: 'private-binding-secret' } };
}

test('Windows bound requests allow native custody work beyond the ordinary local deadline', { timeout: 10000 }, async t => {
  const context = await fixture(t, (req, res) => {
    const timer = setTimeout(() => res.end('{"ok":true}'), 3150);
    res.on('close', () => clearTimeout(timer));
  });
  const result = await bindingPost(context, '/v0/vouch', { aud: 'agent-comms' }, { platform: 'win32' });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { ok: true });
});

test('an explicit bound-request deadline stays absolute while a daemon dribbles a body', async t => {
  const context = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const timer = setInterval(() => res.write(' '), 5);
    res.on('close', () => clearInterval(timer));
  });
  const started = Date.now();
  await assert.rejects(bindingPost(context, '/v0/vouch', {}, { platform: 'win32', timeoutMs: 40 }), { code: 'daemon-unreachable' });
  assert.ok(Date.now() - started < 1000, 'partial replies must not extend the deadline');
});
