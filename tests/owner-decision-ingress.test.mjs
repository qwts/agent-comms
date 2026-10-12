import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Broker, sha256 } from '../lib/broker.mjs';
import { admin, loadCredential } from '../lib/client.mjs';
import { withBroker } from './helpers/broker.mjs';
import { createOwnerDecisionAdmissionLimiter } from '../lib/broker/owner-admission.mjs';
import { createProductionOwnerDecisionCoordinator } from '../lib/broker/owner-decisions.mjs';
import { ownerDecisionReadiness } from '../lib/platform/owner-decision-readiness.mjs';
import { createOwnerDecisionIngress } from '../lib/broker/owner-ingress.mjs';
import { lineReader } from '../lib/wire.mjs';

const reject = (promise, code) => assert.rejects(promise, { code });
const unix = { skip: process.platform === 'win32' };
const raw = (t, socketPath, bytes) => new Promise((resolve, reject) => {
  const socket = net.createConnection(socketPath); let body = '';
  const timer = setTimeout(() => { socket.destroy(); reject(new Error('owner-test-timeout')); }, 5000);
  t.after(() => socket.destroy());
  socket.on('connect', () => socket.end(bytes));
  socket.setEncoding('utf8');
  socket.on('data', chunk => { body += chunk; if (body.length > 4096) socket.destroy(new Error('owner-test-response-bound')); });
  socket.on('error', reject);
  socket.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
});
async function fixture(t, run, options = {}) {
  return withBroker(async ctx => {
    const credential = loadCredential({ dir: path.join(ctx.root, 'client'), credential: path.join(ctx.root, 'client/credential.json') });
    const wire = body => admin({ admin: ctx.paths.socket }, body);
    const principal = async () => {
      const secret = randomUUID();
      const pending = await wire({ op: 'principal-pair-request', auth: credential, secretHash: sha256(secret) });
      await admin(ctx.paths, { op: 'principal-approve', code: pending.code });
      return { principal: pending.principal, secret };
    };
    const auth = await principal(), daemonSecret = randomUUID();
    const proof = `${randomUUID()}.proof`, secretHash = sha256(daemonSecret);
    writeFileSync(path.join(ctx.paths.proofs, proof), secretHash, { mode: 0o644 });
    const pending = await wire({ op: 'daemon-pair-request', account: credential.account, proof, secretHash,
      publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) });
    await admin(ctx.paths, { op: 'approve', code: pending.code });
    const daemon = { daemon: credential.account, secret: daemonSecret };
    const socket = net.createConnection(ctx.paths.socket), events = []; let buffer = '';
    t.after(() => socket.destroy());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('owner-watch-timeout')); }, 5000);
      socket.on('error', reject);
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const event = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); events.push(event);
          if (event.event === 'ready') { clearTimeout(timer); resolve(); }
        }
      });
      socket.on('connect', () => socket.write(`${JSON.stringify({ v: 1, op: 'account-watch', auth: daemon })}\n`));
    });
    const initial = readdirSync(ctx.paths.state).sort(), eventCount = events.length;
    const prepare = extra => ({ v: 1, op: 'owner-decision-prepare', auth, requestId: randomUUID(),
      account: credential.account, soul: ctx.accounts.alice, operation: 'cold-wake.set', parameters: { mode: 'off' }, ...extra });
    await run({ ...ctx, wire, auth, principal, daemon, credential, events, prepare });
    assert.deepEqual(readdirSync(ctx.paths.state).sort(), initial, 'no owner journal/reservations created');
    assert.equal(events.length, eventCount, 'no owner event dispatched');
  }, options);
}

test('actual owner ingress authenticates exact credential kind then refuses unavailable readiness without IDs or events', unix, t => fixture(t, async f => {
  for (const request of [f.prepare(), { v: 1, op: 'owner-decision-status', auth: f.auth, requestId: randomUUID() },
    { v: 1, op: 'owner-decision-cancel', auth: f.auth, requestId: randomUUID() },
    { v: 1, op: 'owner-decision', auth: f.auth, requestId: randomUUID(), payloadDigest: '0'.repeat(64), presence: 'p1.synthetic' },
    { v: 1, op: 'owner-decision-prepared', auth: f.daemon, requestId: randomUUID(), payloadDigest: '0'.repeat(64),
      daemonKey: '1'.repeat(64), daemonEpoch: 1, watchId: randomUUID(), nonce: '2'.repeat(43), preparedAt: 0, exp: 1, stage: null },
    { v: 1, op: 'owner-decision-check', auth: f.daemon, requestId: randomUUID(), payloadDigest: '0'.repeat(64),
      daemonKey: '1'.repeat(64), daemonEpoch: 1, watchId: randomUUID(), receiptDigest: '2'.repeat(64) },
    { v: 1, op: 'owner-decision-result', auth: f.daemon, requestId: randomUUID(), payloadDigest: '0'.repeat(64),
      daemonKey: '1'.repeat(64), daemonEpoch: 1, watchId: randomUUID(), receiptDigest: null,
      state: 'refused', outcome: { code: 'validation-refused', effectDigest: null }, reconciliation: null }]) {
    await reject(f.wire(request), 'owner-decision-unsupported');
    await reject(f.wire({ ...request, auth: Object.hasOwn(request.auth, 'daemon') ? f.auth : f.daemon }), 'unauthenticated');
  }
  for (const auth of [f.daemon, f.credential, { ...f.auth, account: f.credential.account },
    { principal: f.auth.principal }, { ...f.auth, secret: 'wrong' }]) await reject(f.wire(f.prepare({ auth })), 'unauthenticated');
  await reject(f.wire({ op: 'owner-decision-check', auth: f.auth }), 'unauthenticated');
  await reject(f.wire(f.prepare({ metadata: { frameBytes: 1 } })), 'bad-request');
  assert.equal((await f.wire({ op: 'health', auth: f.auth })).ok, true);
  const ordinary = JSON.stringify({ v: 1, op: 'health', auth: f.auth });
  assert.equal((await raw(t, f.paths.socket, `${ordinary}${' '.repeat(40000)}\n`)).ok, true);
  assert.equal(ownerDecisionReadiness(f.broker).supported, false);
  assert.throws(() => createProductionOwnerDecisionCoordinator({ broker: f.broker, syntheticFixture: true }), { code: 'owner-decision-unsupported' });
  // Already-decoded stream compatibility must not attest owner framing, even
  // if its text reconstructs a small valid owner request.
  const decoded = new EventEmitter(), ingress = createOwnerDecisionIngress({ broker: f.broker });
  lineReader(decoded, (request, metadata) => {
    assert.throws(() => ingress.handle(request, metadata), { code: 'bad-request' });
  }, assert.fail);
  decoded.emit('data', `${JSON.stringify({ v: 1, op: 'owner-decision-status', auth: f.auth, requestId: randomUUID() })}\n`);
  ingress.close();
}));

test('actual owner raw bound includes whitespace CR LF escape expansion and original invalid UTF8 bytes', unix, t => fixture(t, async f => {
  const json = JSON.stringify({ v: 1, op: 'owner-decision-status', auth: f.auth, requestId: randomUUID() });
  for (const end of ['\n', '\r\n']) {
    const exact = `${json}${' '.repeat(32768 - Buffer.byteLength(json + end))}${end}`;
    assert.equal(Buffer.byteLength(exact), 32768);
    assert.equal((await raw(t, f.paths.socket, exact)).error.code, 'owner-decision-unsupported');
    assert.equal((await raw(t, f.paths.socket, ` ${exact}`)).error.code, 'bad-request');
  }
  const escaped = json.replace('owner-decision-status', [...'owner-decision-status'].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
  const oversized = `${escaped}${' '.repeat(32769 - Buffer.byteLength(escaped) - 1)}\n`;
  assert.equal((await raw(t, f.paths.socket, oversized)).error.code, 'bad-request');
  // Re-decoding the byte FF into U+FFFD grows its UTF8 representation by two.
  // The actual original-frame boundary still wins before semantic rejection.
  const invalid = Buffer.concat([Buffer.from(json.slice(0, -1) + ',"x":"'), Buffer.from([255]), Buffer.from('"}')]);
  const atLimit = Buffer.concat([invalid, Buffer.alloc(32768 - invalid.length - 1, 32), Buffer.from('\n')]);
  assert.equal((await raw(t, f.paths.socket, atLimit)).error.code, 'bad-request');
  const badAuth = Buffer.from(atLimit.toString('latin1').replace(f.auth.secret, 'wrong'), 'latin1');
  assert.equal((await raw(t, f.paths.socket, badAuth)).error.code, 'bad-request', 'invalid raw UTF8 refuses before credential lookup');
  assert.equal((await f.wire({ op: 'health', auth: f.auth })).ok, true);
}));

test('actual preparation limits refuse before readiness and leave status/cancel available without unbounded invalid account buckets', unix, t => fixture(t, async f => {
  for (let i = 0; i < 100; i++) await reject(f.wire(f.prepare({ account: `bad/${i}` })), 'bad-request');
  for (let i = 0; i < 6; i++) await reject(f.wire(f.prepare()), 'owner-decision-unsupported');
  await reject(f.wire(f.prepare()), 'rate-limited');
  for (const op of ['owner-decision-status', 'owner-decision-cancel']) await reject(f.wire({ op, auth: f.auth, requestId: randomUUID() }), 'owner-decision-unsupported');
  const other = await f.principal();
  await reject(f.wire(f.prepare({ auth: other })), 'owner-decision-unsupported');
}));

test('ephemeral admission charges principal/pair atomically and uses monotonic rolling boundaries', () => {
  let elapsed = 0;
  const limiter = createOwnerDecisionAdmissionLimiter({ elapsed: () => elapsed });
  for (let i = 0; i < 6; i++) limiter.admit('principal', 'a');
  assert.throws(() => limiter.admit('principal', 'a'), { code: 'rate-limited' });
  for (let i = 0; i < 6; i++) limiter.admit('principal', 'b');
  assert.throws(() => limiter.admit('principal', 'c'), { code: 'rate-limited' });
  elapsed = 59999; assert.throws(() => limiter.admit('principal', 'a'), { code: 'rate-limited' });
  elapsed = 60000; limiter.admit('principal', 'a');
  elapsed = 59999; assert.throws(() => limiter.admit('principal', 'b'), { code: 'rate-limited' });
  limiter.close(); elapsed = 60001; limiter.admit('principal', 'b');
});

test('one finite bucket budget includes both kinds and capacity refusal consumes neither charge', () => {
  let elapsed = 0;
  const limiter = createOwnerDecisionAdmissionLimiter({ elapsed: () => elapsed });
  for (let i = 0; i < 2048; i++) limiter.admit(`principal${i}`, 'a');
  for (let i = 0; i < 20; i++) assert.throws(() => limiter.admit('principal0', 'b'), { code: 'rate-limited' });
  for (let i = 0; i < 5; i++) limiter.admit('principal0', 'a');
  assert.throws(() => limiter.admit('new-principal', 'a'), { code: 'rate-limited' });
  elapsed = 60000; limiter.admit('new-principal', 'a');
});
