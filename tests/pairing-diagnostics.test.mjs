import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { admin, call, loadCredential } from '../lib/client.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { sha256 } from '../lib/broker.mjs';
import { withBroker } from './helpers/broker.mjs';

const relevant = events => events.filter(([event]) => event.startsWith('pair-') || event === 'soul-joined');
test('actual pairing pending/approval/join boundaries exclude refusals and identifiers',
  { skip: process.platform === 'win32', timeout: 15000 }, async () => {
    const events = [];
    await withBroker(async ({ paths, env, accounts, broker }) => {
      const credential = loadCredential(clientPaths(env));
      assert.deepEqual(relevant(events).map(([event]) => event), [
        'pair-account-pending', 'pair-account-approved', 'soul-joined', 'soul-joined']);
      const count = relevant(events).length;
      await assert.rejects(call(paths, credential, { op: 'join', agentId: 'CANARY-invalid-soul' }), { code: 'unbound' });
      await assert.rejects(admin(paths, { op: 'approve', code: 'CANARY-invalid-code' }), { code: 'unknown-code' });
      assert.equal(relevant(events).length, count);
      await call(paths, credential, { op: 'join', agentId: accounts.alice });
      assert.equal(relevant(events).at(-1)[0], 'soul-joined');
      const principal = await call(paths, credential, { op: 'principal-pair-request', name: 'CANARY-private-name', secretHash: sha256('CANARY-secret') });
      assert.equal(relevant(events).at(-1)[0], 'pair-principal-pending');
      await assert.rejects(admin(paths, { op: 'principal-approve', code: principal.code, grant: [42] }), { code: 'bad-request' });
      assert.equal(relevant(events).at(-1)[0], 'pair-principal-pending');
      await admin(paths, { op: 'principal-approve-exact', code: principal.code, expectedPrincipal: principal.principal, grant: [accounts.alice] });
      assert.equal(relevant(events).at(-1)[0], 'pair-principal-approved');
      const secret = randomBytes(32).toString('hex');
      const proof = `${randomBytes(16).toString('hex')}.proof`;
      writeFileSync(path.join(paths.proofs, proof), sha256(secret), { mode: 0o644 });
      const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' });
      const daemon = await call(paths, credential, { op: 'daemon-pair-request', account: credential.account,
        secretHash: sha256(secret), proof, publicKey });
      assert.equal(relevant(events).at(-1)[0], 'pair-daemon-pending');
      await admin(paths, { op: 'approve', code: daemon.code });
      assert.equal(relevant(events).at(-1)[0], 'pair-daemon-approved');
      assert.equal(broker.state.daemons.get(credential.account).state, 'approved');
      const completed = relevant(events).length;
      await assert.rejects(admin(paths, { op: 'approve', code: daemon.code }), { code: 'unknown-code' });
      await assert.rejects(admin(paths, { op: 'principal-approve', code: principal.code }), { code: 'unknown-code' });
      assert.equal(relevant(events).length, completed);
      await broker.stop();
      await broker.start();
      assert.equal(broker.state.daemons.get(credential.account).state, 'approved');
      assert.equal(broker.state.principals.get(principal.principal).state, 'approved');
      assert.equal(relevant(events).length, completed, 'recovery must not replay pairing observations');
      for (const [event, duration, extra] of relevant(events)) {
        assert.equal(typeof event, 'string'); assert.ok(Number.isSafeInteger(duration) && duration >= 0);
        assert.equal(extra, undefined);
      }
      assert.ok(!JSON.stringify(events).includes('CANARY'));
      assert.ok(!JSON.stringify(events).includes(accounts.alice));
    }, { brokerOptions: { mode: 'single-account', diagnostic: (...args) => events.push(args) } });
  });

test('throwing diagnostic callback cannot change successful pairing and membership',
  { skip: process.platform === 'win32', timeout: 15000 }, async () => {
    await withBroker(async ({ broker, accounts }) => {
      assert.equal(broker.state.souls.get(accounts.alice).joined, true);
      assert.equal(broker.state.souls.get(accounts.bob).joined, true);
    }, { brokerOptions: { mode: 'single-account', diagnostic: () => { throw new Error('CANARY-diagnostic-failure'); } } });
  });
