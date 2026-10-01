import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { writeFileSync, readFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Broker, sha256 } from '../lib/broker.mjs';
import { admin, call, callPrincipal, loadCredential, stream } from '../lib/client.mjs';
import { withBroker } from './helpers/broker.mjs';

const keys = () => generateKeyPairSync('ed25519');
const now = Math.floor(Date.now() / 1000);
function token(key, account, agentId, extra = {}) {
  const data = Buffer.from(JSON.stringify({ v: 1, aud: 'agent-comms', account, agentId,
    iat: now, exp: now + 300, nonce: randomUUID(), parent: null, ...extra }));
  const payloadSegment = data.toString('base64url');
  return `v1.${payloadSegment}.${sign(null, Buffer.from(payloadSegment, 'ascii'), key.privateKey).toString('base64url')}`;
}

async function fixture(run) {
  return withBroker(async (ctx) => {
    const credential = loadCredential({ dir: path.join(ctx.root, 'client'), credential: path.join(ctx.root, 'client/credential.json') });
    const account = credential.account;
    const req = (body) => call(ctx.paths, credential, body);
    // admin() is a socket transport without an injected account auth field.
    const wire = (body) => admin({ admin: ctx.paths.socket }, body);
    async function pair(key, extra = {}) {
      const secret = randomUUID();
      const secretHash = sha256(secret);
      const proof = `${randomUUID()}.proof`;
      writeFileSync(path.join(ctx.paths.proofs, proof), secretHash);
      const result = await wire({ op: 'daemon-pair-request', account, secretHash, proof,
        publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }), ...extra });
      return { ...result, secret };
    }
    const key = keys();
    const pending = await pair(key);
    const daemon = (op, secret = pending.secret) => wire({ op, auth: { daemon: account, secret } });
    const approve = (code = pending.code) => admin(ctx.paths, { op: 'approve', code });
    await run({ ...ctx, credential, account, req, wire, pair, key, pending, daemon, approve });
  }, { brokerOptions: { now: () => now * 1000,
    daemonOperation: (request, socket, { account }) => ({ account, op: request.op }) } });
}

test('daemon pairing, approval, credential isolation, rotation and revocation', () => fixture(async (f) => {
  const { account, key, pending, req, wire, daemon, approve, pair, paths, cli, accounts } = f;
  assert.equal(pending.state, 'pending');
  await assert.rejects(daemon('account-watch'), { code: 'unauthenticated' });
  assert.equal((await cli(['account', 'pairings'])).json.pairings.find((r) => r.kind === 'daemon').code, pending.code);
  assert.equal((await cli(['account', 'approve', pending.code])).json.kind, 'daemon');
  for (const op of ['account-watch', 'wake-report']) {
    assert.equal((await daemon(op)).account, account);
    await assert.rejects(req({ op }), { code: 'unauthenticated' });
    await assert.rejects(daemon(op, 'wrong'), { code: 'unauthenticated' });
  }
  for (const op of ['join', 'send', 'read', 'ack', 'watch', 'leave', 'peers', 'whoami', 'census', 'health',
    'pair-request', 'daemon-pair-request', 'pair-status', 'principal-pair-request', 'unknown']) {
    await assert.rejects(daemon(op), { code: 'unauthenticated' });
    await assert.rejects(wire({ op, auth: { daemon: account, ...f.credential } }), { code: 'unauthenticated' });
  }
  const replacement = keys();
  const next = await pair(replacement, { publicKey: replacement.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') });
  const join = (k) => req({ op: 'join', agentId: accounts.alice, soulToken: token(k, account, accounts.alice) });
  assert.equal((await join(key)).verification, 'verified');
  await assert.rejects(join(replacement), { code: 'soul-token-invalid' });
  await daemon('wake-report');
  await assert.rejects(daemon('wake-report', next.secret), { code: 'unauthenticated' });
  await approve(next.code);
  await assert.rejects(join(key), { code: 'soul-token-invalid' });
  assert.equal((await join(replacement)).verification, 'verified');
  await assert.rejects(daemon('wake-report'), { code: 'unauthenticated' });
  await daemon('wake-report', next.secret);
  assert.equal((await cli(['account', 'revoke', account, '--kind', 'daemon'])).json.state, 'revoked');
  await assert.rejects(join(replacement), { code: 'soul-token-invalid' });
  await assert.rejects(daemon('wake-report', next.secret), { code: 'unauthenticated' });
  assert.equal((await req({ op: 'join', agentId: accounts.alice })).verification, 'claimed');
  assert.ok(!readFileSync(path.join(paths.state, 'events.jsonl'), 'utf8').includes(pending.secret));
}));

test('daemon enrollment requires approved account, Ed25519 SPKI and kernel proof', () => fixture(async ({ pair, key, broker, account, paths }) => {
  await assert.rejects(pair(key, { account: 'missing' }), { code: 'not-approved' });
  const original = broker.state.pairings.get(account).state;
  broker.state.pairings.get(account).state = 'pending';
  await assert.rejects(pair(key), { code: 'not-approved' });
  broker.state.pairings.get(account).state = original;
  for (const publicKey of ['bad', null, generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'pem', type: 'spki' })]) {
    await assert.rejects(pair(key, { publicKey }), { code: 'bad-request' });
  }
  await assert.rejects(pair(key, { proof: '../outside.proof' }), { code: 'bad-request' });
  await assert.rejects(pair(key, { proof: 'missing.proof' }), { code: 'pairing-proof-invalid' });
  await assert.rejects(pair(key, { secretHash: 'bad' }), { code: 'bad-request' });
  const badProof = 'bad.proof';
  writeFileSync(path.join(paths.proofs, badProof), 'wrong hash');
  await assert.rejects(pair(key, { proof: badProof }), { code: 'pairing-proof-invalid' });
  const stale = 'stale.proof';
  writeFileSync(path.join(paths.proofs, stale), sha256('stale'));
  utimesSync(path.join(paths.proofs, stale), now - 301, now - 301);
  await assert.rejects(pair(key, { proof: stale, secretHash: sha256('stale') }), { code: 'pairing-proof-invalid' });
  broker.uidOf = () => process.getuid() + 1;
  await assert.rejects(pair(key), { code: 'pairing-proof-invalid' });
}));

const refusals = {
  'wrong account': { account: 'other' }, 'wrong soul': { agentId: `agent_${randomUUID()}` },
  expired: { iat: now - 332, exp: now - 31 }, 'wrong audience': { aud: 'other' },
  'wrong version': { v: 2 }, 'excess lifetime': { exp: now + 301 },
  'future issued': { iat: now + 31, exp: now + 100 }, 'negative lifetime': { exp: now - 1 },
  'missing expiry': { exp: undefined }, 'string expiry': { exp: String(now + 300) },
};
for (const [name, payload] of Object.entries(refusals)) {
  test(`soul token refuses ${name} without changing state`, () => fixture(async ({ approve, req, key, account, accounts, paths }) => {
    await approve();
    const before = readFileSync(path.join(paths.state, 'events.jsonl'), 'utf8');
    await assert.rejects(req({ op: 'join', agentId: accounts.alice, soulToken: token(key, account, accounts.alice, payload) }), { code: 'soul-token-invalid' });
    assert.equal(readFileSync(path.join(paths.state, 'events.jsonl'), 'utf8'), before);
  }));
}

test('bad signature, malformed token and missing approved key never downgrade', () => fixture(async ({ approve, req, key, account, accounts }) => {
  const request = (soulToken) => req({ op: 'join', agentId: accounts.alice, soulToken });
  await assert.rejects(request(token(key, account, accounts.alice)), { code: 'soul-token-invalid' });
  await approve();
  for (const value of [null, '', {}, 'v2.e30.AA', 'v1.%%.AA', 'v1.e30.AA.extra', token(keys(), account, accounts.alice)]) {
    await assert.rejects(request(value), { code: 'soul-token-invalid' });
  }
  assert.equal((await request(token(key, account, accounts.alice, { iat: now - 330, exp: now - 30 }))).verification, 'verified');
}));

test('soul token signature binds the exact payload segment', () => fixture(async ({ approve, req, key, account, accounts, paths }) => {
  await approve();
  const original = token(key, account, accounts.alice);
  const request = (soulToken) => req({ op: 'join', agentId: accounts.alice, soulToken });
  assert.equal((await request(original)).verification, 'verified');
  const [version, payloadSegment, signature] = original.split('.');
  const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  const reencoded = Buffer.from(JSON.stringify(payload, null, 2)).toString('base64url');
  assert.notEqual(reencoded, payloadSegment);
  assert.deepEqual(JSON.parse(Buffer.from(reencoded, 'base64url').toString('utf8')), payload);
  const before = readFileSync(path.join(paths.state, 'events.jsonl'), 'utf8');
  await assert.rejects(request(`${version}.${reencoded}.${signature}`), { code: 'soul-token-invalid' });
  const decodedSignature = sign(null, Buffer.from(payloadSegment, 'base64url'), key.privateKey).toString('base64url');
  await assert.rejects(request(`${version}.${payloadSegment}.${decodedSignature}`), { code: 'soul-token-invalid' });
  assert.equal(readFileSync(path.join(paths.state, 'events.jsonl'), 'utf8'), before);
}));

test('valid soul operations, observable verification, immutable message attribution and replay', () => fixture(async (f) => {
  const { approve, req, key, account, accounts, paths, broker, credential, cli } = f;
  await approve();
  const soulToken = token(key, account, accounts.alice);
  assert.equal((await req({ op: 'join', agentId: accounts.alice, soulToken })).verification, 'verified');
  assert.equal((await req({ op: 'peers', agentId: accounts.bob })).peers[0].verification, 'verified');
  assert.equal((await req({ op: 'whoami', agentId: accounts.alice, soulToken })).verification, 'verified');
  assert.equal((await cli(['whoami'])).json.verification, 'claimed');
  await req({ op: 'whoami', agentId: accounts.alice, soulToken });
  const principal = await req({ op: 'principal-pair-request', secretHash: sha256('principal-secret') });
  await admin(paths, { op: 'principal-approve', code: principal.code });
  const census = () => callPrincipal(paths, { principal: principal.principal, secret: 'principal-secret', brokerUid: process.getuid() }, { op: 'census' });
  assert.equal((await census()).souls.find((s) => s.agentId === accounts.alice).verification, 'verified');
  await req({ op: 'join', agentId: accounts.alice });
  await req({ op: 'send', agentId: accounts.alice, soulToken, to: accounts.bob, body: 'verified', key: 'one' });
  assert.equal((await census()).souls.find((s) => s.agentId === accounts.alice).verification, 'verified');
  await req({ op: 'send', agentId: accounts.alice, to: accounts.bob, body: 'claimed', key: 'two' });
  assert.equal((await census()).souls.find((s) => s.agentId === accounts.alice).verification, 'claimed');
  const messages = (await req({ op: 'read', agentId: accounts.bob })).messages;
  assert.deepEqual(messages.map((m) => m.from.verification), ['verified', 'claimed']);
  const bobToken = token(key, account, accounts.bob);
  assert.equal((await cli(['account', 'harden', account])).json.hardened, true);
  assert.equal((await census()).souls[0].hardened, true);
  assert.equal((await cli(['broker', 'status'])).json.pairings.accounts[0].hardened, true);
  for (const op of ['join', 'send', 'read', 'ack', 'watch', 'leave', 'whoami', 'peers']) {
    await assert.rejects(req({ op, agentId: accounts.alice }), { code: 'unverified' });
    await assert.rejects(req({ op, agentId: accounts.alice, soulToken: 'bad' }), { code: 'soul-token-invalid' });
  }
  const controller = new AbortController();
  await stream(paths, credential, { op: 'watch', agentId: accounts.bob, soulToken: bobToken }, (event) => {
    if (event.event === 'ready') controller.abort();
  }, { signal: controller.signal });
  await req({ op: 'ack', agentId: accounts.bob, soulToken: bobToken, ids: [messages[0].id] });
  await req({ op: 'leave', agentId: accounts.alice, soulToken });
  await broker.stop();
  const replay = await new Broker({ paths, now: () => now * 1000 }).start();
  try {
    assert.equal(replay.state.daemons.get(account).state, 'approved');
    assert.ok(replay.state.hardened.has(account));
    assert.equal(replay.state.souls.get(accounts.alice).verification, 'verified');
    assert.equal(replay.state.messages.get(messages[0].id).from.verification, 'verified');
    await assert.rejects(req({ op: 'read', agentId: accounts.bob }), { code: 'unverified' });
    assert.equal((await req({ op: 'read', agentId: accounts.bob, soulToken: bobToken })).messages[0].from.verification, 'claimed');
    assert.equal((await cli(['account', 'harden', account, '--off'])).json.hardened, false);
    await req({ op: 'read', agentId: accounts.bob });
    await admin(paths, { op: 'revoke', account });
    assert.equal(replay.state.daemons.has(account), false);
  } finally {
    await replay.stop();
  }
}));

test('pending key rotation and hardening toggles survive replay', () => fixture(async ({ approve, pair, paths, broker, account, key, req, accounts }) => {
  await approve();
  const replacement = keys();
  const pending = await pair(replacement);
  await admin(paths, { op: 'harden', account });
  await broker.stop();
  const replay = await new Broker({ paths, now: () => now * 1000 }).start();
  try {
    assert.ok(replay.state.hardened.has(account));
    const rows = (await admin(paths, { op: 'pairings' })).pairings.filter((r) => r.kind === 'daemon');
    assert.deepEqual(rows.map((r) => r.state), ['approved', 'pending']);
    assert.equal(rows[1].code, pending.code);
    assert.equal((await req({ op: 'join', agentId: accounts.alice, soulToken: token(key, account, accounts.alice) })).verification, 'verified');
    await assert.rejects(req({ op: 'join', agentId: accounts.alice, soulToken: token(replacement, account, accounts.alice) }), { code: 'soul-token-invalid' });
    await admin(paths, { op: 'approve', code: pending.code });
    await req({ op: 'send', agentId: accounts.alice, soulToken: token(replacement, account, accounts.alice), to: accounts.bob, body: 'rotated', key: 'rotated' });
    await admin(paths, { op: 'harden', account, off: true });
    await admin(paths, { op: 'revoke', account, kind: 'daemon' });
    const folded = replay.log.replay();
    assert.equal(folded.daemons.has(account), false);
    assert.equal(folded.hardened.has(account), false);
  } finally {
    await replay.stop();
  }
}));

test('hardening closes existing tokenless watches and admin mutations stay private', () => fixture(async ({ paths, req, account, broker, credential, accounts }) => {
  const controller = new AbortController();
  let ready;
  const armed = new Promise((resolve) => { ready = resolve; });
  const watching = stream(paths, credential, { op: 'watch', agentId: accounts.alice }, (event) => {
    if (event.event === 'ready') ready();
  }, { signal: controller.signal });
  const closed = assert.rejects(watching, { code: 'broker-unreachable' });
  await armed;
  await admin(paths, { op: 'harden', account });
  await closed;
  assert.equal(broker.watchers.size, 0);
  for (const op of ['harden', 'approve', 'revoke', 'pairings']) {
    await assert.rejects(req({ op, account }), { code: 'unknown-operation' });
  }
  await assert.rejects(admin(paths, { op: 'harden', account: 'missing' }), { code: 'unknown-account' });
  await assert.rejects(admin(paths, { op: 'harden', account, off: 'yes' }), { code: 'bad-request' });
}));
