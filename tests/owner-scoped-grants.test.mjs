import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { ownerGrantList, OWNER_GRANT_LIMITS, validateStoredOwnerGrants } from '../lib/owner-scoped-grants.mjs';
import { OWNER_OPERATIONS } from '../lib/owner-operation-grants.mjs';
import { ownerGrantCovers } from '../lib/broker/owner-grants.mjs';
import { createPairing } from '../lib/broker/pairing.mjs';
import { apply, emptyState, EventLog } from '../lib/state.mjs';
import { admin, call, callPrincipal, loadCredential, loadPrincipalCredential, pairPrincipal } from '../lib/client.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { readHostConfig } from '../lib/host-config.mjs';
import { withBroker } from './helpers/broker.mjs';

const id = 'principal_11111111-1111-4111-8111-111111111111';
const soul = n => `agent_${n.toString(16).padStart(8, '0')}-1111-8111-8111-111111111111`;
const a = soul(1), b = soul(2);
const entry = (account = 'alice', souls = [a], operations = ['revision.approve']) => ({ account, souls, operations });
const pending = { t: 'principal-request', principal: id, account: 'owner', hash: 'hash', code: 'CODE', at: 1 };
const approved = { t: 'principal-approve', principal: id, grant: null, at: 2 };
const granted = { t: 'principal-owner-grants', principal: id, grants: ownerGrantList([entry()]), at: 3 };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ac-scoped-owner-grants-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = new EventLog(root), state = log.replay();
  return { root, log, state, commit(record) { log.append(record); apply(state, record); } };
}

test('scopes normalize copies with exact existing identity grammar and bounded explicit selectors', () => {
  const source = [entry('bob', '*', []), entry('Alice', [b, a], ['revision.reject', 'revision.approve'])];
  const normalized = ownerGrantList(source);
  assert.deepEqual(normalized, [entry('Alice', [a, b], ['revision.approve', 'revision.reject']), entry('bob', '*', [])]);
  source[1].souls.push(soul(3)); source[1].operations.push('revision.edit'); source[0].account = 'changed';
  assert.equal(normalized[1].account, 'bob'); assert.equal(normalized[0].souls.length, 2);
  const validIds = [1, 2, 3, 4, 5, 6, 7, 8].map(v => a.replace('-8111-', `-${v}111-`));
  assert.equal(ownerGrantList([entry('_Account.-', validIds)]).length, 1);
  for (const value of [undefined, null, {}, '*', new Array(1), [null], [entry('', '*')], [entry('a\n')],
    [entry('a'.repeat(65))], [entry('a/b')], [entry('alice', [])], [entry('alice', null)],
    [entry('alice', [a, a])], [entry('alice', [a + '\n'])], [entry('alice', [a.toUpperCase()])],
    [entry('alice', [a.replace('-8111-', '-0111-')])], [entry('alice', [a.replace('-8111-111111111111', '-7111-111111111111')])],
    [entry('alice', '*', ['*'])], [entry('alice', '*', ['revision.edit', 'revision.edit'])],
    [{ ...entry(), operations: undefined }], [{ ...entry(), extra: true }], [entry(), entry()],
    [entry('alice', [a, b]), entry('alice', [b, a])]]) assert.throws(() => ownerGrantList(value));
  assert.throws(() => ownerGrantList(Array.from({ length: 33 }, (_, i) => entry(`a${i}`, '*'))));
  assert.throws(() => ownerGrantList([entry('alice', Array.from({ length: 33 }, (_, i) => soul(i)))]));
  const maxExplicit = Array.from({ length: 4 }, (_, i) => entry(`a${i}`, Array.from({ length: 32 }, (_, j) => soul(i * 32 + j))));
  assert.equal(ownerGrantList(maxExplicit).flatMap(e => e.souls).length, 128);
  assert.throws(() => ownerGrantList([...maxExplicit, entry('extra')]));
  // The byte ceiling is a second cap; these simultaneous structural maxima fit.
  const maximal = [...maxExplicit.map((e, i) => ({ ...e, account: `a${i}`.padEnd(64, 'x'), operations: [...OWNER_OPERATIONS] })),
    ...Array.from({ length: 28 }, (_, i) => entry(`b${i}`.padEnd(64, 'x'), '*', [...OWNER_OPERATIONS]))];
  assert.equal(ownerGrantList(maximal).length, 32);
  assert.ok(Buffer.byteLength(JSON.stringify(ownerGrantList(maximal))) <= OWNER_GRANT_LIMITS.bytes);
});

test('coverage unions overlapping selectors only within exact account and independently intersects target grants', () => {
  const state = emptyState(); apply(state, pending); apply(state, approved);
  const principal = state.principals.get(id);
  for (const account of ['alice', 'bob', 'Alice']) {
    state.pairings.set(account, { state: 'approved' }); state.daemons.set(account, { state: 'approved' });
  }
  principal.ownerGrants = ownerGrantList([entry('alice', '*', ['revision.reject']), entry('alice', [a], ['revision.approve']),
    entry('bob', [a], ['revision.edit'])]);
  const check = (account, agentId, op) => ownerGrantCovers(state, id, { account, agentId }, op);
  assert.equal(check('alice', a, 'revision.approve'), true);
  assert.equal(check('alice', a, 'revision.reject'), true);
  assert.equal(check('alice', b, 'revision.reject'), true);
  assert.equal(check('alice', b, 'revision.approve'), false);
  assert.equal(check('bob', a, 'revision.edit'), true);
  assert.equal(check('bob', a, 'revision.approve'), false);
  assert.equal(check('Alice', a, 'revision.approve'), false);
  assert.equal(check('alice', a, 'cold-wake.set'), false);
  // No soul row exists: joined state and mailbox receive allowlists confer no authority.
  assert.equal(state.souls.size, 0);
  state.souls.set(a, { account: 'bob', joined: false, allow: [] });
  assert.equal(check('alice', a, 'revision.approve'), true);
  for (const grant of [[], ['bob'], [b], [`bob/${a}`]]) {
    principal.grant = grant; assert.equal(check('alice', a, 'revision.approve'), false);
  }
  for (const grant of [['alice'], [a], [`alice/${a}`], null]) {
    principal.grant = grant; assert.equal(check('alice', a, 'revision.approve'), true);
  }
  for (const collection of [state.pairings, state.daemons]) {
    collection.get('alice').state = 'pending'; assert.equal(check('alice', a, 'revision.approve'), false);
    collection.delete('alice'); assert.equal(check('alice', a, 'revision.approve'), false);
    collection.set('alice', { state: 'approved' });
  }
  principal.state = 'pending'; assert.equal(check('alice', a, 'revision.approve'), false);
  principal.state = 'approved'; principal.ownerOperations = [...OWNER_OPERATIONS]; delete principal.ownerGrants;
  assert.equal(check('alice', a, 'revision.approve'), false);
  principal.ownerGrants = [entry('alice', '*', [])]; assert.equal(check('alice', a, 'revision.approve'), false);
  principal.ownerGrants = [entry('alice', '*', ['*'])]; assert.equal(check('alice', a, 'revision.approve'), false);
  state.principals.delete(id); assert.equal(check('alice', a, 'revision.approve'), false);
});

test('scoped grants survive event and checkpoint replay, replacement, revocation and fresh pairing', t => {
  const f = fixture(t); f.commit(pending); f.commit(approved); assert.deepEqual(f.state.principals.get(id).ownerGrants, []);
  f.commit(granted); assert.deepEqual(new EventLog(f.root).replay().principals.get(id).ownerGrants, granted.grants);
  f.log.compact(f.state); assert.deepEqual(new EventLog(f.root).replay().principals.get(id).ownerGrants, granted.grants);
  f.commit({ ...granted, grants: [] }); assert.deepEqual(new EventLog(f.root).replay().principals.get(id).ownerGrants, []);
  f.commit(granted); f.commit({ t: 'principal-revoke', principal: id });
  assert.throws(() => apply(f.state, granted), /approved principal/);
  f.commit(pending); f.commit(approved); assert.deepEqual(f.state.principals.get(id).ownerGrants, []);
});

test('stored scopes refuse malformed, noncanonical and pending lists; legacy absence remains inert', t => {
  const f = fixture(t); f.commit(pending); f.commit(approved); f.log.compact(f.state);
  const record = JSON.parse(readFileSync(f.log.file, 'utf8')), row = record.snapshot.principals[0][1];
  const restore = () => { record.checksum = createHash('sha256').update(JSON.stringify(record.snapshot)).digest('hex'); const s = emptyState(); apply(s, record); return s; };
  delete row.ownerGrants; row.ownerOperations = ['revision.approve']; assert.equal(restore().principals.get(id).ownerGrants, undefined);
  for (const grants of [null, [entry('bob'), entry('alice')], [entry('alice', [b, a])],
    [entry('alice', '*', ['revision.reject', 'revision.approve'])], [entry(), entry()], [{ ...entry(), extra: 1 }]]) {
    row.ownerGrants = grants; assert.throws(restore, /scoped owner grants/);
    assert.throws(() => apply(f.state, { ...granted, grants }));
  }
  row.ownerOperations = []; row.ownerGrants = granted.grants; row.state = 'pending'; assert.throws(restore, /scoped owner grants/);
  assert.throws(() => apply(f.state, { ...granted, grants: undefined }), /missing scoped owner grants/);
  validateStoredOwnerGrants({ state: 'pending', ownerGrants: [] });
});

test('private admin refuses bad scope before append and cannot revive pending/revoked identities', () => {
  const state = emptyState(); apply(state, pending);
  const records = [], pairing = createPairing({ state, now: () => 3 }, record => { records.push(record); apply(state, record); }, {});
  const request = { op: 'principal-owner-grants', principal: id, grants: [entry()] };
  assert.throws(() => pairing.handleAdmin(request), { code: 'unknown-principal' });
  apply(state, approved);
  for (const grants of [undefined, null, [entry('bad/account')], [entry(), entry()]])
    assert.throws(() => pairing.handleAdmin({ ...request, grants }), { code: 'bad-request' });
  assert.equal(records.length, 0);
  pairing.handleAdmin({ ...request, grants: [entry('bob', '*'), entry('alice', [b, a])] });
  assert.deepEqual(records[0].grants, ownerGrantList([entry('alice', [a, b]), entry('bob', '*')]));
  const listed = pairing.handleAdmin({ op: 'principals' }).principals[0]; listed.ownerGrants[0].souls.push(soul(3));
  assert.equal(state.principals.get(id).ownerGrants[0].souls.length, 2);
  apply(state, { t: 'principal-revoke', principal: id });
  assert.throws(() => pairing.handleAdmin(request), { code: 'unknown-principal' }); assert.equal(records.length, 1);
});

test('real admin CLI replaces/clears scopes, bounds JSON and rejects wire self-enrollment without legacy migration', async () => {
  await withBroker(async c => {
    const env = { ...c.env, AGENT_COMMS_NO_KEYCHAIN: '1' }, paths = clientPaths(env);
    const paired = await pairPrincipal(c.paths, paths, 'scoped grant test', env);
    const credential = loadPrincipalCredential(paths, readHostConfig(env)), principal = credential.principal;
    await admin(c.paths, { op: 'principal-approve', code: paired.code, grant: [c.owner] });
    const cli = args => c.cli(['admin', 'principal-owner-grants', principal, ...args]);
    const grants = [entry(c.owner, [c.accounts.alice])];
    const result = await cli(['--grants-json', JSON.stringify(grants)]);
    assert.equal(result.exit, 0); assert.deepEqual(result.json.ownerGrants, ownerGrantList(grants));
    assert.deepEqual((await admin(c.paths, { op: 'principals' })).principals.find(p => p.principal === principal).ownerGrants, ownerGrantList(grants));
    for (const args of [[], ['--grants', '*'], ['--grants', 'none', '--grants-json', '[]'], ['--grants-json', '{'],
      ['--grants-json', ' '.repeat(OWNER_GRANT_LIMITS.bytes + 1)], ['--grants-json', JSON.stringify([entry('bad/account')])]])
      assert.notEqual((await cli(args)).exit, 0);
    assert.deepEqual(c.broker.state.principals.get(principal).ownerGrants, ownerGrantList(grants));
    await assert.rejects(callPrincipal(c.paths, credential, { op: 'principal-owner-grants', principal, grants: [] }));
    await assert.rejects(call(c.paths, loadCredential(paths), { op: 'principal-owner-grants', principal, grants: [] }));
    const legacy = await c.cli(['admin', 'principal-owner-grant', principal, '--operations', 'revision.edit']);
    assert.equal(legacy.exit, 0); assert.deepEqual(legacy.json.ownerOperations, ['revision.edit']);
    assert.deepEqual(c.broker.state.principals.get(principal).ownerGrants, ownerGrantList(grants));
    const diagnostic = await promisify(execFile)(process.execPath, ['bin/agent-comms.mjs', 'admin', 'principal-owner-grant', principal, '--operations', 'none'],
      { cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 10000 });
    assert.deepEqual(JSON.parse(diagnostic.stdout).ownerOperations, []);
    assert.match(diagnostic.stderr, /Deprecated: ownerOperations is nonauthorizing/);
    assert.equal((await cli(['--grants', 'none'])).exit, 0);
    assert.deepEqual(c.broker.state.principals.get(principal).ownerGrants, []);
    await admin(c.paths, { op: 'principal-revoke', principal });
    await assert.rejects(admin(c.paths, { op: 'principal-owner-grants', principal, grants }), { code: 'unknown-principal' });
  }, { brokerOptions: { mode: 'single-account' } });
});
