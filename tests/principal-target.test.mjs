import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConnection } from 'node:net';
import { admin, call, callPrincipal, loadCredential, loadPrincipalCredential, pairPrincipal } from '../lib/client.mjs';
import { readHostConfig } from '../lib/host-config.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { covers } from '../lib/broker/shared.mjs';
import { pairAccount, withBroker } from './helpers/broker.mjs';
import { Broker } from '../lib/broker.mjs';

function rawRequest(paths, fields) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(paths.socket);
    let buffer = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('request timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ v: 1, ...fields })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      socket.destroy();
      const result = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      if (result.ok) resolve(result);
      else reject(Object.assign(new Error(result.error.message), { code: result.error.code }));
    });
  });
}

async function principal(c, grant) {
  const env = { ...c.env, AGENT_COMMS_NO_KEYCHAIN: '1' };
  const paths = clientPaths(env);
  const pending = await pairPrincipal(c.paths, paths, 'target-check test', env);
  const credential = loadPrincipalCredential(paths, readHostConfig(env));
  await admin(c.paths, { op: 'principal-approve', code: pending.code, grant });
  return { credential, check: (agentId, extra = {}) => callPrincipal(c.paths, credential,
    { op: 'principal-target-check', agentId, ...extra }) };
}

const privateBroker = { brokerOptions: { mode: 'single-account' } };

test('existing bare soul grants are account-independent and null grants unrestricted', () => {
  const agentId = `agent_${randomUUID()}`;
  for (const account of ['owner', 'other-account']) {
    assert.equal(covers([agentId], { agentId, account }), true);
    assert.equal(covers(null, { agentId, account }), true);
    assert.equal(covers([`owner/${agentId}`], { agentId, account }), account === 'owner');
  }
});

test('target checks resolve broker ownership and apply current account, soul and address grants', async () => {
  await withBroker(async (c) => {
    for (const grant of [null, [c.owner], [c.accounts.alice], [`${c.owner}/${c.accounts.alice}`]]) {
      const p = await principal(c, grant);
      const result = await p.check(c.accounts.alice);
      assert.deepEqual(result, { ok: true, principal: p.credential.principal, agentId: c.accounts.alice, account: c.owner });
      if (grant && !grant.includes(c.owner)) await assert.rejects(p.check(c.accounts.bob), { code: 'unauthorized-target' });
      await assert.rejects(p.check(c.accounts.alice, { account: 'invented-account' }), { code: 'bad-request' });
    }
    const denied = await principal(c, []);
    const unknown = `agent_${randomUUID()}`;
    for (const agentId of [c.accounts.alice, unknown]) {
      await assert.rejects(denied.check(agentId), (error) => error.code === 'unauthorized-target'
        && error.message === 'this principal does not authorize the requested target');
    }
  }, privateBroker);
});

test('pre-join targets need no guessed account: null and exact soul grant pass; account/address grants refuse', async () => {
  await withBroker(async (c) => {
    const agentId = `agent_${randomUUID()}`;
    for (const grant of [null, [agentId]]) {
      const p = await principal(c, grant);
      assert.deepEqual(await p.check(agentId), { ok: true, principal: p.credential.principal, agentId, account: null });
    }
    for (const grant of [[c.owner], [`${c.owner}/${agentId}`], []]) {
      const p = await principal(c, grant);
      await assert.rejects(p.check(agentId), { code: 'unauthorized-target' });
    }
  }, privateBroker);
});

test('target ownership follows the registered account, independently of the principal requesting account', async () => {
  await withBroker(async (c) => {
    // Two account names sharing a test UID model broker state, not a native
    // cross-account custody claim. Pairing and requests use the real socket.
    const paired = await pairAccount(c.paths, 'reviewer', process.getuid());
    await admin(c.paths, { op: 'approve', code: paired.code });
    const agentId = `agent_${randomUUID()}`;
    const account = { ...paired.credential, mode: 'single-account' };
    await call(c.paths, account, { op: 'join', agentId });
    const allowed = await principal(c, ['reviewer']);
    assert.equal((await allowed.check(agentId)).account, 'reviewer');
    const wrongAccount = await principal(c, [c.owner]);
    await assert.rejects(wrongAccount.check(agentId), { code: 'unauthorized-target' });
    const explicitSoul = await principal(c, [agentId]);
    assert.equal((await explicitSoul.check(agentId)).account, 'reviewer');
  }, { brokerOptions: { mode: 'single-account', uidOf: () => process.getuid() } });
});

test('departed targets retain ownership; revoked accounts cannot escape through pre-join authorization', async () => {
  await withBroker(async (c) => {
    const p = await principal(c, null);
    const account = loadCredential(clientPaths(c.env));
    await call(c.paths, account, { op: 'leave', agentId: c.accounts.alice });
    assert.equal((await p.check(c.accounts.alice)).account, c.owner);
    await c.broker.stop();
    const restarted = await new Broker({ paths: c.paths, mode: 'single-account' }).start();
    try {
      assert.equal((await p.check(c.accounts.alice)).account, c.owner);
      await admin(c.paths, { op: 'revoke', account: c.owner });
      for (const agentId of [c.accounts.alice, c.accounts.bob]) await assert.rejects(p.check(agentId), { code: 'unauthorized-target' });
      assert.equal(restarted.state.souls.get(c.accounts.alice).account, c.owner);
    } finally { await restarted.stop(); }
  }, privateBroker);
});

test('principal revocation is rechecked and account, daemon and mixed credentials confer no authority', async () => {
  await withBroker(async (c) => {
    const p = await principal(c, [c.accounts.alice]);
    await p.check(c.accounts.alice);
    const account = loadCredential(clientPaths(c.env));
    await assert.rejects(call(c.paths, account, { op: 'principal-target-check', agentId: c.accounts.alice }), { code: 'unauthenticated' });
    for (const extra of [{ auth: { ...p.credential, account: c.owner } },
      { auth: { daemon: c.owner, secret: 'not-a-daemon' } }]) {
      // callPrincipal deliberately overwrites auth, so use the wire helper.
      await assert.rejects(rawRequest(c.paths, { op: 'principal-target-check', agentId: c.accounts.alice, ...extra }), { code: 'unauthenticated' });
    }
    await admin(c.paths, { op: 'principal-revoke', principal: p.credential.principal });
    await assert.rejects(p.check(c.accounts.alice), { code: 'unauthenticated' });
  }, privateBroker);
});
