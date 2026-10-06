// Delivered asides (qwts/agent-comms#100): a session that reads its own mail
// tells the agent-bot daemon which ids it printed, so the daemon records them
// as `in` asides. The daemon here is a fake HTTP server that mints soul tokens
// the broker verifies and records the reports; nothing leaves the machine and
// no real binding file is ever read.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { reportDelivered, shouldReportDelivered } from '../lib/asides-report.mjs';
import { PROOF_HEADER, bindingKey, checkBindingProof, parseBindingProof } from '../lib/binding-proof.mjs';
import { admin } from '../lib/client.mjs';
import { sha256 } from '../lib/broker.mjs';
import { withBroker } from './helpers/broker.mjs';

const BIN = fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url));
// The broker checks token windows against its own clock, so the fake daemon
// mints them for the same instant the fixture broker runs at.
const now = Math.floor(Date.now() / 1000);

function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env }, (error, stdout, stderr) => {
      let json;
      try { json = JSON.parse(stdout); } catch { json = stdout; }
      resolve({ exit: error?.code ?? 0, json, stdout, stderr });
    });
  });
}

function soulToken(privateKey, account, agentId) {
  const data = Buffer.from(JSON.stringify({ v: 1, aud: 'agent-comms', account, agentId, iat: now, exp: now + 300, nonce: randomUUID() }));
  const segment = data.toString('base64url');
  return `v1.${segment}.${sign(null, Buffer.from(segment, 'ascii'), privateKey).toString('base64url')}`;
}

// The daemon a bound CLI expects: /v0/vouch for the token the broker verifies,
// /v0/asides/delivered for the report. Both arrive with a binding proof, and
// neither ever sees the secret.
//   status: the status the delivered route answers with (404 is an old daemon)
//   hang:   accept the report and never answer it
//   cut:    destroy the socket, as a daemon that died mid-report would
function fakeDaemon(t, { account, agentId, secret, privateKey, status = 200, hang = false, cut = false }) {
  const vouches = [];
  const reports = [];
  const server = http.createServer((req, res) => {
    const proof = parseBindingProof(req.headers[PROOF_HEADER]);
    const authentic = Boolean(proof) && checkBindingProof(proof, bindingKey(secret),
      { method: 'POST', path: req.url, authority: `127.0.0.1:${server.address().port}` });
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/v0/vouch') {
        vouches.push({ authentic, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ token: soulToken(privateKey, account, agentId), agentId, parent: null, exp: now + 300 }));
        return;
      }
      if (req.url === '/v0/asides/delivered') {
        reports.push({ authentic, body: JSON.parse(body || '{}') });
        if (hang) return;
        if (cut) { req.socket.destroy(); return; }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, recorded: reports.length }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown route' }));
    });
  });
  server.listen(0, '127.0.0.1');
  const listening = once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { vouches, reports, port: listening.then(() => server.address().port) };
}

function saveBinding(t, binding) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-asides-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'agent-binding.json');
  writeFileSync(file, JSON.stringify(binding));
  chmodSync(file, 0o600);
  return file;
}

// One broker, one account, two joined souls, a fake daemon paired to that
// account (so the tokens it mints verify), and a binding file for alice.
async function fixture(t, run, daemonOptions = {}) {
  await withBroker(async (ctx) => {
    const account = JSON.parse(readFileSync(path.join(ctx.root, 'client', 'credential.json'), 'utf8')).account;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const secret = randomUUID();
    const proof = `${randomUUID()}.proof`;
    writeFileSync(path.join(ctx.paths.proofs, proof), sha256(secret));
    const pending = await admin({ admin: ctx.paths.socket }, {
      op: 'daemon-pair-request', account, secretHash: sha256(secret), proof,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    });
    const approved = await ctx.cli(['account', 'approve', pending.code]);
    assert.equal(approved.exit, 0, JSON.stringify(approved.json));

    const daemon = fakeDaemon(t, { account, agentId: ctx.accounts.alice, secret, privateKey, ...daemonOptions });
    const port = await daemon.port;
    const bindingFile = saveBinding(t, { v: 1, agentId: ctx.accounts.alice, parent: null, account,
      daemon: `http://127.0.0.1:${port}`, secret });
    const alice = { ...ctx.env, QWTS_AGENT_ID: ctx.accounts.alice, AGENT_BOT_BINDING: bindingFile };
    const soul = ctx.accounts.alice;
    const asAlice = (args, extraEnv = {}) => runCli(args, { ...alice, ...extraEnv });
    const asBob = (args) => runCli(args, { ...ctx.env, QWTS_AGENT_ID: ctx.accounts.bob });
    const unbound = (args) => runCli(args, { ...ctx.env, QWTS_AGENT_ID: soul });
    await run({ ctx, daemon, asAlice, asBob, unbound, soul });
  }, { brokerOptions: { now: () => now * 1000 } });
}

const ids = (messages) => messages.map((message) => message.id);

test('inbox read reports exactly the ids it printed, and only when a session reads them', async (t) => {
  await fixture(t, async ({ ctx, daemon, asAlice, asBob }) => {
    const sent = [];
    for (const body of ['first', 'second', 'third']) {
      const one = await asBob(['send', ctx.accounts.alice, '--body', body, '--key', `k-${body}`]);
      assert.equal(one.exit, 0, JSON.stringify(one.json));
      sent.push(one.json.messageId);
    }
    // --json output a script consumes is not in a soul's context, so it reports
    // nothing; the same page read for a session does.
    const scripted = await asAlice(['inbox', 'read', '--json']);
    assert.equal(scripted.exit, 0, scripted.stderr);
    assert.deepEqual(ids(scripted.json.messages), sent);
    assert.deepEqual(daemon.reports, []);

    const page = await asAlice(['inbox', 'read', '--limit', '2']);
    assert.equal(page.exit, 0, page.stderr);
    assert.deepEqual(ids(page.json.messages), sent.slice(0, 2));
    assert.equal(daemon.reports.length, 1);
    const report = daemon.reports[0];
    assert.equal(report.authentic, true, 'the report carried a binding proof the daemon accepts');
    assert.deepEqual(report.body, { messageIds: sent.slice(0, 2), via: 'inbox-read' });
    // The third message is still in the mailbox and was never handed over.
    assert.ok(!report.body.messageIds.includes(sent[2]));

    // Nothing that does not put a message in front of a session reports.
    const acked = await asAlice(['inbox', 'ack', ...sent.slice(0, 2)]);
    assert.equal(acked.exit, 0, acked.stderr);
    const counted = await asAlice(['inbox', 'count']);
    assert.equal(counted.exit, 2);
    assert.equal(daemon.reports.length, 1);
    assert.equal(daemon.vouches.length, 3); // the read, the ack, and the refused command
  });
});

test('a hook that injects the waiting inbox reports it as hook-inject, with the harness session', async (t) => {
  await fixture(t, async ({ ctx, daemon, asAlice, asBob }) => {
    const sent = [];
    for (const body of ['one', 'two', 'three', 'four']) {
      sent.push((await asBob(['send', ctx.accounts.alice, '--body', body, '--key', `hook-${body}`])).json.messageId);
    }
    const injected = await asAlice(['inbox', 'hook'], { AGENT_HOOK_SESSION_ID: 'sess_hook_test' });
    assert.equal(injected.exit, 0, injected.stderr);
    assert.equal(injected.json.soul, ctx.accounts.alice);
    assert.equal(injected.json.harnessSessionId, 'sess_hook_test');
    assert.deepEqual(ids(injected.json.messages), sent);
    assert.equal(injected.json.remaining, 0);
    assert.equal(daemon.reports.length, 1);
    assert.deepEqual(daemon.reports[0].body, { messageIds: sent, via: 'hook-inject', harnessSessionId: 'sess_hook_test' });

    // A hook injects for a session whatever the output is piped to, so it
    // reports even the page it paginated to build.
    daemon.reports.length = 0;
    const paged = await asAlice(['inbox', 'hook', '--session-id', 'sess_named', '--limit', '2']);
    assert.equal(paged.exit, 0, paged.stderr);
    assert.deepEqual(ids(paged.json.messages), sent.slice(0, 2));
    assert.equal(paged.json.remaining, 2);
    assert.deepEqual(daemon.reports[0].body, { messageIds: sent.slice(0, 2), via: 'hook-inject', harnessSessionId: 'sess_named' });
  });
});

for (const [label, daemonOptions] of [
  ['a socket that dies mid-report', { cut: true }],
  ['503', { status: 503 }],
  ['404, as an older daemon does', { status: 404 }],
  ['nothing at all', { hang: true }],
]) {
  test(`inbox read still prints and exits 0 when the daemon gives ${label}`, async (t) => {
    await fixture(t, async ({ asAlice, asBob, daemon, soul }) => {
      for (const body of ['alpha', 'beta']) {
        assert.equal((await asBob(['send', soul, '--body', body, '--key', `down-${body}`])).exit, 0);
      }
      const read = await asAlice(['inbox', 'read'], { AGENT_COMMS_DEBUG: '1' });
      assert.equal(read.exit, 0, read.stderr);
      // The read's own document, unchanged by a report that did not land.
      assert.deepEqual(Object.keys(read.json).sort(), ['cursor', 'messages', 'ok', 'remaining']);
      assert.equal(read.json.ok, true);
      assert.equal(read.json.messages.length, 2, read.stderr);
      // Nothing about the failed report reaches the session's own output; the
      // one line about it is on stderr and only with AGENT_COMMS_DEBUG set.
      assert.match(read.stderr, /aside/);
      assert.match(read.stderr, /daemon/);
      assert.equal(daemon.reports.length, 1);
    }, daemonOptions);
  });
}

test('a daemon that is down before the vouch still fails the read it always failed', async (t) => {
  await fixture(t, async ({ ctx, asAlice, asBob }) => {
    assert.equal((await asBob(['send', ctx.accounts.alice, '--body', 'mail', '--key', 'down-mail'])).exit, 0);
    const read = await asAlice(['inbox', 'read'], { AGENT_BOT_BINDING: saveBinding(t, { v: 1, agentId: ctx.accounts.alice,
      parent: null, account: 'nobody', daemon: 'http://127.0.0.1:1', secret: 'unused' }) });
    assert.equal(read.exit, 1);
    assert.equal(read.json.error.code, 'daemon-unreachable');
  });
});

test('an unbound session reports nothing, and its read prints as before', async (t) => {
  await fixture(t, async ({ ctx, daemon, unbound, asBob }) => {
    assert.equal((await asBob(['send', ctx.accounts.alice, '--body', 'unbound', '--key', 'unbound-mail'])).exit, 0);
    const read = await unbound(['inbox', 'read'], { AGENT_COMMS_DEBUG: '1' });
    assert.equal(read.exit, 0, read.stderr);
    assert.equal(read.json.messages.length, 1);
    // Not even a vouch: without a binding there is nothing to authenticate with.
    assert.deepEqual(daemon.reports, []);
    assert.deepEqual(daemon.vouches, []);
    assert.equal(read.stderr, '');
    const injected = await unbound(['inbox', 'hook']);
    assert.equal(injected.exit, 0, injected.stderr);
    assert.deepEqual(daemon.reports, []);
  });
});

test('what counts as delivered: a terminal behind --json, a session behind the hook', () => {
  assert.deepEqual([
    shouldReportDelivered({ via: 'inbox-read' }),
    shouldReportDelivered({ via: 'inbox-read', json: true }),
    shouldReportDelivered({ via: 'inbox-read', json: true, tty: true }),
    shouldReportDelivered({ via: 'hook-inject' }),
    shouldReportDelivered({ via: 'inbox-read', env: { AGENT_COMMS_NO_DELIVERY_REPORT: '1' } }),
    shouldReportDelivered({ via: 'hook-inject', env: { AGENT_COMMS_NO_DELIVERY_REPORT: '1' } }),
    shouldReportDelivered({ via: 'hook-inject', json: true }),
    shouldReportDelivered({ via: 'post_reply' }),
    shouldReportDelivered(),
  ], [true, false, true, true, false, false, true, false, false]);
});

test('reportDelivered sends nothing it cannot report, and names each delivered id once', async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const context = { agentId: 'agent_asides_test', parent: null, binding: {
    daemon: `http://127.0.0.1:${server.address().port}`, secret: 'aside-secret' } };

  assert.equal(await reportDelivered(context, { messageIds: [], via: 'inbox-read' }), null);
  assert.equal(await reportDelivered(context, { messageIds: [null, undefined], via: 'inbox-read' }), null);
  assert.equal(await reportDelivered({ agentId: 'agent_asides_test', parent: null }, { messageIds: ['m1'], via: 'inbox-read' }), null);
  assert.deepEqual(await reportDelivered(context, { messageIds: ['m1'], via: 'post_reply' }), { ok: false, reason: 'unknown aside via post_reply' });
  assert.deepEqual(requests, []);

  // Repeated reads of one message are one delivery, and it names every id once.
  const outcome = await reportDelivered(context, { messageIds: ['m1', 'm1', 'm2'], via: 'hook-inject' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reported, 2);
  assert.deepEqual(requests, ['/v0/asides/delivered']);

  // A daemon that is not listening is an outcome, not a failure.
  const closed = await reportDelivered({ ...context, binding: { ...context.binding, daemon: 'http://127.0.0.1:1' } },
    { messageIds: ['m3'], via: 'inbox-read' });
  assert.equal(closed.ok, false);
  assert.match(closed.reason, /daemon/);
});