import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireOwnerJournalLock } from '../lib/platform/owner-journal-lock.mjs';
import { OwnerDecisionAdmissionStore as Store } from '../lib/owner-decision-journal.mjs';
import { OWNER_JOURNAL_FIXED_SLOTS as slots, encodeOwnerJournalFrame, decodeOwnerJournalFrame } from '../lib/owner-decision-journal-frame.mjs';
const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/v1.json', import.meta.url))).positive;
const namespaceDigest = 'a'.repeat(64);
const hash = b => createHash('sha256').update(b).digest('hex');
const canonical = v => v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(canonical)}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const bytes = v => Buffer.from(canonical(v));
const darwin = { skip: process.platform !== 'darwin', timeout: 120000 };
const open = (dir, options = {}) => new Store(dir, { namespaceDigest, format: 'fixed-v1', ...options });
const reject = (fn, message) => assert.throws(fn, { message });
const directory = (dir, id) => path.join(dir, 'requests', id);
const file = (dir, id, slot) => path.join(directory(dir, id), `${slot}.record`);
const allSlots = [...slots, { slot: 'scratch', cap: 32768 }];
function input(vector = vectors[0]) {
  const action = JSON.parse(vector.actionJson), actionBytes = bytes(action);
  const acceptance = { v: 1, kind: 'acceptance', requestId: action.requestId, principal: action.principal,
    account: action.account, soul: action.soul, operation: action.operation, payloadDigest: hash(actionBytes),
    namespaceDigest, acceptedAt: 2000000000, daemonKey: 'b'.repeat(64), daemonEpoch: 1,
    watchId: '11111111-1111-4111-8111-111111111111', reservationBytes: 262144 };
  return { action, actionBytes, acceptance, acceptanceBytes: bytes(acceptance) };
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-fixed-journal-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function frame(i, slot, payload) {
  return encodeOwnerJournalFrame(payload, { slot, requestId: i.action.requestId, namespaceDigest });
}

// Each owned child has bounded output, a finite kill deadline and awaited exit.
// Cleanup is installed before spawning; failed assertions cannot orphan children.
function children(t) {
  const active = new Set();
  t.after(async () => { await Promise.all([...active].map(async child => {
    const done = once(child, 'exit'); child.kill('SIGKILL'); await done;
  })); });
  return async source => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_BOT_ID: '', QWTS_AGENT_ID: '', AGENT_BOT_BINDING: '' } });
    active.add(child); let output = '', total = 0, timedOut = false;
    const capture = chunk => { total += chunk.length; if (total <= 16384) output += chunk; else child.kill('SIGKILL'); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
    try { const [code, signal] = await once(child, 'close'); assert.equal(timedOut, false, 'child must reach its selected crash point'); assert(total <= 16384); return { code, signal, output }; }
    finally { clearTimeout(timer); active.delete(child); }
  };
}
const moduleUrl = new URL('../lib/owner-decision-journal.mjs', import.meta.url).href;
function childSource(dir, i, extra, operation = 'admit') {
  return `import * as fs from 'node:fs'; import {OwnerDecisionAdmissionStore as Store} from ${JSON.stringify(moduleUrl)};
    const dir=${JSON.stringify(dir)}, namespaceDigest=${JSON.stringify(namespaceDigest)};
    const action=Buffer.from(${JSON.stringify(i.actionBytes.toString('base64'))},'base64');
    const acceptance=Buffer.from(${JSON.stringify(i.acceptanceBytes.toString('base64'))},'base64');
    ${extra}
    const s=new Store(dir,{namespaceDigest,format:'fixed-v1',...options});
    s.${operation}(${operation === 'admit' ? 'action,acceptance' : JSON.stringify(i.action.requestId)});
    process.exit(42);`;
}
function assertPrefix(dir, i) {
  const s = open(dir), r = s.read(i.action.requestId);
  assert.equal(s.inspect().retainedIds, 1); assert.equal(s.inspect().logicalReservedBytes, 262144);
  assert.equal(s.inspect().authorizationSupported, false); assert.equal(s.inspect().physicalAllocationSupported, false);
  assert.notEqual(r.finding, 'admission-complete');
  if (r.finding === 'admission-visible') {
    reject(() => s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-recovery-required');
    assert.equal(s.recover(i.action.requestId).finding, 'admission-complete');
    assert.equal(s.admit(i.actionBytes, i.acceptanceBytes).duplicate, true);
  } else {
    assert.equal(r.finding, 'orphan');
    reject(() => s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-id-spent');
    reject(() => s.recover(i.action.requestId), 'owner-journal-id-spent');
  }
}

test('fixed backend admits all operations into eleven exact final inodes without late namespace mutation', darwin, t => {
  const dir = temporary(t); let initialized = false; const identities = new Map();
  const io = { ...fs,
    openSync: (name, flags, ...rest) => {
      if (initialized && typeof name === 'string' && name.includes('/requests/')) assert.equal(flags & fs.constants.O_CREAT, 0);
      return fs.openSync(name, flags, ...rest);
    },
    ftruncateSync: (...args) => { assert.equal(initialized, false); return fs.ftruncateSync(...args); },
    linkSync: (...args) => { assert.equal(initialized, false); return fs.linkSync(...args); },
    unlinkSync: (...args) => { assert.equal(initialized, false); return fs.unlinkSync(...args); },
    renameSync: () => assert.fail('no record rename') };
  const s = open(dir, { io, fault: at => { if (at === 'initialize:directory-flushed') {
    initialized = true;
    for (const { slot } of allSlots) { const name = file(dir, current.action.requestId, slot); identities.set(name, fs.statSync(name).ino); }
  } } });
  let current;
  for (const v of vectors) {
    initialized = false; current = input(v); const id = current.action.requestId;
    assert.equal(s.admit(current.actionBytes, current.acceptanceBytes).duplicate, false);
    assert.equal(s.admit(current.actionBytes, current.acceptanceBytes).duplicate, true);
    assert.deepEqual(fs.readdirSync(directory(dir, id)).sort(), allSlots.map(e => `${e.slot}.record`).sort());
    for (const { slot, cap } of allSlots) {
      const name = file(dir, id, slot), saved = fs.readFileSync(name), stat = fs.statSync(name);
      assert.equal(stat.size, cap + 256); assert.equal(stat.ino, identities.get(name)); assert.equal(stat.nlink, 1); assert.equal(stat.mode & 0o7777, 0o600);
      if (['original-action', 'acceptance'].includes(slot)) {
        const decoded = decodeOwnerJournalFrame(saved, { slot, requestId: id, namespaceDigest });
        assert.equal(decoded.kind, 'committed'); assert(decoded.payload.equals(slot === 'acceptance' ? current.acceptanceBytes : current.actionBytes));
      } else assert(saved.every(b => b === 0));
    }
  }
  assert.equal(s.inspect().retainedIds, vectors.length);
});

test('reopened visible pair refuses admission until explicit flush; status reads are inert', darwin, t => {
  const dir = temporary(t), i = input(); open(dir).admit(i.actionBytes, i.acceptanceBytes);
  const s = open(dir, { io: { ...fs, fsyncSync: () => assert.fail('status must not flush'), writeSync: () => assert.fail('status must not write') } });
  assert.equal(s.read(i.action.requestId).finding, 'admission-visible');
  reject(() => s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-recovery-required');
  const recovered = open(dir);
  assert.deepEqual(recovered.recover(i.action.requestId), { requestId: i.action.requestId, finding: 'admission-complete', authorizationSupported: false, physicalAllocationSupported: false });
  assert.equal(recovered.admit(i.actionBytes, i.acceptanceBytes).duplicate, true);
  assert.equal(open(dir).read(i.action.requestId).finding, 'admission-visible');
  const missing = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  assert.deepEqual(recovered.recover(missing), { requestId: missing, finding: 'absent' });
  assert.equal(fs.existsSync(directory(dir, missing)), false);
  fs.unlinkSync(path.join(dir, 'namespace.record'));
  reject(() => recovered.inspect(), 'owner-journal-corrupt'); assert.equal(fs.existsSync(path.join(dir, 'namespace.record')), false);
});

test('trusted format selection is durable, exact and never inferred from request artifacts', darwin, t => {
  for (const format of ['fixed-v1', 'scratch-v1']) {
    const dir = temporary(t); open(dir, { format });
    reject(() => open(dir, { format: format === 'fixed-v1' ? 'scratch-v1' : 'fixed-v1' }), 'owner-journal-corrupt');
    assert.equal(open(dir, { format }).inspect().retainedIds, 0);
  }
  for (const format of [null, 'fixed', {}, 1]) reject(() => open(temporary(t), { format }), 'invalid-owner-journal-record');
});

test('fresh full-slot rereads invalidate inode and exact-byte caches; unknown or later records freeze', darwin, t => {
  const i = input();
  for (const mutate of [
    (dir) => { const name = file(dir, i.action.requestId, 'presence'); const saved = fs.readFileSync(name); fs.renameSync(name, name + '.old'); fs.writeFileSync(name, saved, { mode: 0o600 }); fs.unlinkSync(name + '.old'); },
    (dir) => fs.writeFileSync(file(dir, i.action.requestId, 'acceptance'), frame(i, 'acceptance', bytes({ ...i.acceptance, acceptedAt: i.acceptance.acceptedAt + 1 })))
  ]) {
    const dir = temporary(t), s = open(dir); s.admit(i.actionBytes, i.acceptanceBytes); mutate(dir);
    assert.equal(s.read(i.action.requestId).finding, 'admission-visible');
    const saved = s.read(i.action.requestId); reject(() => s.admit(saved.actionBytes, saved.acceptanceBytes), 'owner-journal-recovery-required');
    s.recover(i.action.requestId); assert.equal(s.admit(saved.actionBytes, saved.acceptanceBytes).duplicate, true);
  }
  const cases = [
    ['owner-journal-corrupt', dir => { const name = file(dir, i.action.requestId, 'acceptance'); const b = fs.readFileSync(name); b[150] ^= 1; fs.writeFileSync(name, b); }],
    ['owner-journal-corrupt', dir => fs.writeFileSync(path.join(directory(dir, i.action.requestId), 'unknown'), 'secret-canary', { mode: 0o600 })],
    ['owner-journal-unsupported-phase', dir => { const fd = fs.openSync(file(dir, i.action.requestId, 'release'), 'r+'); try { fs.writeSync(fd, Buffer.from([1]), 0, 1, 0); } finally { fs.closeSync(fd); } }],
    ['owner-journal-corrupt', dir => fs.writeFileSync(file(dir, i.action.requestId, 'acceptance'), frame(i, 'acceptance', bytes({ ...i.acceptance, payloadDigest: 'c'.repeat(64) })))],
    ['owner-journal-corrupt', dir => fs.chmodSync(file(dir, i.action.requestId, 'scratch'), 0o644)]
  ];
  for (const [expected, mutate] of cases) {
    const dir = temporary(t), s = open(dir); s.admit(i.actionBytes, i.acceptanceBytes); mutate(dir);
    reject(() => s.inspect(), expected); reject(() => s.read(i.action.requestId), 'owner-journal-reopen-required');
    reject(() => open(dir), expected);
  }
});

test('recovery revalidates every slot and namespace after flushing before recording success', darwin, t => {
  const i = input();
  for (const change of ['later', 'inode', 'namespace', 'unknown']) {
    const dir = temporary(t); open(dir).admit(i.actionBytes, i.acceptanceBytes); let changed = false;
    const s = open(dir, { fault: at => { if (at !== 'recovery:parent-directory-flushed' || changed) return; changed = true;
      if (change === 'later') { const name = file(dir, i.action.requestId, 'presence'); const b = fs.readFileSync(name); b[0] = 1; fs.writeFileSync(name, b); }
      if (change === 'inode') { const name = file(dir, i.action.requestId, 'scratch'); const b = fs.readFileSync(name); fs.renameSync(name, name + '.old'); fs.writeFileSync(name, b, { mode: 0o600 }); fs.unlinkSync(name + '.old'); }
      if (change === 'namespace') fs.unlinkSync(path.join(dir, 'namespace.record'));
      if (change === 'unknown') fs.writeFileSync(path.join(directory(dir, i.action.requestId), 'unknown'), '', { mode: 0o600 });
    } });
    reject(() => s.recover(i.action.requestId), change === 'later' ? 'owner-journal-unsupported-phase' : 'owner-journal-corrupt');
    reject(() => s.inspect(), 'owner-journal-reopen-required');
  }
});

test('fixed lifetime quota retains initialized and interrupted IDs; recovery stays available at capacity', darwin, t => {
  const dir = temporary(t), i = input(); open(dir).admit(i.actionBytes, i.acceptanceBytes);
  for (let n = 0; n < 4095; n++) fs.mkdirSync(directory(dir, `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`), { mode: 0o700 });
  const s = open(dir); assert.equal(s.inspect().retainedIds, 4096);
  const next = input(vectors[1]); reject(() => s.admit(next.actionBytes, next.acceptanceBytes), 'owner-journal-capacity');
  assert.equal(s.read(i.action.requestId).finding, 'admission-visible'); s.recover(i.action.requestId);
  assert.equal(s.admit(i.actionBytes, i.acceptanceBytes).duplicate, true); assert.equal(s.inspect().logicalReservedBytes, 1073741824);
  assert.equal(fs.existsSync(directory(dir, next.action.requestId)), false);
});

test('partial positional reads/writes complete; zero progress and close failure sanitize and poison', darwin, t => {
  const i = input(), shortDir = temporary(t);
  const s = open(shortDir, { io: { ...fs,
    writeSync: (fd, b, o, n, p) => fs.writeSync(fd, b, o, Math.min(n, 97), p),
    readSync: (fd, b, o, n, p) => fs.readSync(fd, b, o, Math.min(n, 89), p) } });
  assert.equal(s.admit(i.actionBytes, i.acceptanceBytes).finding, 'admission-complete');
  for (const selected of ['writeSync', 'readSync', 'closeSync']) {
    const dir = temporary(t); open(dir); let armed = false;
    const store = open(dir, { fault: at => { if (at === 'request:directory-flushed') armed = true; }, io: { ...fs,
      [selected]: (...args) => {
        if (!armed) return fs[selected](...args);
        if (selected === 'closeSync') { fs.closeSync(...args); throw new Error('secret-canary'); }
        return 0;
      } } });
    reject(() => store.admit(i.actionBytes, i.acceptanceBytes), selected === 'readSync' ? 'owner-journal-corrupt' : 'owner-journal-storage-failed');
    reject(() => store.inspect(), 'owner-journal-reopen-required'); assert(fs.existsSync(directory(dir, i.action.requestId)));
  }
});

test('all admission and recovery fsync boundaries fail closed on EIO, ENOSPC and EDQUOT', darwin, t => {
  const i = input();
  for (const operation of ['admit', 'recover']) {
    const measureDir = temporary(t); open(measureDir); if (operation === 'recover') open(measureDir).admit(i.actionBytes, i.acceptanceBytes);
    let count = 0; const measure = open(measureDir, { io: { ...fs, fsyncSync: fd => { count++; return fs.fsyncSync(fd); } } });
    measure[operation](...(operation === 'admit' ? [i.actionBytes, i.acceptanceBytes] : [i.action.requestId])); assert(count >= 13);
    for (const code of ['EIO', 'ENOSPC', 'EDQUOT']) for (let selected = 1; selected <= count; selected++) {
      const dir = temporary(t); open(dir); if (operation === 'recover') open(dir).admit(i.actionBytes, i.acceptanceBytes);
      let calls = 0;
      const s = open(dir, { io: { ...fs, fsyncSync: fd => {
        if (++calls === selected) { const e = new Error('secret-canary'); e.code = code; throw e; } return fs.fsyncSync(fd);
      } } });
      reject(() => s[operation](...(operation === 'admit' ? [i.actionBytes, i.acceptanceBytes] : [i.action.requestId])), 'owner-journal-storage-failed');
      assert.equal(calls, selected); reject(() => s.inspect(), 'owner-journal-reopen-required'); assertPrefix(dir, i);
    }
  }
});

test('SIGKILL at every initialized/admission/recovery phase never turns visibility into acknowledgement', darwin, async t => {
  const run = children(t), i = input(), measured = temporary(t); const admission = [], recovery = [];
  const m = open(measured, { fault: at => admission.push(at) }); admission.length = 0;
  m.admit(i.actionBytes, i.acceptanceBytes);
  open(measured, { fault: at => recovery.push(at) }).recover(i.action.requestId);
  assert.equal(admission.length, 82); assert.equal(recovery.length, 13);
  for (const [operation, events] of [['admit', admission], ['recover', recovery]]) for (const event of events) {
    const dir = temporary(t); open(dir); if (operation === 'recover') open(dir).admit(i.actionBytes, i.acceptanceBytes);
    const result = await run(childSource(dir, i, `const options={fault:at=>{if(at===${JSON.stringify(event)}) process.kill(process.pid,'SIGKILL')}};`, operation));
    assert.deepEqual(result, { code: null, signal: 'SIGKILL', output: '' }, `${operation}:${event}`);
    assertPrefix(dir, i);
  }
});

test('SIGKILL inside body/trailer writes retains torn frames and never uses an older accepted image', darwin, async t => {
  const run = children(t), i = input();
  for (const slot of ['original-action', 'acceptance']) for (const section of ['body', 'trailer']) for (const prefix of [1, 64, 127]) {
    const dir = temporary(t); open(dir);
    const result = await run(childSource(dir, i, `const names=new Map(); const options={io:{...fs,
      openSync:(name,flags,...rest)=>{const fd=fs.openSync(name,flags,...rest); names.set(fd,{name,flags});return fd},
      closeSync:fd=>{names.delete(fd);return fs.closeSync(fd)},
      writeSync:(fd,b,o,n,p)=>{const entry=names.get(fd); const selected=entry?.name.endsWith('/${slot}.record')&&!(entry.flags&fs.constants.O_CREAT);
        if(selected && ${section === 'body' ? 'p===0' : 'p===b.length-128'}) {fs.writeSync(fd,b,o,${prefix},p);process.kill(process.pid,'SIGKILL')}
        return fs.writeSync(fd,b,o,n,p)} }};`));
    assert.equal(result.signal, 'SIGKILL'); assert.equal(result.output, '');
    // The trailer ends in required zeros. A 127-byte prefix can therefore
    // already equal the complete visible frame, but it still proves no flush.
    if (section === 'trailer' && prefix === 127) assertPrefix(dir, i);
    else reject(() => open(dir), 'owner-journal-corrupt');
    assert(fs.existsSync(directory(dir, i.action.requestId)));
  }
});

test('final acknowledgement requires the exact original bytes, not only a valid replacement graph', darwin, t => {
  const dir = temporary(t), i = input();
  const s = open(dir, { fault: at => {
    if (at === 'acceptance:fixed-verified') fs.writeFileSync(file(dir, i.action.requestId, 'acceptance'),
      frame(i, 'acceptance', bytes({ ...i.acceptance, acceptedAt: i.acceptance.acceptedAt + 1 })));
  } });
  reject(() => s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-corrupt');
  reject(() => s.inspect(), 'owner-journal-reopen-required');
  assert.equal(open(dir).read(i.action.requestId).finding, 'admission-visible');
});

test('every initialized slot is checked for wrong EOF, link ownership and corruption after recovery flush', darwin, t => {
  const i = input();
  for (const { slot, cap } of allSlots) {
    const dir = temporary(t); open(dir).admit(i.actionBytes, i.acceptanceBytes);
    const s = open(dir, { fault: at => { if (at === 'recovery:parent-directory-flushed') {
      const name = file(dir, i.action.requestId, slot), b = fs.readFileSync(name); b[150] ^= 1; fs.writeFileSync(name, b);
    } } });
    reject(() => s.recover(i.action.requestId), ['original-action', 'acceptance'].includes(slot) ? 'owner-journal-corrupt' : 'owner-journal-unsupported-phase');
    reject(() => s.inspect(), 'owner-journal-reopen-required');
    for (const change of ['oversize', 'hardlink', 'symlink']) {
      const root = temporary(t), store = open(root); store.admit(i.actionBytes, i.acceptanceBytes);
      const name = file(root, i.action.requestId, slot);
      if (change === 'oversize') fs.truncateSync(name, cap + 257);
      if (change === 'hardlink') fs.linkSync(name, path.join(temporary(t), 'retained-link'));
      if (change === 'symlink') { fs.unlinkSync(name); fs.symlinkSync('original-action.record', name); }
      reject(() => store.read(i.action.requestId), 'owner-journal-corrupt');
    }
  }
});

test('publication write errors and post-flush close errors retain the uncertain prefix', darwin, t => {
  const i = input();
  for (const code of ['EIO', 'ENOSPC', 'EDQUOT']) for (const selected of ['initialize', 'body', 'trailer']) {
    const dir = temporary(t); open(dir); const names = new Map();
    const s = open(dir, { io: { ...fs,
      openSync: (name, flags, ...rest) => { const fd = fs.openSync(name, flags, ...rest); names.set(fd, { name, flags }); return fd; },
      closeSync: fd => { names.delete(fd); return fs.closeSync(fd); },
      writeSync: (fd, b, o, n, p) => {
        const entry = names.get(fd), request = entry?.name.includes('/requests/');
        const initialize = Boolean(entry?.flags & fs.constants.O_CREAT);
        const publication = entry?.name.endsWith('/acceptance.record') && !initialize;
        if (request && ((selected === 'initialize' && initialize) || (publication && (selected === 'body' ? p === 0 : p === b.length - 128)))) {
          fs.writeSync(fd, b, o, Math.min(64, n), p); const error = new Error('secret-canary'); error.code = code; throw error;
        }
        return fs.writeSync(fd, b, o, n, p);
      } } });
    reject(() => s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-storage-failed');
    reject(() => s.inspect(), 'owner-journal-reopen-required');
    assert(fs.existsSync(directory(dir, i.action.requestId)));
    if (selected === 'initialize') assertPrefix(dir, i);
    else reject(() => open(dir), 'owner-journal-corrupt');
  }
  for (const event of ['original-action:fixed-trailer-flushed', 'acceptance:fixed-trailer-flushed', 'recovery:scratch:flushed']) {
    const dir = temporary(t); open(dir); if (event.startsWith('recovery:')) open(dir).admit(i.actionBytes, i.acceptanceBytes);
    let armed = false;
    const s = open(dir, { fault: at => { if (at === event) armed = true; }, io: { ...fs, closeSync: fd => {
      fs.closeSync(fd); if (armed) { armed = false; throw new Error('secret-canary'); }
    } } });
    reject(() => event.startsWith('recovery:') ? s.recover(i.action.requestId) : s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-storage-failed');
    reject(() => s.inspect(), 'owner-journal-reopen-required'); assertPrefix(dir, i);
  }
});

test('fixed store never bypasses the shared kernel lock for admission, reads or recovery', darwin, t => {
  const dir = temporary(t), i = input(), s = open(dir); let fd = acquireOwnerJournalLock(dir);
  try {
    for (const operation of [() => s.admit(i.actionBytes, i.acceptanceBytes), () => s.inspect(), () => s.read(i.action.requestId), () => s.recover(i.action.requestId)]) {
      reject(operation, 'owner-journal-busy');
    }
    assert.deepEqual(fs.readdirSync(path.join(dir, 'requests')), []);
  } finally { fs.closeSync(fd); fd = undefined; }
  assert.equal(s.admit(i.actionBytes, i.acceptanceBytes).finding, 'admission-complete');
  fd = acquireOwnerJournalLock(dir);
  try { reject(() => s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-busy'); }
  finally { fs.closeSync(fd); }
  assert.equal(s.admit(i.actionBytes, i.acceptanceBytes).duplicate, true);
});

test('all eleven blank slots are revalidated before the first action write', darwin, t => {
  const dir = temporary(t), i = input();
  const s = open(dir, { fault: at => { if (at === 'initialize:directory-flushed') {
    const name = file(dir, i.action.requestId, 'terminal-reference'); const b = fs.readFileSync(name); b[0] = 1; fs.writeFileSync(name, b);
  } } });
  reject(() => s.admit(i.actionBytes, i.acceptanceBytes), 'owner-journal-unsupported-phase');
  assert(fs.readFileSync(file(dir, i.action.requestId, 'original-action')).every(b => b === 0));
  assert(fs.readFileSync(file(dir, i.action.requestId, 'acceptance')).every(b => b === 0));
});
