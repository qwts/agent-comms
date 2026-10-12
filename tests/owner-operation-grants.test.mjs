import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownerOperationList, OWNER_OPERATIONS } from '../lib/owner-operation-grants.mjs';
import { apply, emptyState, EventLog } from '../lib/state.mjs';
import { createPairing } from '../lib/broker/pairing.mjs';
import { admin, callPrincipal, loadPrincipalCredential, pairPrincipal } from '../lib/client.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { readHostConfig } from '../lib/host-config.mjs';
import { withBroker } from './helpers/broker.mjs';
const id = 'principal_11111111-1111-4111-8111-111111111111';
const pending = { t: 'principal-request', principal: id, account: 'owner', hash: 'hash', code: 'CODE', at: 1 };
const approved = { t: 'principal-approve', principal: id, grant: null, at: 2 };
const granted = { t: 'principal-owner-grant', principal: id, operations: ['revision.approve'], at: 3 };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ac-owner-grants-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = new EventLog(root); const state = log.replay();
  return { root, log, state, commit(record) { log.append(record); apply(state, record); } };
}
test('operation vocabulary has finite exact subsets without wildcards or inherited defaults', () => {
  assert.deepEqual(ownerOperationList([...OWNER_OPERATIONS].reverse()), OWNER_OPERATIONS);
  for (const value of [null, undefined, '*', ['*'], ['revision.approve', 'revision.approve'], ['revision.approve '],
    ['cold-wake.on'], [null], new Array(1), Array(6).fill('revision.edit')]) {
    assert.throws(() => ownerOperationList(value));
  }
  const input = ['revision.edit']; const result = ownerOperationList(input); input.push('revision.reject');
  assert.deepEqual(result, ['revision.edit']);
});
test('explicit grants survive append and checkpoint replay; revoke and re-pair clear them', t => {
  const f = fixture(t); f.commit(pending); f.commit(approved);
  assert.deepEqual(f.state.principals.get(id).ownerOperations, []);
  f.commit(granted); assert.deepEqual(new EventLog(f.root).replay().principals.get(id).ownerOperations, granted.operations);
  f.log.compact(f.state);
  assert.deepEqual(new EventLog(f.root).replay().principals.get(id).ownerOperations, granted.operations);
  f.commit({ ...granted, operations: [] });
  assert.deepEqual(new EventLog(f.root).replay().principals.get(id).ownerOperations, []);
  f.commit(granted); f.commit({ t: 'principal-revoke', principal: id });
  assert.throws(() => apply(f.state, granted), /approved principal/);
  f.commit(pending); f.commit(approved);
  assert.deepEqual(f.state.principals.get(id).ownerOperations, []);
});
test('legacy absence means no grant; corrupt stored lists refuse rather than normalize or revive', t => {
  const f = fixture(t); f.commit(pending); f.commit(approved); f.log.compact(f.state);
  const record = JSON.parse(readFileSync(f.log.file, 'utf8'));
  const row = record.snapshot.principals[0][1]; delete row.ownerOperations;
  const restore = () => { record.checksum = createHash('sha256').update(JSON.stringify(record.snapshot)).digest('hex'); const s = emptyState(); apply(s, record); return s; };
  assert.equal(restore().principals.get(id).ownerOperations, undefined);
  for (const bad of [null, ['*'], ['revision.edit', 'revision.adopt'], ['revision.edit', 'revision.edit']]) {
    row.ownerOperations = bad; assert.throws(restore, /owner operation grant/);
  }
  row.ownerOperations = ['revision.edit']; row.state = 'pending'; assert.throws(restore, /owner operation grant/);
});
test('admin validation refuses before append and cannot grant to pending, absent or revoked identities', () => {
  const state = emptyState(); apply(state, pending);
  const records = []; const pairing = createPairing({ state, now: () => 3 }, r => { records.push(r); apply(state, r); }, {});
  const request = { op: 'principal-owner-grant', principal: id, operations: ['revision.edit'] };
  assert.throws(() => pairing.handleAdmin(request), { code: 'unknown-principal' });
  apply(state, approved);
  for (const operations of [null, undefined, ['*'], ['revision.edit', 'revision.edit']]) {
    assert.throws(() => pairing.handleAdmin({ ...request, operations }), { code: 'bad-request' });
  }
  assert.equal(records.length, 0);
  pairing.handleAdmin({ ...request, operations: ['revision.reject', 'revision.adopt'] });
  assert.deepEqual(records[0].operations, ['revision.adopt', 'revision.reject']);
  apply(state, { t: 'principal-revoke', principal: id });
  assert.throws(() => pairing.handleAdmin(request), { code: 'unknown-principal' });
  assert.equal(records.length, 1);
});
test('private admin CLI replaces and clears grants; principal wire callers cannot self-enroll', async () => {
  await withBroker(async c => {
    const env = { ...c.env, AGENT_COMMS_NO_KEYCHAIN: '1' }, paths = clientPaths(env);
    const pendingPrincipal = await pairPrincipal(c.paths, paths, 'owner grant test', env);
    const credential = loadPrincipalCredential(paths, readHostConfig(env));
    await admin(c.paths, { op: 'principal-approve', code: pendingPrincipal.code, grant: [c.accounts.alice] });
    const principal = credential.principal;
    assert.deepEqual((await admin(c.paths, { op: 'principals' })).principals.find(p => p.principal === principal).ownerOperations, []);
    const grantedCli = await c.cli(['admin', 'principal-owner-grant', principal, '--operations', 'revision.reject,revision.approve']);
    assert.equal(grantedCli.exit, 0);
    assert.deepEqual(grantedCli.json.ownerOperations, ['revision.approve', 'revision.reject']);
    assert.deepEqual(c.broker.state.principals.get(principal).grant, [c.accounts.alice]);
    await assert.rejects(callPrincipal(c.paths, credential, { op: 'principal-owner-grant', principal, operations: ['revision.edit'] }));
    assert.deepEqual(c.broker.state.principals.get(principal).ownerOperations, ['revision.approve', 'revision.reject']);
    assert.notEqual((await c.cli(['admin', 'principal-owner-grant', principal])).exit, 0);
    const cleared = await c.cli(['admin', 'principal-owner-grant', principal, '--operations', 'none']);
    assert.equal(cleared.exit, 0); assert.deepEqual(cleared.json.ownerOperations, []);
    await admin(c.paths, { op: 'principal-revoke', principal });
    await assert.rejects(admin(c.paths, { op: 'principal-owner-grant', principal, operations: ['revision.edit'] }), { code: 'unknown-principal' });
  }, { brokerOptions: { mode: 'single-account' } });
});
