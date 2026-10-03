import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { Broker, LIMITS, sha256 } from '../lib/broker.mjs';
import { admin, call, callPrincipal, loadCredential, loadPrincipalCredential, pairPrincipal } from '../lib/client.mjs';
import { readHostConfig } from '../lib/host-config.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { createPrincipalClient } from '../lib/principal-client.mjs';
import { lineReader } from '../lib/wire.mjs';
import { pairAccount, withBroker } from './helpers/broker.mjs';

function rpc(paths, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.socket);
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ v: 1, ...request })}\n`));
    lineReader(socket, (reply) => {
      socket.end();
      if (reply.ok) resolve(reply);
      else reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
    }, reject);
  });
}

async function setup(c, grant = null, approve = true) {
  const env = { ...c.env, AGENT_COMMS_NO_KEYCHAIN: '1' };
  const pending = await pairPrincipal(c.paths, clientPaths(env), 'Launch test', env);
  if (approve) await admin(c.paths, { op: 'principal-approve', code: pending.code, grant });
  const credential = loadPrincipalCredential(clientPaths(env), readHostConfig(env));
  return { client: createPrincipalClient({ env }), credential, pending,
    account: loadCredential(clientPaths(env)) };
}

async function daemon(c, account = c.owner) {
  const secret = randomUUID();
  const proof = `${randomUUID()}.proof`;
  writeFileSync(path.join(c.paths.proofs, proof), sha256(secret), { mode: 0o644 });
  const { publicKey } = generateKeyPairSync('ed25519');
  const pending = await rpc(c.paths, { op: 'daemon-pair-request', account, proof,
    secretHash: sha256(secret), publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
  await admin(c.paths, { op: 'approve', code: pending.code });
  const auth = { daemon: account, secret };
  const socket = net.createConnection(c.paths.socket);
  const events = [];
  const waiters = [];
  const next = () => events.length ? Promise.resolve(events.shift()) : new Promise((resolve) => waiters.push(resolve));
  lineReader(socket, (event) => waiters.length ? waiters.shift()(event) : events.push(event), (error) => { throw error; });
  socket.on('connect', () => socket.write(`${JSON.stringify({ v: 1, op: 'account-watch', auth })}\n`));
  assert.deepEqual(await next(), { event: 'ready' });
  return { socket, next, events, auth, report: (fields) => rpc(c.paths, { op: 'launch-result', auth, ...fields }) };
}
const options = { brokerOptions: { mode: 'single-account' } };
const target = (c) => ({ account: c.owner, soul: c.accounts.bob, harness: 'test', name: 'Bob' });

test('principal launches existing and packaged souls through one fake daemon; results and audit survive restart', async () => {
  await withBroker(async (c) => {
    const { client, account } = await setup(c);
    const d = await daemon(c);
    await call(c.paths, account, { op: 'leave', agentId: c.accounts.bob });
    const sent = await client.launch({ ...target(c), op: 'join', auth: {}, sender: 'forged' });
    assert.equal(sent.status, 'pending');
    assert.deepEqual(await d.next(), { event: 'launch', requestId: sent.requestId, principal: client.principal, ...target(c) });
    assert.equal((await client.launchStatus(sent.requestId)).status, 'pending');
    await assert.rejects(d.report({ requestId: sent.requestId, status: 'launched', agentId: c.accounts.bob }), { code: 'not-joined' });
    await call(c.paths, account, { op: 'join', agentId: c.accounts.bob });
    const result = { requestId: sent.requestId, status: 'launched', agentId: c.accounts.bob };
    assert.equal((await d.report(result)).duplicate, false);
    assert.equal((await d.report(result)).duplicate, true);
    await assert.rejects(d.report({ ...result, status: 'failed' }), { code: 'conflict' });
    assert.deepEqual(await client.launchStatus(sent.requestId), { ok: true, ...result });
    const pkg = { account: c.owner, package: '/daemon-local/soul package', harness: 'test' };
    const packaged = await client.launch(pkg);
    assert.deepEqual(await d.next(), { event: 'launch', requestId: packaged.requestId, principal: client.principal, ...pkg });
    const newId = `agent_${randomUUID()}`;
    await call(c.paths, account, { op: 'join', agentId: newId });
    await d.report({ requestId: packaged.requestId, status: 'launched', agentId: newId });
    const failed = await client.launch(pkg);
    await d.next();
    await d.report({ requestId: failed.requestId, status: 'failed' });
    const pending = await client.launch(pkg);
    await d.next();
    const audit = readFileSync(c.broker.log.file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit.filter((r) => r.t === 'launch-request').length, 4);
    assert.equal(audit.filter((r) => r.t === 'launch-result').length, 3);
    assert.equal(audit.find((r) => r.t === 'launch-request').principal, client.principal);
    assert.ok(!JSON.stringify(audit).includes(d.auth.secret));
    await c.broker.stop();
    const restarted = await new Broker({ paths: c.paths, mode: 'single-account' }).start();
    try {
      assert.deepEqual(await client.launchStatus(sent.requestId), { ok: true, ...result });
      assert.equal((await client.launchStatus(packaged.requestId)).agentId, newId);
      assert.equal((await client.launchStatus(failed.requestId)).status, 'failed');
      assert.equal((await client.launchStatus(pending.requestId)).status, 'pending');
      await assert.rejects(client.launch(pkg), { code: 'daemon-unavailable' });
    } finally { await restarted.stop(); }
  }, options);
});

test('a failed launch carries the daemon detail, normalized, through status and restart', async () => {
  await withBroker(async (c) => {
    const { client, account } = await setup(c);
    const d = await daemon(c);
    const pkg = { account: c.owner, package: '/daemon-local/soul package', harness: 'test' };
    const failed = await client.launch(pkg);
    await d.next();
    const raw = `soul has no GitHub identity\n\tsee agent-bot doctor ${'x'.repeat(600)}`;
    await d.report({ requestId: failed.requestId, status: 'failed', detail: raw });
    const detail = (await client.launchStatus(failed.requestId)).detail;
    assert.equal(detail.length, 512);
    assert.ok(detail.startsWith('soul has no GitHub identity see agent-bot doctor x'));
    assert.equal((await d.report({ requestId: failed.requestId, status: 'failed', detail: raw })).duplicate, true);
    await assert.rejects(d.report({ requestId: failed.requestId, status: 'failed', detail: 'other' }), { code: 'conflict' });
    await assert.rejects(d.report({ requestId: failed.requestId, status: 'failed' }), { code: 'conflict' });
    const bare = await client.launch(pkg);
    await d.next();
    await assert.rejects(d.report({ requestId: bare.requestId, status: 'failed', detail: 7 }), { code: 'bad-request' });
    await d.report({ requestId: bare.requestId, status: 'failed', detail: ' \n ' });
    assert.equal('detail' in (await client.launchStatus(bare.requestId)), false);
    const launched = await client.launch(pkg);
    await d.next();
    const newId = `agent_${randomUUID()}`;
    await call(c.paths, account, { op: 'join', agentId: newId });
    await d.report({ requestId: launched.requestId, status: 'launched', agentId: newId, detail: 'ignored on success' });
    assert.deepEqual(await client.launchStatus(launched.requestId),
      { ok: true, requestId: launched.requestId, status: 'launched', agentId: newId });
    await c.broker.stop();
    const restarted = await new Broker({ paths: c.paths, mode: 'single-account' }).start();
    try {
      assert.equal((await client.launchStatus(failed.requestId)).detail, detail);
      assert.equal((await client.launchStatus(launched.requestId)).status, 'launched');
    } finally { await restarted.stop(); }
  }, options);
});

test('launch checks principal credentials, approval, grants, receive rules and status ownership', async () => {
  await withBroker(async (c) => {
    const { client, credential, pending, account } = await setup(c, null, false);
    const launch = target(c);
    await assert.rejects(client.launch(launch), { code: 'not-approved' });
    await admin(c.paths, { op: 'principal-approve', code: pending.code, grant: [c.accounts.bob] });
    await assert.rejects(client.launch(launch), { code: 'daemon-unavailable' });
    const d = await daemon(c);
    for (const auth of [{}, { ...credential, secret: 'wrong' }, account, d.auth]) {
      await assert.rejects(rpc(c.paths, { op: 'launch', ...launch, auth }), { code: 'unauthenticated' });
    }
    for (const fields of [{ sender: 'forged' }, { agentId: c.accounts.alice }]) {
      await assert.rejects(callPrincipal(c.paths, credential, { op: 'launch', ...launch, ...fields }), { code: 'unauthenticated' });
    }
    await assert.rejects(client.launch({ ...launch, soul: c.accounts.alice }), { code: 'unknown-recipient' });
    await assert.rejects(client.launch({ account: c.owner, package: '/soul', harness: 'test' }), { code: 'unknown-recipient' });
    await assert.rejects(client.launch({ ...launch, account: 'other' }), { code: 'unknown-recipient' });
    await call(c.paths, account, { op: 'join', agentId: c.accounts.bob, allow: [] });
    await assert.rejects(client.launch(launch), { code: 'unknown-recipient' });
    await call(c.paths, account, { op: 'join', agentId: c.accounts.bob, allow: [client.principal] });
    const sent = await client.launch(launch);
    await d.next();
    const other = await setup(c);
    await assert.rejects(other.client.launchStatus(sent.requestId), { code: 'unknown-launch' });
    await assert.rejects(client.launchStatus('missing'), { code: 'unknown-launch' });
    await admin(c.paths, { op: 'principal-revoke', principal: client.principal });
    await assert.rejects(client.launch(launch), { code: 'unauthenticated' });
    await assert.rejects(client.launchStatus(sent.requestId), { code: 'unauthenticated' });
    await admin(c.paths, { op: 'revoke', account: c.owner });
    await assert.rejects(other.client.launch(launch), { code: 'unknown-recipient' });
    await assert.rejects(d.report({ requestId: sent.requestId, status: 'failed' }), { code: 'unauthenticated' });
  }, options);
});

test('launch validates all fields and daemon results; a disconnected daemon is unavailable', async () => {
  await withBroker(async (c) => {
    const { client, credential, account } = await setup(c, [c.owner]);
    const d = await daemon(c);
    const valid = target(c);
    for (const change of [{ account: '' }, { account: 3 }, { soul: undefined }, { soul: 'bad' },
      { package: '/also' }, { soul: undefined, package: '' }, { soul: undefined, package: 'a\0b' },
      { soul: undefined, package: 'x'.repeat(4097) }, { harness: '' }, { harness: 1 },
      { harness: 'x'.repeat(65) }, { name: '' }, { name: 'x'.repeat(129) }]) {
      await assert.rejects(client.launch({ ...valid, ...change }), { code: 'bad-request' });
    }
    assert.equal(c.broker.state.launches.size, 0);
    const sent = await client.launch(valid);
    await d.next();
    await assert.rejects(d.report({ requestId: sent.requestId, status: 'failed', agentId: `agent_${randomUUID()}` }), { code: 'bad-request' });
    for (const change of [{ status: 'other' }, { status: 'launched' },
      { status: 'launched', agentId: 'bad' }, { status: 'launched', agentId: c.accounts.alice }]) {
      await assert.rejects(d.report({ requestId: sent.requestId, ...change }), { code: 'bad-request' });
    }
    await assert.rejects(d.report({ requestId: 'missing', status: 'failed' }), { code: 'unknown-launch' });
    for (const auth of [account, { principal: credential.principal, secret: credential.secret }]) {
      await assert.rejects(rpc(c.paths, { op: 'launch-result', auth, requestId: sent.requestId, status: 'failed' }), { code: 'unauthenticated' });
    }
    await admin(c.paths, { op: 'revoke', account: c.owner, kind: 'daemon' });
    await assert.rejects(client.launch(valid), { code: 'daemon-unavailable' });
  }, options);
});

test('launch rate limit bounds principal requests', async () => {
  await withBroker(async (c) => {
    const { client } = await setup(c);
    const d = await daemon(c);
    await client.launch(target(c));
    await d.next();
    await assert.rejects(client.launch(target(c)), { code: 'rate-limited' });
  }, { brokerOptions: { mode: 'single-account', limits: { ...LIMITS, sendsPerAccountPerMinute: 1 } } });
});

test('only the target daemon receives a launch and may report it; address grants are honored', async () => {
  await withBroker(async (c) => {
    const { code } = await pairAccount(c.paths, 'other', process.getuid());
    await admin(c.paths, { op: 'approve', code });
    const { client } = await setup(c, [`${c.owner}/${c.accounts.bob}`]);
    const own = await daemon(c);
    const other = await daemon(c, 'other');
    // A second watch under the same daemon key must not duplicate a command.
    const extra = net.createConnection(c.paths.socket);
    const events = [];
    const ready = new Promise((resolve) => lineReader(extra, (event) => {
      events.push(event);
      if (event.event === 'ready') resolve();
    }, (error) => { throw error; }));
    extra.on('connect', () => extra.write(`${JSON.stringify({ v: 1, op: 'account-watch', auth: own.auth })}\n`));
    await ready;
    const sent = await client.launch(target(c));
    await own.next();
    await assert.rejects(other.report({ requestId: sent.requestId, status: 'failed' }), { code: 'unknown-launch' });
    await own.report({ requestId: sent.requestId, status: 'failed' });
    assert.deepEqual(events, [{ event: 'ready' }]);
    assert.deepEqual(other.events, []);
    // Read-only verification of the implementation's process boundary.
    for (const file of ['../lib/principal-client.mjs', '../lib/broker/launch.mjs']) {
      assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /child_process|\bspawn\s*\(|\bexecFile\s*\(/);
    }
    extra.destroy();
  }, { brokerOptions: { uidOf: () => process.getuid() } });
});
