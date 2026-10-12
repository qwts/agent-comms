import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { OwnerDecisionJournalStore as Store } from '../lib/owner-decision-journal.mjs';
import { encodeOwnerJournalFrame as encode, decodeOwnerJournalFrame as decode } from '../lib/owner-decision-journal-frame.mjs';
import { lifecycleInput, config, namespaceDigest, bytes } from './helpers/owner-decision-lifecycle.mjs';
const i = lifecycleInput(), id = i.action.requestId;
const D = 'observation-reference', S = 'scratch';
const darwin = { skip: process.platform !== 'darwin', timeout: 120000 };
const options = { namespaceDigest, format: 'fixed-v1', lifecycle: { brokerPublicKeys: config.brokerPublicKeys,
  presencePublicKeys: config.presencePublicKeys }, now: () => i.acceptance.acceptedAt * 1000 };
const open = (dir, extra = {}) => new Store(dir, { ...options, ...extra });
const reject = (fn, message) => assert.throws(fn, { message });
const file = (dir, slot) => path.join(dir, 'requests', id, `${slot}.record`);
const reference = n => bytes({ ...i.reference, evidenceDigest: n.toString(16).padStart(64, '0') });
const frame = (n, payload = reference(n)) => encode(payload, { namespaceDigest, requestId: id, slot: D, generation: n });
const scratch = f => { const out = Buffer.alloc(33024); f.copy(out); return out; };
const invalid = () => { const out = Buffer.alloc(2304); out[0] = 1; return out; };
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-owner-observation-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function prefix(dir, extra) {
  const s = open(dir, extra); s.admit(i.slots.get('original-action'), i.slots.get('acceptance'));
  s.recordPrepared(id, i.slots.get('prepared-challenge'));
  s.recordAuthorization(id, { presenceBytes: i.slots.get('presence'), receiptBytes: i.slots.get('receipt'), authorizationBytes: i.slots.get('authorization') });
  s.recordRelease(id, i.slots.get('release')); s.recordOutcome(id, i.slots.get('initial-outcome')); return s;
}
function install(dir, d, s) { fs.writeFileSync(file(dir, D), d); fs.writeFileSync(file(dir, S), s); }
function view(dir) { return [fs.readFileSync(file(dir, D)), fs.readFileSync(file(dir, S))]; }
function assertUnchanged(dir, before) { assert.deepEqual(view(dir), before); }
function state(dir, extra) { const s = open(dir, extra); assert.equal(s.read(id).finding, 'admission-visible'); s.recover(id); return s; }

test('replacement retains exact scratch mirrors, inodes/names/quotas, bounded generations and false authority flags', darwin, t => {
  const dir = temporary(t), s = prefix(dir), names = fs.readdirSync(path.dirname(file(dir, D))).sort();
  const identity = names.map(name => fs.statSync(path.join(path.dirname(file(dir, D)), name)).ino);
  for (let n = 1; n <= 3; n++) {
    const r = s.recordObservation(id, reference(n)); assert.equal(r.generation, n); assert.equal(r.duplicate, false);
    assert.equal(r.authorizationSupported, false); assert.equal(r.physicalAllocationSupported, false); assert.equal(Object.hasOwn(r, 'mayApply'), false);
    const [d, saved] = view(dir); assert(d.equals(frame(n))); assert(saved.equals(scratch(d)));
    assert.equal(s.recordObservation(id, reference(n)).duplicate, true);
    assert.deepEqual(s.read(id).observation, { finding: 'settled', generation: n });
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file(dir, D))).sort(), names);
  assert.deepEqual(names.map(name => fs.statSync(path.join(path.dirname(file(dir, D)), name)).ino), identity);
  assert.equal(s.inspect().logicalReservedBytes, 262144); assert.equal(s.inspect().retainedIds, 1);
  const before = view(dir); reject(() => s.recordObservation(id, bytes({ ...i.reference, finding: 'applied' })), 'owner-journal-input-invalid'); assertUnchanged(dir, before);
  reject(() => s.recordObservation(id, Buffer.alloc(2049, 65)), 'owner-journal-input-invalid'); assertUnchanged(dir, before);
});

test('complete matrix classifies exact content and only explicit copy recovery publishes a retained candidate', darwin, t => {
  const zero = Buffer.alloc(2304), zeroS = Buffer.alloc(33024), broken = invalid();
  const tornHeader = frame(5); tornHeader[128] ^= 1;
  const tail = scratch(frame(1)); tail[33023] = 1;
  const cases = [
    ['zero/zero', zero, zeroS, 'empty', null],
    ['first candidate', zero, scratch(frame(1)), 'pending', 1],
    ['first skips', zero, scratch(frame(2)), 'quarantined', null],
    ['legacy direct', frame(2), zeroS, 'settled', 2],
    ['mirror', frame(2), scratch(frame(2)), 'settled', 2],
    ['equal generation differs', frame(2), scratch(frame(2, reference(20))), 'quarantined', null],
    ['next', frame(2), scratch(frame(3)), 'pending', 3],
    ['older scratch', frame(2), scratch(frame(1)), 'quarantined', null],
    ['skipped scratch', frame(2), scratch(frame(4)), 'quarantined', null],
    ['invalid no header', broken, scratch(frame(8)), 'pending', 8],
    ['invalid header same', tornHeader, scratch(frame(5)), 'pending', 5],
    ['invalid header next', tornHeader, scratch(frame(6)), 'pending', 6],
    ['invalid header older', tornHeader, scratch(frame(4)), 'quarantined', null],
    ['invalid header skipped', tornHeader, scratch(frame(7)), 'quarantined', null],
    ['legacy torn clear', frame(2), scratch(broken), 'quarantined', null],
    ['invalid/zero', broken, zeroS, 'quarantined', null],
    ['invalid/invalid', broken, scratch(broken), 'quarantined', null],
    ['nonzero tail', frame(1), tail, 'quarantined', null],
  ];
  for (const [label, d, pending, finding, expected] of cases) {
    const dir = temporary(t); prefix(dir); install(dir, d, pending); const before = view(dir), s = open(dir);
    const read = s.read(id); assert.equal(read.state, 'indeterminate', label); assert.equal(read.observation.finding, finding, label);
    assert.equal(read.slots.has(D), finding === 'settled', label); assertUnchanged(dir, before);
    reject(() => s.recoverObservation(id), 'owner-journal-recovery-required'); s.recover(id); assertUnchanged(dir, before);
    if (finding === 'quarantined') {
      reject(() => s.recoverObservation(id), 'owner-journal-recovery-required');
      reject(() => s.recordObservation(id, reference(99)), 'owner-journal-recovery-required'); assertUnchanged(dir, before);
    } else {
      const r = s.recoverObservation(id); assert.equal(r.generation, expected, label);
      if (finding === 'pending') assert.deepEqual(view(dir), [pending.subarray(0, 2304), pending], label);
      else assertUnchanged(dir, before);
    }
    const retained = view(dir); assert.equal(s.recordResolution(id, i.slots.get('terminal-reference')).state, 'applied', label);
    assertUnchanged(dir, retained); reject(() => s.recoverObservation(id), 'owner-journal-conflict');
  }
});

test('quarantined and pending observation examples permit applied/refused terminal and permanently freeze copy/replacement', darwin, t => {
  for (const finding of ['applied', 'refused']) for (const [d, pending] of [
    [frame(1), scratch(invalid())], [invalid(), scratch(frame(7))],
    [frame(1), scratch(frame(1, reference(12)))], [Buffer.alloc(2304), scratch(frame(1))],
  ]) {
    const dir = temporary(t); prefix(dir); install(dir, d, pending); const before = view(dir), s = state(dir);
    const terminal = bytes({ ...i.reference, finding });
    assert.equal(s.recordResolution(id, terminal).state, finding); assertUnchanged(dir, before);
    reject(() => s.recoverObservation(id), 'owner-journal-conflict');
    assert.throws(() => s.recordObservation(id, reference(44))); assertUnchanged(dir, before);
    const reopened = state(dir); assert.equal(reopened.read(id).state, finding);
    assert.equal(reopened.recordResolution(id, terminal).duplicate, true); assertUnchanged(dir, before);
    reject(() => reopened.recoverObservation(id), 'owner-journal-conflict');
  }
});
test('same settled observation after terminal is a read-only duplicate, never a recovery copy or replacement', darwin, t => {
  const dir = temporary(t); let armed = false;
  const s = prefix(dir, { io: { ...fs, writeSync: (...args) => { assert.equal(armed, false); return fs.writeSync(...args); },
    fsyncSync: (...args) => { assert.equal(armed, false); return fs.fsyncSync(...args); } } });
  s.recordObservation(id, reference(1)); s.recordResolution(id, i.slots.get('terminal-reference'));
  const before = view(dir); armed = true;
  assert.deepEqual(s.recordObservation(id, reference(1)), { requestId: id, state: 'applied', duplicate: true,
    generation: 1, authorizationSupported: false, physicalAllocationSupported: false }); assertUnchanged(dir, before);
  reject(() => s.recordObservation(id, reference(2)), 'owner-journal-conflict');
  reject(() => s.recoverObservation(id), 'owner-journal-conflict'); assertUnchanged(dir, before);
});

test('quarantine never catches unsafe custody, unknown names, malformed immutable records or signatures', darwin, t => {
  for (const mutate of [
    dir => fs.chmodSync(file(dir, S), 0o644),
    dir => fs.writeFileSync(path.join(path.dirname(file(dir, D)), 'unknown'), '', { mode: 0o600 }),
    dir => { const b = fs.readFileSync(file(dir, 'receipt')); b[128] ^= 1; fs.writeFileSync(file(dir, 'receipt'), b); },
    dir => fs.writeFileSync(file(dir, 'presence'), encode(Buffer.from('p1.invalid.invalid'), { slot: 'presence', requestId: id, namespaceDigest })),
    dir => fs.writeFileSync(file(dir, 'terminal-reference'), encode(bytes({ ...i.reference, finding: 'indeterminate' }), { slot: 'terminal-reference', requestId: id, namespaceDigest })),
    dir => fs.truncateSync(file(dir, S), 33023),
    dir => { fs.unlinkSync(file(dir, S)); fs.symlinkSync(file(dir, D), file(dir, S)); },
    dir => fs.writeFileSync(file(dir, 'initial-outcome'), Buffer.alloc(4352)),
  ]) {
    const dir = temporary(t); prefix(dir); install(dir, frame(1), scratch(invalid())); mutate(dir);
    reject(() => open(dir), 'owner-journal-corrupt');
  }
});

test('candidate bindings, maximum generation, cached bytes/inodes and terminal evidence never weaken the graph', darwin, t => {
  for (const bad of [
    bytes({ ...i.reference, requestId: '22222222-2222-4222-8222-222222222222' }),
    bytes({ ...i.reference, payloadDigest: 'e'.repeat(64) }), bytes({ ...i.reference, originalDaemonEpoch: 2 }),
    bytes({ ...i.reference, auditId: i.reference.auditId + '\n' }), Buffer.from('{"v":1}'),
  ]) {
    const dir = temporary(t); prefix(dir); install(dir, invalid(), scratch(frame(1, bad)));
    assert.equal(state(dir).read(id).observation.finding, 'quarantined');
  }
  const dir = temporary(t); prefix(dir); const maximum = frame(Number.MAX_SAFE_INTEGER); install(dir, maximum, scratch(maximum));
  const s = state(dir), before = view(dir); assert.equal(s.recordObservation(id, reference(Number.MAX_SAFE_INTEGER)).duplicate, true);
  reject(() => s.recordObservation(id, reference(5)), 'owner-journal-conflict'); assertUnchanged(dir, before);
  reject(() => s.recordResolution(id, bytes({ ...i.reference, finding: 'refused', originalDaemonKey: 'e'.repeat(64) })), 'owner-journal-input-invalid'); assertUnchanged(dir, before);
  assert.equal(s.recordResolution(id, i.slots.get('terminal-reference')).state, 'applied');
  const cacheDir = temporary(t), cached = prefix(cacheDir); cached.recordObservation(id, reference(1));
  install(cacheDir, frame(2), scratch(frame(2))); assert.equal(cached.read(id).finding, 'admission-visible');
  reject(() => cached.recordObservation(id, reference(3)), 'owner-journal-recovery-required'); cached.recover(id);
  const name = file(cacheDir, S), saved = fs.readFileSync(name); fs.renameSync(name, name + '.old'); fs.writeFileSync(name, saved, { mode: 0o600 }); fs.unlinkSync(name + '.old');
  reject(() => cached.recordObservation(id, reference(3)), 'owner-journal-recovery-required');
  cached.recover(id); assert.equal(cached.recordObservation(id, reference(3)).generation, 3);
});

function children(t) {
  const active = new Set();
  t.after(async () => { await Promise.all([...active].map(async c => { const closed = once(c, 'close'); c.kill('SIGKILL'); await closed; })); });
  return async source => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', source], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
    active.add(c); let output = '', size = 0, timedOut = false;
    const capture = b => { size += b.length; if (size <= 16384) output += b; else c.kill('SIGKILL'); };
    c.stdout.on('data', capture); c.stderr.on('data', capture);
    const timer = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, 5000);
    try { const [code, signal] = await once(c, 'close'); assert.equal(timedOut, false); assert(size <= 16384); return { code, signal, output }; }
    finally { clearTimeout(timer); active.delete(c); }
  };
}
const journalUrl = new URL('../lib/owner-decision-journal.mjs', import.meta.url).href;
const inputUrl = new URL('./helpers/owner-decision-lifecycle.mjs', import.meta.url).href;
function childSource(dir, event, recovery) {
  return `import{OwnerDecisionJournalStore as Store}from ${JSON.stringify(journalUrl)};
    import{lifecycleInput,config,namespaceDigest,bytes}from ${JSON.stringify(inputUrl)};
    const i=lifecycleInput(),id=i.action.requestId,s=new Store(${JSON.stringify(dir)}, {namespaceDigest,format:'fixed-v1',
      lifecycle:{brokerPublicKeys:config.brokerPublicKeys,presencePublicKeys:config.presencePublicKeys},now:()=>i.acceptance.acceptedAt*1000,
      fault:at=>{if(at===${JSON.stringify(event)})process.kill(process.pid,'SIGKILL')}});s.recover(id);
    ${recovery ? 's.recoverObservation(id)' : "s.recordObservation(id,bytes({...i.reference,evidenceDigest:'2'.padStart(64,'0')}))"};process.exit(42);`;
}
test('actual SIGKILL at every first/replacement/recovery publication boundary preserves uncertainty and explicit terminal liveness', darwin, async t => {
  const run = children(t); let count = 0;
  for (const mode of ['first', 'replacement', 'recovery']) {
    const measured = temporary(t), measuredStore = prefix(measured); if (mode === 'replacement') measuredStore.recordObservation(id, reference(1));
    if (mode === 'recovery') install(measured, frame(1), scratch(frame(2)));
    const events = [], m = state(measured, { fault: at => { if (at.startsWith('observation:')) events.push(at); } });
    if (mode === 'recovery') m.recoverObservation(id); else m.recordObservation(id, reference(2));
    assert(events.length >= 9);
    for (const event of events) {
      const dir = temporary(t), start = prefix(dir); if (mode === 'replacement') start.recordObservation(id, reference(1));
      if (mode === 'recovery') install(dir, frame(1), scratch(frame(2)));
      assert.deepEqual(await run(childSource(dir, event, mode === 'recovery')), { code: null, signal: 'SIGKILL', output: '' }, event); count++;
      const s = open(dir); assert.equal(s.read(id).finding, 'admission-visible');
      reject(() => s.recordObservation(id, reference(3)), 'owner-journal-recovery-required');
      s.recover(id); const before = view(dir);
      if (s.read(id).observation.finding === 'pending') s.recoverObservation(id);
      else if (s.read(id).observation.finding === 'quarantined') reject(() => s.recoverObservation(id), 'owner-journal-recovery-required');
      if (s.read(id).observation.finding === 'quarantined') assertUnchanged(dir, before);
      const raw = view(dir); assert.equal(s.recordResolution(id, i.slots.get('terminal-reference')).state, 'applied'); assertUnchanged(dir, raw);
      assert.equal(s.read(id).authorizationSupported, false); assert.equal(s.inspect().logicalReservedBytes, 262144);
    }
  }
  t.diagnostic(`${count} actual SIGKILL observation boundaries`);
});
test('each observation write/flush failure retains charged bytes and terminal capacity without acknowledgement or fallback', darwin, t => {
  for (const mode of ['first', 'replacement', 'recovery']) {
    const prepare = dir => { const s = prefix(dir); if (mode === 'replacement') s.recordObservation(id, reference(1));
      if (mode === 'recovery') install(dir, frame(1), scratch(frame(2))); };
    const operation = s => mode === 'recovery' ? s.recoverObservation(id) : s.recordObservation(id, reference(2));
    const measured = temporary(t); prepare(measured); let armed = false, writes = 0, flushes = 0;
    const m = state(measured, { io: { ...fs, writeSync: (...args) => { if (armed) writes++; return fs.writeSync(...args); },
      fsyncSync: (...args) => { if (armed) flushes++; return fs.fsyncSync(...args); } } }); armed = true; operation(m);
    for (const kind of ['write', 'flush']) for (let selected = 1; selected <= (kind === 'write' ? writes : flushes); selected++) {
      for (const code of kind === 'write' ? ['EIO', 'ENOSPC', 'EDQUOT', 'zero', 'partial'] : ['EIO', 'ENOSPC', 'EDQUOT']) {
        const dir = temporary(t); prepare(dir); let count = 0, enabled = false, partial = false;
        const fault = original => (...args) => {
          if (enabled && (++count === selected || partial)) {
            if (code === 'zero') return 0;
            if (code === 'partial' && !partial) { partial = true; return fs.writeSync(args[0], args[1], args[2], Math.min(7, args[3]), args[4]); }
            const error = new Error('secret-canary'); error.code = code === 'partial' ? 'EIO' : code; throw error;
          }
          return original(...args);
        };
        const s = state(dir, { io: { ...fs, ...(kind === 'write' ? { writeSync: fault(fs.writeSync) } : { fsyncSync: fault(fs.fsyncSync) }) } }); enabled = true;
        reject(() => operation(s), 'owner-journal-storage-failed'); reject(() => s.read(id), 'owner-journal-reopen-required');
        const reopened = state(dir); assert.equal(reopened.inspect().retainedIds, 1); assert.equal(reopened.inspect().logicalReservedBytes, 262144);
        const raw = view(dir); assert.equal(reopened.recordResolution(id, i.slots.get('terminal-reference')).state, 'applied'); assertUnchanged(dir, raw);
      }
    }
  }
});
test('immutable or observation inode replacement during publication invalidates the complete snapshot', darwin, t => {
  for (const slot of ['release', D, S]) {
    const dir = temporary(t); prefix(dir); let changed = false;
    const s = state(dir, { fault: at => { if (changed || at !== 'observation:destination:verified') return; changed = true;
      const name = file(dir, slot), b = fs.readFileSync(name); fs.renameSync(name, name + '.old'); fs.writeFileSync(name, b, { mode: 0o600 }); fs.unlinkSync(name + '.old');
    } });
    reject(() => s.recordObservation(id, reference(1)), 'owner-journal-corrupt'); reject(() => s.inspect(), 'owner-journal-reopen-required');
    assert.equal(state(dir).read(id).state, 'indeterminate');
  }
});
