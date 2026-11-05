import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { admin, call, loadCredential } from '../lib/client.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { Broker, sha256 } from '../lib/broker.mjs';
import { withBroker } from './helpers/broker.mjs';

async function daemonPair(paths, credential) {
  const secret = randomBytes(32).toString('hex');
  const proof = `${randomBytes(16).toString('hex')}.proof`;
  writeFileSync(path.join(paths.proofs, proof), sha256(secret), { mode: 0o644 });
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' });
  return call(paths, credential, { op: 'daemon-pair-request', account: credential.account, secretHash: sha256(secret), proof, publicKey });
}

test('a single-account broker approves its own account\'s daemon without an owner code (#280)',
  { skip: process.platform === 'win32', timeout: 15000 }, async () => {
    const events = [];
    await withBroker(async ({ paths, env, broker }) => {
      const credential = loadCredential(clientPaths(env));
      const first = await daemonPair(paths, credential);
      assert.deepEqual(first, { ok: true, account: credential.account, kind: 'daemon', state: 'approved', watchesClosed: 0, autoApproved: true });
      assert.equal(first.code, undefined);
      assert.equal(broker.state.daemons.get(credential.account).state, 'approved');
      assert.equal(broker.state.daemons.get(credential.account).epoch, 1);
      assert.deepEqual(events.filter(([e]) => e.startsWith('pair-daemon')).map(([e]) => e), ['pair-daemon-pending', 'pair-daemon-approved']);
      // A re-pair is idempotent: it replaces the key under a new epoch, still without a code.
      const again = await daemonPair(paths, credential);
      assert.equal(again.state, 'approved');
      assert.equal(broker.state.daemons.get(credential.account).epoch, 2);
      assert.equal((await admin(paths, { op: 'pairings' })).pairings.some(p => p.state === 'pending'), false);
    }, { brokerOptions: { mode: 'single-account', autoApproveOwnDaemon: true, diagnostic: (...args) => events.push(args) } });
  });

test('a group broker still holds a same-account daemon pairing for explicit owner approval (#280)',
  { skip: process.platform === 'win32', timeout: 15000 }, async () => {
    await withBroker(async ({ paths, env, broker }) => {
      const credential = loadCredential(clientPaths(env));
      const pending = await daemonPair(paths, credential);
      assert.equal(pending.state, 'pending');
      assert.equal(typeof pending.code, 'string');
      assert.equal(pending.autoApproved, undefined);
      assert.equal(broker.state.daemons.get(credential.account).state, 'pending');
      assert.equal((await admin(paths, { op: 'approve', code: pending.code })).state, 'approved');
    });
  });

test('only a single-account broker may auto-approve a daemon', () => {
  assert.throws(() => new Broker({ paths: {}, mode: 'group', autoApproveOwnDaemon: true }), { code: 'usage' });
});
