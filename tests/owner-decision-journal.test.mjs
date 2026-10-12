import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { OwnerDecisionAdmissionStore as Store, validateOwnerDecisionAdmission as validate } from '../lib/owner-decision-journal.mjs';
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/v1.json', import.meta.url)));
const namespaceDigest = 'a'.repeat(64);
const canonical = v => v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(canonical)}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const bytes = v => Buffer.from(canonical(v));
const hash = v => createHash('sha256').update(v).digest('hex');
const darwin = { skip: process.platform !== 'darwin', timeout: 20000 };
function input(vector = fixtures.positive[0], requestId) {
  const action = JSON.parse(vector.actionJson); if (requestId) action.requestId = requestId;
  const actionBytes = bytes(action);
  const acceptance = { v: 1, kind: 'acceptance', requestId: action.requestId, principal: action.principal,
    account: action.account, soul: action.soul, operation: action.operation, payloadDigest: hash(actionBytes),
    namespaceDigest, acceptedAt: 2000000000, daemonKey: 'b'.repeat(64), daemonEpoch: 1,
    watchId: '11111111-1111-4111-8111-111111111111', reservationBytes: 262144 };
  return { action, actionBytes, acceptance, acceptanceBytes: bytes(acceptance) };
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-journal-core-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
const open = (dir, options = {}) => new Store(dir, { namespaceDigest, ...options });
const requestDir = (dir, id) => path.join(dir, 'requests', id);
const reject = (fn, message = 'invalid-owner-journal-record') => assert.throws(fn, { message });
function encoded(slot, payload) { return Buffer.concat([bytes({ bytes: payload.length, sha256: hash(payload), slot, v: 1 }), Buffer.from('\n'), payload]); }

test('pure admission validator checks every exact field, primitive and action binding for every operation', () => {
  for (const v of fixtures.positive) {
    const i = input(v); const result = validate(i.actionBytes, i.acceptanceBytes, namespaceDigest);
    assert.deepEqual(result.record, i.acceptance); assert.equal(result.payloadDigest, i.acceptance.payloadDigest);
    for (const field of Object.keys(i.acceptance)) {
      const missing = { ...i.acceptance }; delete missing[field]; reject(() => validate(i.actionBytes, bytes(missing), namespaceDigest));
    }
    reject(() => validate(i.actionBytes, bytes({ ...i.acceptance, extra: true }), namespaceDigest));
    for (const field of ['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'namespaceDigest', 'daemonKey', 'watchId']) {
      reject(() => validate(i.actionBytes, bytes({ ...i.acceptance, [field]: i.acceptance[field] + '\n' }), namespaceDigest));
    }
    for (const change of [{ v: 2 }, { kind: 'authorization' }, { daemonEpoch: 0 }, { daemonEpoch: 1.5 }, { daemonEpoch: '1' },
      { daemonEpoch: -1 }, { acceptedAt: -1 }, { acceptedAt: 1.5 }, { acceptedAt: '1' }, { reservationBytes: 524288 },
      { daemonKey: 'c'.repeat(63) }, { watchId: '11111111-1111-1111-8111-111111111111' }, { namespaceDigest: 'c'.repeat(64) }]) {
      reject(() => validate(i.actionBytes, bytes({ ...i.acceptance, ...change }), namespaceDigest));
    }
    const rebound = { requestId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      principal: 'principal_ffffffff-ffff-ffff-ffff-ffffffffffff', account: 'other-account',
      soul: 'agent_ffffffff-ffff-8fff-bfff-ffffffffffff', payloadDigest: 'c'.repeat(64),
      operation: i.action.operation === 'cold-wake.set' ? 'revision.edit' : 'cold-wake.set' };
    for (const [field, value] of Object.entries(rebound)) reject(() => validate(i.actionBytes, bytes({ ...i.acceptance, [field]: value }), namespaceDigest));
  }
});
test('pure admission validation preserves bot ID distinctions and snapshots byte inputs', () => {
  const i = input(); i.action.soul = 'agent_ffffffff-ffff-8fff-bfff-ffffffffffff';
  i.action.principal = 'principal_ffffffff-ffff-ffff-ffff-ffffffffffff'; i.actionBytes = bytes(i.action);
  i.acceptance.soul = i.action.soul; i.acceptance.principal = i.action.principal; i.acceptance.payloadDigest = hash(i.actionBytes);
  const saved = bytes(i.acceptance); const r = validate(i.actionBytes, saved, namespaceDigest); saved.fill(0); i.actionBytes.fill(0);
  assert.equal(r.record.soul, i.action.soul); assert.equal(hash(r.action), r.payloadDigest); assert.notEqual(r.acceptance[0], 0);
});
test('pure admission validation rejects malformed canonical bytes without exposing input text', () => {
  const i = input();
  for (const bad of [Buffer.from(' secret-canary'), Buffer.from(' ' + i.acceptanceBytes), Buffer.from([0xff]),
    Buffer.from('{"v":1,"v":1}'), Buffer.alloc(4097, 65), bytes(null), bytes([])]) reject(() => validate(i.actionBytes, bad, namespaceDigest));
  for (const bad of [null, 'secret-canary', new Uint8Array(32769), Buffer.from('secret-canary')]) reject(() => validate(bad, i.acceptanceBytes, namespaceDigest));
});

test('malformed constructor options and untrusted roots fail with fixed diagnostics', () => {
  for (const options of [null, { get namespaceDigest() { throw new Error('secret-canary'); } }]) reject(() => new Store('/unused-secret', options));
  for (const root of [null, 'relative-secret', '/absolute\0secret']) reject(() => new Store(root, { namespaceDigest }));
});

test('disabled store admits every operation, preserves exact bytes and serves read-only duplicates', darwin, t => {
  const dir = temporary(t); const s = open(dir);
  assert.deepEqual(s.inspect(), { retainedIds: 0, logicalReservedBytes: 0, physicalAllocationSupported: false, authorizationSupported: false, entries: [] });
  for (const v of fixtures.positive) {
    const i = input(v); const id = i.action.requestId;
    assert.deepEqual(s.admit(i.actionBytes, i.acceptanceBytes), { requestId: id, finding: 'admission-complete', duplicate: false });
    const before = fs.statSync(path.join(requestDir(dir, id), 'acceptance.record'));
    assert.deepEqual(s.admit(i.actionBytes, i.acceptanceBytes), { requestId: id, finding: 'admission-complete', duplicate: true });
    assert.equal(fs.statSync(path.join(requestDir(dir, id), 'acceptance.record')).mtimeMs, before.mtimeMs);
    const r = s.read(id); assert(r.actionBytes.equals(i.actionBytes)); assert(r.acceptanceBytes.equals(i.acceptanceBytes));
    r.actionBytes.fill(0); assert(s.read(id).actionBytes.equals(i.actionBytes));
  }
  const final = open(dir).inspect(); assert.equal(final.retainedIds, fixtures.positive.length);
  assert.equal(final.logicalReservedBytes, final.retainedIds * 262144); assert.equal(final.authorizationSupported, false);
  assert.deepEqual(s.read('ffffffff-ffff-4fff-bfff-ffffffffffff'), { requestId: 'ffffffff-ffff-4fff-bfff-ffffffffffff', finding: 'absent' });
});
test('invalid inputs create no request artifacts and changed saved acceptance conflicts without poisoning reads', darwin, t => {
  const dir = temporary(t); const s = open(dir); const i = input();
  reject(() => s.admit(i.actionBytes, bytes({ ...i.acceptance, extra: true }))); assert.equal(s.inspect().retainedIds, 0);
  s.admit(i.actionBytes, i.acceptanceBytes);
  reject(() => s.admit(i.actionBytes, bytes({ ...i.acceptance, acceptedAt: i.acceptance.acceptedAt + 1 })), 'owner-journal-conflict');
  assert.equal(s.inspect().retainedIds, 1); assert(s.read(i.action.requestId).acceptanceBytes.equals(i.acceptanceBytes));
});
test('empty and action-only orphan IDs remain spent and fully charged', darwin, t => {
  for (const stage of ['request:directory-flushed', 'action:cleanup-flushed']) {
    const dir = temporary(t); const i = input(); const s = open(dir, { fault: at => { if (at === stage) throw new Error('secret-canary'); } });
    reject(() => s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-storage-failed');
    reject(() => s.inspect(), 'owner-journal-reopen-required');
    const r = open(dir); assert.deepEqual(r.inspect().entries, [{ requestId: i.action.requestId, finding: 'orphan' }]);
    assert.equal(r.inspect().logicalReservedBytes, 262144); reject(() => r.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-id-spent');
    assert.equal(r.inspect().retainedIds, 1);
  }
});
test('full lifetime ID quota counts orphan directories, refuses admission and keeps existing reads', { ...darwin, timeout: 30000 }, t => {
  const dir = temporary(t); const s = open(dir); const i = input(); s.admit(i.actionBytes, i.acceptanceBytes);
  for (let n = 0; n < 4095; n++) fs.mkdirSync(requestDir(dir, `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`), { mode: 0o700 });
  const full = s.inspect(); assert.equal(full.retainedIds, 4096); assert.equal(full.logicalReservedBytes, 1073741824);
  const next = input(fixtures.positive[1]); reject(() => s.admit(next.actionBytes, next.acceptanceBytes), 'owner-journal-capacity');
  assert.equal(s.inspect().retainedIds, 4096); assert.equal(s.read(i.action.requestId).finding, 'admission-complete');
  assert.equal(s.admit(i.actionBytes, i.acceptanceBytes).duplicate, true); assert(!fs.existsSync(requestDir(dir, next.action.requestId)));
});
test('partial writes make progress, while zero writes and fsync errors fail closed with retained artifacts', darwin, t => {
  const i = input(); const shortDir = temporary(t); const short = open(shortDir, { io: { ...fs, writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, Math.min(7, length)) } });
  assert.equal(short.admit(i.actionBytes, i.acceptanceBytes).finding, 'admission-complete');
  for (const operation of ['writeSync', 'fsyncSync']) {
    const dir = temporary(t); open(dir);
    const s = open(dir, { io: { ...fs, [operation]: operation === 'writeSync' ? () => 0 : () => { const e = new Error('secret-canary'); e.code = 'ENOSPC'; throw e; } } });
    reject(() => s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-storage-failed');
    reject(() => s.inspect(), 'owner-journal-reopen-required'); assert(fs.existsSync(requestDir(dir, i.action.requestId)));
    if (operation === 'writeSync') reject(() => open(dir), 'owner-journal-corrupt');
    else assert.equal(open(dir).inspect().logicalReservedBytes, 262144);
  }
});

test('EIO at each admission flush boundary never acknowledges and retains the original ID', darwin, t => {
  const i = input();
  for (let selected = 1; selected <= 8; selected++) {
    const dir = temporary(t); open(dir); let calls = 0;
    const s = open(dir, { io: { ...fs, fsyncSync: fd => {
      if (++calls === selected) { const error = new Error('secret-canary'); error.code = 'EIO'; throw error; }
      return fs.fsyncSync(fd);
    } } });
    reject(() => s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-storage-failed'); assert.equal(calls, selected);
    reject(() => s.inspect(), 'owner-journal-reopen-required');
    const recovered = open(dir); assert.equal(recovered.inspect().retainedIds, 1); assert.equal(recovered.inspect().logicalReservedBytes, 262144);
    if (selected < 8) {
      assert.equal(recovered.read(i.action.requestId).finding, 'orphan');
      reject(() => recovered.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-id-spent');
    } else {
      // The target directory was already flushed; only redundant-scratch
      // removal's final flush failed. Still no automatic forwarding on reopen.
      assert.equal(recovered.read(i.action.requestId).finding, 'admission-complete');
      assert.equal(recovered.inspect().authorizationSupported, false);
    }
  }
});

test('exclusive publication never overwrites an existing target even if a racing target has identical bytes', darwin, t => {
  const i = input();
  for (const identical of [true, false]) {
    const dir = temporary(t); open(dir); let saved;
    const s = open(dir, { io: { ...fs, linkSync: (source, target) => {
      saved = identical ? fs.readFileSync(source) : Buffer.from('conflicting-secret-canary');
      fs.writeFileSync(target, saved, { mode: 0o600, flag: 'wx' }); fs.linkSync(source, target);
    } } });
    reject(() => s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-storage-failed');
    assert(fs.readFileSync(path.join(requestDir(dir, i.action.requestId), 'action.record')).equals(saved));
    if (identical) assert.equal(open(dir).read(i.action.requestId).finding, 'orphan');
    else reject(() => open(dir), 'owner-journal-corrupt');
  }
});
test('strict recovery rejects altered frames, action bindings, future phases, namespace changes and unknown artifacts', darwin, t => {
  const i = input();
  const mutations = [
    d => fs.appendFileSync(path.join(d, 'acceptance.record'), 'x'),
    d => { const b = fs.readFileSync(path.join(d, 'action.record')); b[b.length - 1] ^= 1; fs.writeFileSync(path.join(d, 'action.record'), b); },
    d => fs.writeFileSync(path.join(d, 'acceptance.record'), encoded('acceptance', bytes({ ...i.acceptance, daemonEpoch: 0 })), { mode: 0o600 }),
    d => fs.writeFileSync(path.join(d, 'acceptance.record'), encoded('acceptance', bytes({ ...i.acceptance, payloadDigest: 'c'.repeat(64) })), { mode: 0o600 }),
    d => fs.writeFileSync(path.join(d, 'unknown'), 'x', { mode: 0o600 }),
    d => fs.symlinkSync('action.record', path.join(d, 'pending')),
    d => fs.chmodSync(path.join(d, 'action.record'), 0o644),
    d => fs.unlinkSync(path.join(d, 'action.record')),
  ];
  for (const mutate of mutations) {
    const dir = temporary(t); open(dir).admit(i.actionBytes, i.acceptanceBytes); mutate(requestDir(dir, i.action.requestId));
    reject(() => open(dir), 'owner-journal-corrupt');
  }
  const dir = temporary(t); const s = open(dir); s.admit(i.actionBytes, i.acceptanceBytes);
  reject(() => open(dir, { namespaceDigest: 'c'.repeat(64) }), 'owner-journal-corrupt');
  fs.writeFileSync(path.join(requestDir(dir, i.action.requestId), 'authorization.record'), 'not-authority', { mode: 0o600 });
  reject(() => s.inspect(), 'owner-journal-unsupported-phase'); reject(() => open(dir), 'owner-journal-unsupported-phase');
});
test('redundant hard-link scratch is counted as a named artifact, never removed by a read or replay', darwin, t => {
  const dir = temporary(t); const s = open(dir); const i = input(); s.admit(i.actionBytes, i.acceptanceBytes);
  const d = requestDir(dir, i.action.requestId); fs.linkSync(path.join(d, 'acceptance.record'), path.join(d, 'pending'));
  assert.equal(open(dir).inspect().logicalReservedBytes, 262144); assert.equal(open(dir).read(i.action.requestId).finding, 'orphan');
  assert.equal(fs.lstatSync(path.join(d, 'pending')).nlink, 2); assert.equal(fs.readdirSync(d).length, 3);
  reject(() => open(dir).admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-id-spent'); assert(fs.existsSync(path.join(d, 'pending')));
});

test('read methods never recreate missing metadata, container or lock after initialization', darwin, t => {
  for (const name of ['namespace.record', 'requests', '.journal-lock']) {
    const dir = temporary(t); const s = open(dir); fs.rmSync(path.join(dir, name), { recursive: true });
    const code = name === '.journal-lock' ? 'owner-journal-storage-failed' : 'owner-journal-corrupt';
    reject(() => s.inspect(), code); assert(!fs.existsSync(path.join(dir, name)));
    reject(() => open(dir), code); assert(!fs.existsSync(path.join(dir, name)));
  }
});

test('directory scans stop at count+1 rather than collecting an unbounded listing', darwin, t => {
  const dir = temporary(t); open(dir); let reads = 0; let closed = 0;
  const io = { ...fs, opendirSync: directory => directory === path.join(dir, 'requests') ? {
    readSync: () => { reads++; return { name: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001' }; }, closeSync: () => closed++,
  } : fs.opendirSync(directory) };
  reject(() => open(dir, { io }), 'owner-journal-capacity'); assert.equal(reads, 4097); assert.equal(closed, 1);
});

test('killed writers preserve spent prefixes and never recover implicit release or authorization', darwin, async t => {
  const moduleUrl = new URL('../lib/owner-decision-journal.mjs', import.meta.url).href; const i = input();
  const stages = ['request:directory-created', 'request:directory-flushed', 'action:scratch-created', 'action:written',
    'action:file-flushed', 'action:linked', 'action:directory-flushed', 'action:scratch-removed',
    'acceptance:scratch-created', 'acceptance:written', 'acceptance:file-flushed', 'acceptance:linked',
    'acceptance:directory-flushed', 'acceptance:scratch-removed', 'acceptance:cleanup-flushed'];
  for (const stage of stages) {
    const dir = temporary(t); open(dir); const before = fs.lstatSync(path.join(dir, '.journal-lock'));
    const source = `import { OwnerDecisionAdmissionStore } from ${JSON.stringify(moduleUrl)};
      const s = new OwnerDecisionAdmissionStore(process.argv[1], { namespaceDigest: process.argv[2], fault: at => { if(at === process.argv[3]) process.kill(process.pid, 'SIGKILL'); } });
      s.admit(Buffer.from(process.argv[4], 'base64'), Buffer.from(process.argv[5], 'base64')); process.exit(9);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir, namespaceDigest, stage, i.actionBytes.toString('base64'), i.acceptanceBytes.toString('base64')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let size = 0; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { size += b.length; if (size > 32768) child.kill('SIGKILL'); else output += b; });
    const done = once(child, 'close'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    t.after(async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
    const [code, signal] = await done; clearTimeout(timer); assert.equal(code, null, `${stage}: ${output}`); assert.equal(signal, 'SIGKILL'); assert.equal(output, ''); assert(size <= 32768);
    assert.equal(fs.lstatSync(path.join(dir, '.journal-lock')).ino, before.ino); assert(fs.existsSync(requestDir(dir, i.action.requestId)));
    if (stage.endsWith(':scratch-created')) { reject(() => open(dir), 'owner-journal-corrupt'); continue; }
    const s = open(dir); const inspection = s.inspect(); assert.equal(inspection.retainedIds, 1); assert.equal(inspection.logicalReservedBytes, 262144);
    assert.equal(inspection.authorizationSupported, false); assert.equal(inspection.physicalAllocationSupported, false);
    const complete = stage.startsWith('acceptance:') && ['scratch-removed', 'cleanup-flushed'].includes(stage.split(':')[1]);
    assert.equal(s.read(i.action.requestId).finding, complete ? 'admission-complete' : 'orphan', stage);
    if (!complete) reject(() => s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-id-spent');
    else assert.equal(s.admit(i.actionBytes, i.acceptanceBytes).duplicate, true);
  }
});
