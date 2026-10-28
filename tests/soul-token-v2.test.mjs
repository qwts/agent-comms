import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Broker, sha256 } from '../lib/broker.mjs';
import { admin, call, loadCredential } from '../lib/client.mjs';
import { withBroker } from './helpers/broker.mjs';

const now = Math.floor(Date.now() / 1000);
const ISSUER = 'https://agent-bot.test';
const LOOPBACK = 'http://127.0.0.1:8080';
const DEVICE = 'dev_1';

const ed25519Keys = () => generateKeyPairSync('ed25519');
const service = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rotated = generateKeyPairSync('ec', { namedCurve: 'P-256' });

function jwkOf(publicKey, kid) {
  return { ...publicKey.export({ format: 'jwk' }), alg: 'ES256', use: 'sig', kid };
}

// An injectable fetch serving soul-keys.json per issuer. The `sets` object is
// shared with the test, which mutates it to serve rotation and outages.
function jwksFetch(sets) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    const issuer = Object.keys(sets).find((i) => url === `${i}/.well-known/agent-bot/soul-keys.json`);
    if (!issuer || sets[issuer] === null) {
      return { ok: false, status: 503, text: async () => '', headers: { get: () => null } };
    }
    const body = JSON.stringify({ issuer, keys: sets[issuer] });
    return { ok: true, status: 200, text: async () => body, headers: { get: (h) => (h === 'cache-control' ? 'max-age=60' : null) } };
  };
  fetch.calls = calls;
  return fetch;
}

function v2Token(privateKey, kid, claims) {
  const h = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'soul+jwt', kid })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = Buffer.from(`${h}.${p}`, 'ascii');
  const sig = sign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${h}.${p}.${sig}`;
}

const claims = (account, agentId, extra = {}) => ({
  v: 2, iss: ISSUER, aud: 'agent-comms', sub: agentId, account, parent: null, device: DEVICE,
  task_id: 'soul-vouch', operation_id: 'op_1', issuance_id: 'iss_1',
  iat: now, nbf: now, exp: now + 300, jti: 'j1', ...extra,
});

// A v1 token as vouch.mjs mints it today (host Ed25519 key).
function v1Token(key, account, agentId) {
  const data = Buffer.from(JSON.stringify({ v: 1, aud: 'agent-comms', account, agentId, iat: now, exp: now + 300 }));
  const payloadSegment = data.toString('base64url');
  return `v1.${payloadSegment}.${sign(null, Buffer.from(payloadSegment, 'ascii'), key.privateKey).toString('base64url')}`;
}

async function fixture(run, { issuers = [ISSUER, LOOPBACK], sets, brokerEnv, daemonKind = 'v2', clockBox } = {}) {
  const jwks = sets ?? { [ISSUER]: [jwkOf(service.publicKey, 'sk1')] };
  const fetchImpl = jwksFetch(jwks);
  const clock = clockBox ?? { t: now };
  return withBroker(async (ctx) => {
    const credential = loadCredential({ dir: path.join(ctx.root, 'client'), credential: path.join(ctx.root, 'client/credential.json') });
    const account = credential.account;
    const req = (body) => call(ctx.paths, credential, body);
    const wire = (body) => admin({ admin: ctx.paths.socket }, body);
    async function pair(extra = {}) {
      const secret = randomUUID();
      const proof = `${randomUUID()}.proof`;
      writeFileSync(path.join(ctx.paths.proofs, proof), sha256(secret));
      const fields = daemonKind === 'v2'
        ? { soulTokens: { v: 2, issuer: ISSUER, device: DEVICE } }
        : { publicKey: ed25519Keys().publicKey.export({ type: 'spki', format: 'pem' }) };
      const result = await wire({ op: 'daemon-pair-request', account, secretHash: sha256(secret), proof, ...fields, ...extra });
      return { ...result, secret };
    }
    const pending = await pair();
    const approve = (code = pending.code) => admin(ctx.paths, { op: 'approve', code });
    const v2 = (agentId, extra = {}, key = service, kid = 'sk1') => v2Token(key.privateKey, kid, claims(account, agentId, extra));
    // The approve-triggered warm is fire-and-forget; tests await it directly.
    const warm = () => ctx.broker.soulKeys.refresh(ISSUER);
    return run({ ...ctx, credential, account, req, wire, pair, pending, approve, v2, fetchImpl, jwks, warm, clock });
  }, {
    brokerOptions: {
      now: () => clock.t * 1000,
      daemonOperation: (request, socket, { account }) => ({ account, op: request.op }),
      soulTokenIssuers: issuers, fetchImpl,
      ...(brokerEnv ? { env: brokerEnv } : {}),
    },
  });
}

test('v2 pairing: soulTokens validates, journals the descriptor, and a valid v2 token verifies', () => fixture(async (f) => {
  const { pair, approve, req, accounts, broker, account, v2, fetchImpl, warm } = f;
  // Exactly one of publicKey / soulTokens; issuer must be listed; device must match.
  await assert.rejects(pair({ publicKey: ed25519Keys().publicKey.export({ type: 'spki', format: 'pem' }) }), { code: 'bad-request' });
  await assert.rejects(pair({ soulTokens: { v: 1, issuer: ISSUER, device: DEVICE } }), { code: 'bad-request' });
  await assert.rejects(pair({ soulTokens: { v: 2, issuer: 'https://unlisted.example', device: DEVICE } }), { code: 'bad-request' });
  await assert.rejects(pair({ soulTokens: { v: 2, issuer: 'http://127.0.0.1:9999', device: DEVICE } }), { code: 'bad-request' });
  await assert.rejects(pair({ soulTokens: { v: 2, issuer: 'https://user:pw@agent-bot.test', device: DEVICE } }), { code: 'bad-request' });
  await assert.rejects(pair({ soulTokens: { v: 2, issuer: 'https://agent-bot.test/path', device: DEVICE } }), { code: 'bad-request' });
  await assert.rejects(pair({ soulTokens: { v: 2, issuer: 'http://plain.example', device: DEVICE } }), { code: 'bad-request' });
  await assert.rejects(pair({ soulTokens: { v: 2, issuer: ISSUER, device: 'dev?bad' } }), { code: 'bad-request' });
  await approve();
  // An explicitly listed loopback issuer pairs as a pending replacement.
  assert.equal((await pair({ soulTokens: { v: 2, issuer: `${LOOPBACK}/`, device: DEVICE } })).state, 'pending');
  await warm();
  assert.equal((await req({ op: 'join', agentId: accounts.alice, soulToken: v2(accounts.alice) })).verification, 'verified');
  // The descriptor, not a publicKey, is journaled.
  const row = broker.state.daemons.get(account);
  assert.deepEqual(row.soulTokens, { v: 2, issuer: ISSUER, device: DEVICE });
  assert.equal(row.publicKey, undefined);
  assert.equal(fetchImpl.calls[0], `${ISSUER}/.well-known/agent-bot/soul-keys.json`);
}));

const refusals = {
  'wrong device': { device: 'dev_other' }, 'wrong issuer': { iss: 'https://other.test' },
  'wrong soul': { sub: `agent_${randomUUID()}` }, 'wrong account': { account: 'other' },
  'wrong audience': { aud: 'other' }, 'wrong version': { v: 1 },
  expired: { iat: now - 400, nbf: now - 400, exp: now - 31 },
  'exp equal to now': { iat: now, nbf: now, exp: now },
  'iat in future': { iat: now + 31, nbf: now, exp: now + 300 },
  'nbf in future': { iat: now, nbf: now + 31, exp: now + 300 },
  'lifetime > 300': { iat: now, nbf: now, exp: now + 301 },
  'missing nbf': { nbf: undefined }, 'string exp': { exp: String(now + 300) },
};
for (const [name, patch] of Object.entries(refusals)) {
  test(`v2 soul token refuses ${name}`, () => fixture(async ({ approve, req, accounts, v2, warm }) => {
    await approve();
    await warm();
    await assert.rejects(
      req({ op: 'join', agentId: accounts.alice, soulToken: v2(accounts.alice, patch) }),
      { code: 'soul-token-invalid' });
  }));
}

test('v2 token: cold cache, malformed token, bad signature, and unknown kid until refresh', () => fixture(async ({ approve, req, accounts, account, v2, broker, jwks, warm }) => {
  // The JWKS is unavailable: approval's fire-and-forget warm fails, so the
  // cache is cold when the first token arrives.
  jwks[ISSUER] = null;
  await approve();
  const good = v2(accounts.alice);
  await assert.rejects(req({ op: 'join', agentId: accounts.alice, soulToken: good }), { code: 'soul-token-invalid' });
  jwks[ISSUER] = [jwkOf(service.publicKey, 'sk1')];
  await warm();
  for (const bad of [null, '', 'x', 'a.b', 'a.b.c.d', 'v2.e30.AA',
    v2Token(rotated.privateKey, 'sk1', claims(account, accounts.alice)) /* wrong signer */,
    `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}` /* corrupted signature */]) {
    await assert.rejects(req({ op: 'join', agentId: accounts.alice, soulToken: bad }), { code: 'soul-token-invalid' }, `bad value ...${JSON.stringify(String(bad)).slice(-50)}`);
  }
  assert.equal((await req({ op: 'join', agentId: accounts.alice, soulToken: good })).verification, 'verified');
  // A key the JWKS does not publish yet refuses; it verifies once served.
  const unknownKid = v2(accounts.bob, {}, service, 'sk_new');
  await assert.rejects(req({ op: 'join', agentId: accounts.bob, soulToken: unknownKid }), { code: 'soul-token-invalid' });
  jwks[ISSUER] = [jwkOf(service.publicKey, 'sk_new'), jwkOf(service.publicKey, 'sk1')];
  await warm();
  assert.equal((await req({ op: 'join', agentId: accounts.bob, soulToken: unknownKid })).verification, 'verified');
  // The previous key stays in the set during rotation, so old tokens still verify.
  assert.equal((await req({ op: 'join', agentId: accounts.alice, soulToken: good })).verification, 'verified');
}));

test('v2 on a v1 pairing and v1 on a v2 pairing are invalid; AGENT_COMMS_SOUL_TOKEN_V1=0 refuses v1', async () => {
  // A service-signed v2 token means nothing to a host-key (v1) pairing.
  await fixture(async ({ approve, req, accounts, account }) => {
    await approve();
    const forged = v2Token(service.privateKey, 'sk1', claims(account, accounts.alice));
    await assert.rejects(req({ op: 'join', agentId: accounts.alice, soulToken: forged }), { code: 'soul-token-invalid' });
  }, { daemonKind: 'v1' });
  // And a host v1 token means nothing to a v2 pairing.
  await fixture(async ({ approve, req, accounts, account, warm }) => {
    await approve();
    await warm();
    const v1 = v1Token(ed25519Keys(), account, accounts.alice);
    await assert.rejects(req({ op: 'join', agentId: accounts.alice, soulToken: v1 }), { code: 'soul-token-invalid' });
  });
  // The env gate retires v1 verification outright.
  await fixture(async ({ approve, req, accounts, account }) => {
    await approve();
    const v1 = v1Token(ed25519Keys(), account, accounts.alice);
    await assert.rejects(req({ op: 'join', agentId: accounts.alice, soulToken: v1 }), { code: 'soul-token-invalid' });
  }, { daemonKind: 'v1', brokerEnv: { ...process.env, AGENT_COMMS_SOUL_TOKEN_V1: '0' } });
});

test('a just-expired v2 token refuses while exp = now + 1 verifies', () => fixture(async ({ approve, req, accounts, v2, warm }) => {
  await approve();
  await warm();
  await assert.rejects(
    req({ op: 'join', agentId: accounts.alice, soulToken: v2(accounts.alice, { iat: now - 1, nbf: now - 1, exp: now }) }),
    { code: 'soul-token-invalid' }, 'exp equal to now is expired');
  assert.equal(
    (await req({ op: 'join', agentId: accounts.bob, soulToken: v2(accounts.bob, { iat: now - 1, nbf: now - 1, exp: now + 1 }) })).verification,
    'verified');
}));

test('a stale key set older than 15 minutes stops verifying while the service is unreachable', () => fixture(async ({ approve, req, accounts, v2, broker, jwks, warm, clock }) => {
  await approve();
  await warm();
  const good = v2(accounts.alice);
  assert.equal((await req({ op: 'join', agentId: accounts.alice, soulToken: good })).verification, 'verified');
  // The service goes down; within the staleness window the cache still verifies.
  jwks[ISSUER] = null;
  clock.t += 60;
  assert.equal((await req({ op: 'join', agentId: accounts.bob, soulToken: v2(accounts.bob) })).verification, 'verified');
  // Past 15 minutes without a successful refresh the set is dead.
  clock.t += 15 * 60;
  const fresh = v2(accounts.bob, { iat: clock.t - 10, nbf: clock.t - 10, exp: clock.t + 290 });
  await assert.rejects(req({ op: 'join', agentId: accounts.bob, soulToken: fresh }), { code: 'soul-token-invalid' });
  // The service recovers and the cache refreshes: verification returns.
  jwks[ISSUER] = [jwkOf(service.publicKey, 'sk1')];
  await warm();
  assert.equal((await req({ op: 'join', agentId: accounts.bob, soulToken: fresh })).verification, 'verified');
}));

test('the JWKS body cap is enforced on content-length and on a streaming body', async () => {
  const { createSoulKeyStore } = await import('../lib/broker/soul-keys.mjs');
  const oversized = 'x'.repeat(64 * 1024 + 1);
  async function* stream(text) { yield Buffer.from(text.slice(0, 30_000)); yield Buffer.from(text.slice(30_000)); }
  const declared = createSoulKeyStore({
    fetchImpl: async () => ({ ok: true, headers: { get: (h) => (h === 'content-length' ? String(oversized.length) : null) }, body: stream('{"issuer":"x"}') }),
  });
  await assert.rejects(declared.refresh(ISSUER), /exceeds/);
  const undeclared = createSoulKeyStore({
    fetchImpl: async () => ({ ok: true, headers: { get: () => null }, body: stream(oversized) }),
  });
  await assert.rejects(undeclared.refresh(ISSUER), /exceeds/);
  assert.equal(undeclared.hasKeys(ISSUER), false);
});

test('v2 pairing survives journal replay; a failed refresh keeps the last good keys', () => fixture(async ({ approve, req, accounts, account, broker, paths, v2, fetchImpl, jwks, warm }) => {
  await approve();
  await warm();
  const good = v2(accounts.alice);
  assert.equal((await req({ op: 'join', agentId: accounts.alice, soulToken: good })).verification, 'verified');
  // The service goes down: refresh fails, the cached set still verifies.
  jwks[ISSUER] = null;
  await assert.rejects(broker.soulKeys.refresh(ISSUER));
  assert.equal((await req({ op: 'join', agentId: accounts.bob, soulToken: v2(accounts.bob) })).verification, 'verified');
  jwks[ISSUER] = [jwkOf(service.publicKey, 'sk1')];
  // Replay: the descriptor persists across a restart and v2 keeps verifying.
  await broker.stop();
  const replay = await new Broker({ paths, now: () => now * 1000, soulTokenIssuers: [ISSUER], fetchImpl }).start();
  try {
    assert.deepEqual(replay.state.daemons.get(account).soulTokens, { v: 2, issuer: ISSUER, device: DEVICE });
    await replay.soulKeys.refresh(ISSUER);
    assert.equal((await req({ op: 'join', agentId: accounts.alice, soulToken: good })).verification, 'verified');
  } finally {
    await replay.stop();
  }
}));
