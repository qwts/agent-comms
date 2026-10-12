import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { BrokerOwnerEnrollmentStore as Store, BROKER_ENROLLMENT_STORE_LIMITS as limits } from '../lib/broker/owner-enrollment-store.mjs';
import { acquireOwnerJournalLock } from '../lib/platform/owner-journal-lock.mjs';
import { encodeBrokerOwnerEnrollmentFrame, BROKER_ENROLLMENT_SLOTS } from '../lib/owner-enrollment-frame.mjs';
import { fixture, triple, hash, bytes, seed, slotPath, namespaceDigest } from './helpers/owner-enrollment-store-fixture.mjs';
const supported = process.platform === 'darwin' && process.getuid() > 0;
const options = { skip: !supported, timeout: 120000 };
const refuse = (fn, message = 'owner-enrollment-storage-failed') => assert.throws(fn, { message });
const open = (t, root, opts) => { const store = new Store(root, opts); t.after(() => store.close()); return store; };
const commit = (store, entry, previous = null) => {
  const intent = store.beginIntent(previous, entry.record);
  return store.confirm(store.recordAudit(intent, entry.audit), entry.confirmation);
};
const digestTree = root => {
  const files = fs.readdirSync(root, { recursive: true }).sort();
  return files.map(file => { const stat = fs.lstatSync(path.join(root, file));
    return [file, stat.ino, stat.mode, stat.isFile() ? hash(fs.readFileSync(path.join(root, file))) : 'dir']; });
};

test('enrollment store real filesystem phases are separate, one-use and nonauthorizing', options, t => {
  const root = fixture(t), store = open(t, root), first = triple();
  assert.deepEqual(limits, { revisions: 1024, slotEntries: 3072, namedEntries: 3078,
    framedBytes: 6029312, sourceBytes: 4096, physicalAllocationSupported: false });
  assert.equal(store.inspect().state, 'empty');
  refuse(() => store.beginIntent(null, first.record), 'owner-enrollment-recovery-required');
  assert.equal(store.recoverConfirmed().completedRequestedFlush, true);
  const intent = store.beginIntent(null, first.record);
  assert.ok(Object.isFrozen(intent)); assert.equal(intent.phase, 'intent');
  assert.equal(store.inspect().state, 'pending');
  refuse(() => store.beginIntent(null, first.record), 'owner-enrollment-pending');
  refuse(() => store.confirm(intent, first.confirmation), 'invalid-owner-enrollment-phase');
  const audit = store.recordAudit(intent, first.audit);
  refuse(() => store.recordAudit(intent, first.audit), 'invalid-owner-enrollment-phase');
  refuse(() => store.confirm({ ...audit }, first.confirmation), 'invalid-owner-enrollment-phase');
  const active = store.confirm(audit, first.confirmation);
  assert.equal(active.state, 'active'); assert.equal(active.brokerLocalRevision, 1);
  for (const flag of ['authorizationSupported','protectedProducerAvailable','physicalAllocationSupported',
    'nativeFullFlushVerified','installationProvenanceVerified']) assert.equal(active[flag], false);
  const before = digestTree(root);
  assert.equal(store.beginIntent(null, first.record).duplicate, true);
  assert.deepEqual(digestTree(root), before);
  refuse(() => store.beginIntent(hash(first.record), first.record), 'owner-enrollment-conflict');
  const revoked = commit(store, triple(2, hash(first.record), hash(first.record)), hash(first.record));
  assert.equal(revoked.state, 'revoked'); store.close();
  const reopened = open(t, root);
  refuse(() => reopened.beginIntent(null, first.record), 'owner-enrollment-recovery-required');
  reopened.recoverConfirmed(); assert.equal(reopened.beginIntent(null, first.record).duplicate, true);
});

test('enrollment established open is read-only and refuses unknown, missing, replaced or corrupt custody', options, t => {
  const root = fixture(t), before = digestTree(root);
  const store = new Store(root); store.inspect(); store.close(); assert.deepEqual(digestTree(root), before);
  refuse(() => new Store(`${root}-absent`)); assert.equal(fs.existsSync(`${root}-absent`), false);
  fs.unlinkSync(path.join(root, '.journal-lock')); refuse(() => new Store(root));
  assert.equal(fs.existsSync(path.join(root, '.journal-lock')), false);
  fs.writeFileSync(path.join(root, '.journal-lock'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'unknown'), '', { mode: 0o600 }); refuse(() => new Store(root));
  fs.unlinkSync(path.join(root, 'unknown'));
  const target = slotPath(root, 1, 'record'); fs.renameSync(target, `${target}.old`);
  fs.symlinkSync(`${target}.old`, target); refuse(() => new Store(root));
  fs.unlinkSync(target); fs.renameSync(`${target}.old`, target);
  const live = open(t, root); live.recoverConfirmed();
  const data = fs.readFileSync(target); fs.unlinkSync(target); fs.writeFileSync(target, data, { mode: 0o600 });
  refuse(() => live.inspect());
});

test('existing-only lock cannot create after a raced complete store removal and file opens are nonblocking', options, t => {
  const root = fixture(t); let removed = false;
  const io = { ...fs, lstatSync(file, opts) {
    if (!removed && file === path.join(root, '.journal-lock')) {
      removed = true;
      for (const child of fs.readdirSync(root)) fs.rmSync(path.join(root, child), { recursive: true });
    }
    return fs.lstatSync(file, opts);
  }};
  assert.throws(() => acquireOwnerJournalLock(root, { io, createIfEmpty: false }), { message: 'owner-journal-storage-failed' });
  assert.deepEqual(fs.readdirSync(root), []);
  const populated = fixture(t), flags = [];
  const checked = open(t, populated, { io: { ...fs, openSync(file, mode, ...rest) {
    if (typeof mode === 'number' && !fs.lstatSync(file).isDirectory()) flags.push(mode);
    return fs.openSync(file, mode, ...rest);
  }}});
  checked.recoverConfirmed(); commit(checked, triple());
  assert.ok(flags.length > 3072);
  assert.ok(flags.every(f => (f & fs.constants.O_NONBLOCK) && (f & fs.constants.O_NOFOLLOW)));
});

test('single-slot publication never verifies an unrelated same-inode valid rewrite', options, t => {
  const root = fixture(t), first = triple(); seed(root, first, 1);
  let changed = false;
  const store = open(t, root, { fault(point) {
    if (!changed && point === 'record:trailer-flushed') {
      changed = true;
      // A different *valid* complete history, with the same head record digest,
      // would require changed audit evidence to fail the codec. Instead inject
      // a future complete valid record chain: chain validity alone allows it.
      const second = triple(2, hash(first.record), hash(first.record));
      const third = triple(3, hash(second.record)); seed(root, third, 3);
      for (const slot of BROKER_ENROLLMENT_SLOTS.filter(s => s.kind !== 'record')) fs.writeFileSync(slotPath(root, 2, slot.kind),
        encodeBrokerOwnerEnrollmentFrame(second[slot.kind], { kind: slot.kind, revision: 2, namespaceDigest }));
    }
  }});
  store.recoverConfirmed();
  refuse(() => store.beginIntent(hash(first.record), triple(2, hash(first.record), hash(first.record)).record));
  assert.equal(changed, true); refuse(() => store.inspect());
});

test('all publication flush refusals poison, close once, and retain visible uncertain bytes', options, t => {
  for (const phase of ['record','audit','confirmation']) for (const boundary of ['body-flushed','trailer-flushed']) {
    const root = fixture(t), entry = triple(); let fail = false;
    const store = open(t, root, { fault(point) { if (fail && point === `${phase}:${boundary}`) throw new Error('CANARY'); } });
    store.recoverConfirmed(); let handle;
    if (phase !== 'record') handle = store.beginIntent(null, entry.record);
    if (phase === 'confirmation') handle = store.recordAudit(handle, entry.audit);
    fail = true;
    refuse(() => phase === 'record' ? store.beginIntent(null, entry.record)
      : phase === 'audit' ? store.recordAudit(handle, entry.audit) : store.confirm(handle, entry.confirmation));
    refuse(() => store.inspect()); store.close();
    if (boundary === 'body-flushed') refuse(() => new Store(root));
    else {
      const next = new Store(root);
      try {
        assert.equal(next.inspect().completedRequestedFlush, false);
        if (phase !== 'confirmation') refuse(() => next.recoverConfirmed(), 'owner-enrollment-pending');
        else { next.recoverConfirmed(); assert.equal(next.beginIntent(null, entry.record).duplicate, true); }
      } finally { next.close(); }
    }
  }
});

test('actual fsync, short-I/O and uncertain-close refusals retain the fixed names and poison the instance', options, t => {
  for (const phase of ['record','audit','confirmation']) for (const operation of ['first-flush','second-flush','zero-write','close']) {
    const root = fixture(t), entry = triple(); let armed = false, flushes = 0, targetFd, closeAttempts = 0;
    const io = { ...fs,
      openSync(file, flags, ...rest) {
        const fd = fs.openSync(file, flags, ...rest);
        if (armed && file === slotPath(root, 1, phase) && (flags & fs.constants.O_RDWR)) targetFd = fd;
        return fd;
      },
      writeSync(fd, ...args) { if (armed && operation === 'zero-write' && fd === targetFd) return 0; return fs.writeSync(fd, ...args); },
      fsyncSync(fd) {
        if (armed && fd === targetFd && ++flushes === (operation === 'first-flush' ? 1 : operation === 'second-flush' ? 2 : -1)) {
          throw Object.assign(new Error('PRIVATE_CANARY'), { code: 'EIO' });
        }
        return fs.fsyncSync(fd);
      },
      closeSync(fd) {
        if (armed && fd === targetFd) {
          closeAttempts++; fs.closeSync(fd);
          if (operation === 'close') throw Object.assign(new Error('PRIVATE_CANARY'), { code: 'EIO' });
          return;
        }
        return fs.closeSync(fd);
      },
    };
    const store = new Store(root, { io }); store.recoverConfirmed(); let handle;
    if (phase !== 'record') handle = store.beginIntent(null, entry.record);
    if (phase === 'confirmation') handle = store.recordAudit(handle, entry.audit);
    const names = fs.readdirSync(root, { recursive: true }).sort(); armed = true;
    refuse(() => phase === 'record' ? store.beginIntent(null, entry.record)
      : phase === 'audit' ? store.recordAudit(handle, entry.audit) : store.confirm(handle, entry.confirmation));
    refuse(() => store.inspect()); store.close();
    assert.equal(closeAttempts, 1, `${phase}/${operation} must not retry uncertain close`);
    assert.deepEqual(fs.readdirSync(root, { recursive: true }).sort(), names);
  }
  const root = fixture(t); let armed = false;
  const store = new Store(root, { io: { ...fs, readSync(...args) { return armed ? 0 : fs.readSync(...args); } } });
  armed = true; refuse(() => store.inspect()); store.close();
});

test('recovery does not bless changed bytes and close attempts every owned descriptor once', options, t => {
  const root = fixture(t), entry = triple(); seed(root, entry, 1); let changed = false;
  const store = new Store(root, { fault(point) {
    if (!changed && point === 'recover:records/0001.record:flushed') {
      changed = true; seed(root, triple(2, hash(entry.record), hash(entry.record)), 2);
    }
  }});
  refuse(() => store.recoverConfirmed()); refuse(() => store.inspect()); store.close(); assert.equal(changed, true);
  const second = fixture(t), owned = new Set(), attempts = new Map(); let armed = false;
  const closing = new Store(second, { io: { ...fs,
    openSync(...args) { const fd = fs.openSync(...args); owned.add(fd); return fd; },
    closeSync(fd) {
      if (armed) attempts.set(fd, (attempts.get(fd) ?? 0) + 1);
      owned.delete(fd); fs.closeSync(fd);
      if (armed) throw new Error('PRIVATE_CANARY');
    },
  }});
  const remaining = new Set(owned); assert.equal(remaining.size, 5);
  armed = true; refuse(() => closing.close()); closing.close();
  assert.deepEqual(new Set(attempts.keys()), remaining);
  assert.ok([...attempts.values()].every(count => count === 1)); assert.equal(owned.size, 0);
});

test('partial positive reads/writes work but changed or malformed pending contexts cannot advance', options, t => {
  const root = fixture(t), first = triple();
  const store = open(t, root, { io: { ...fs,
    readSync(fd, content, offset, length, position) { return fs.readSync(fd, content, offset, Math.min(length, 79), position); },
    writeSync(fd, content, offset, length, position) { return fs.writeSync(fd, content, offset, Math.min(length, 71), position); },
  }});
  store.recoverConfirmed(); const handle = store.beginIntent(null, first.record);
  const wrong = JSON.parse(first.audit); wrong.transactionId = 'ffffffff-1111-4111-8111-111111111111';
  refuse(() => store.recordAudit(handle, bytes(wrong))); refuse(() => store.inspect()); store.close();
  const pending = open(t, root);
  assert.equal(pending.inspect().state, 'pending');
  refuse(() => pending.recordAudit(handle, first.audit), 'owner-enrollment-recovery-required');
  refuse(() => pending.recoverConfirmed(), 'owner-enrollment-pending');
  pending.close();
  const completeRoot = fixture(t), complete = open(t, completeRoot, { io: { ...fs,
    readSync(fd, b, o, n, p) { return fs.readSync(fd, b, o, Math.min(n, 83), p); },
    writeSync(fd, b, o, n, p) { return fs.writeSync(fd, b, o, Math.min(n, 67), p); },
  }});
  complete.recoverConfirmed(); assert.equal(commit(complete, first).state, 'active');
});

async function child(t, source, args) {
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { stdio: ['ignore','pipe','pipe'] });
  const terminal = once(processChild, 'close'); let output = '', timedOut = false;
  processChild.stdout.on('data', data => { output += data; if (output.length > 4096) processChild.kill('SIGKILL'); });
  processChild.stderr.on('data', data => { output += data; if (output.length > 4096) processChild.kill('SIGKILL'); });
  const timeout = setTimeout(() => { timedOut = true; processChild.kill('SIGKILL'); }, 15000);
  t.after(async () => { clearTimeout(timeout); if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill('SIGKILL'); await terminal; });
  const result = await terminal; clearTimeout(timeout); return { result, output, timedOut };
}
const storeUrl = new URL('../lib/broker/owner-enrollment-store.mjs', import.meta.url).href;
const fixtureUrl = new URL('./helpers/owner-enrollment-store-fixture.mjs', import.meta.url).href;

test('real process SIGKILL at every publication phase retains pending uncertainty until explicit confirmed recovery', options, async t => {
  for (const phase of ['record','audit','confirmation']) for (const boundary of ['header-written','body-written','body-flushed','trailer-written','trailer-flushed']) {
    const root = fixture(t), point = `${phase}:${boundary}`;
    const result = await child(t, `import { BrokerOwnerEnrollmentStore as Store } from ${JSON.stringify(storeUrl)};
      import { triple } from ${JSON.stringify(fixtureUrl)}; import { writeSync } from 'node:fs';
      const store = new Store(process.argv[1], { fault(p) { if(p===process.argv[2]) { writeSync(1,'FAULT:'+p); process.kill(process.pid,'SIGKILL'); } } });
      store.recoverConfirmed(); const e=triple(),h=store.beginIntent(null,e.record),a=store.recordAudit(h,e.audit); store.confirm(a,e.confirmation);`, [root, point]);
    assert.equal(result.timedOut, false, point); assert.equal(result.output, `FAULT:${point}`);
    assert.deepEqual(result.result, [null, 'SIGKILL'], `${point}: ${result.output}`);
    if (!boundary.startsWith('trailer')) { refuse(() => new Store(root)); continue; }
    const next = new Store(root);
    try {
      const view = next.inspect(); assert.equal(view.completedRequestedFlush, false);
      refuse(() => next.beginIntent(null, triple().record), 'owner-enrollment-recovery-required');
      if (phase === 'confirmation') {
        assert.equal(view.state, 'active'); next.recoverConfirmed();
        assert.equal(next.beginIntent(null, triple().record).duplicate, true);
      } else { assert.equal(view.state, 'pending'); refuse(() => next.recoverConfirmed(), 'owner-enrollment-pending'); }
    } finally { next.close(); }
  }
});

test('real second process cannot enter a store while fixed lock lifetime is held', options, async t => {
  const root = fixture(t), store = open(t, root);
  const result = await child(t, `import { BrokerOwnerEnrollmentStore as Store } from ${JSON.stringify(storeUrl)};
    try { new Store(process.argv[1]); process.exitCode=2; } catch(e) { console.log(e.message); }`, [root]);
  assert.equal(result.timedOut, false); assert.deepEqual(result.result, [0, null]); assert.equal(result.output.trim(), 'owner-enrollment-busy');
  store.close(); const reopened = open(t, root); assert.equal(reopened.inspect().state, 'empty');
});

test('finite complete chain retains terminal revocation and refuses any new transaction at capacity', options, t => {
  const root = fixture(t); let previous = null, activeDigest = null, last;
  for (let revision = 1; revision <= 1024; revision++) {
    last = triple(revision, previous, activeDigest); seed(root, last, revision); previous = hash(last.record);
    if (revision % 2) activeDigest = previous;
  }
  const store = open(t, root); assert.equal(store.inspect().state, 'revoked'); store.recoverConfirmed();
  assert.equal(store.beginIntent(JSON.parse(last.record).previousDigest, last.record).duplicate, true);
  const changed = JSON.parse(last.record); changed.transactionId = 'ffffffff-1111-4111-8111-111111111111';
  refuse(() => store.beginIntent(previous, bytes(changed)), 'owner-enrollment-capacity');
  assert.equal(store.inspect().brokerLocalRevision, 1024);
});
