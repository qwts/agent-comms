import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { OwnerDecisionJournalStore as Store } from '../lib/owner-decision-journal.mjs';
import { ownerDecisionJournalError } from '../lib/owner-decision-journal-errors.mjs';
import { encodeOwnerJournalFrame } from '../lib/owner-decision-journal-frame.mjs';
import { lifecycleInput, config, namespaceDigest, bytes, f } from './helpers/owner-decision-lifecycle.mjs';
const darwin = { skip: process.platform !== 'darwin', timeout: 120000 };
const input = lifecycleInput();
const id = input.action.requestId;
const open = (dir, options = {}) => new Store(dir, { namespaceDigest, format: 'fixed-v1', lifecycle: configKeys(),
  now: () => input.acceptance.acceptedAt * 1000, ...options });
const configKeys = () => ({ brokerPublicKeys: config.brokerPublicKeys, presencePublicKeys: config.presencePublicKeys });
const reject = (fn, message) => assert.throws(fn, { message });
const file = (dir, slot) => path.join(dir, 'requests', id, `${slot}.record`);
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-lifecycle-journal-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
const steps = [
  ['prepare', 'prepared', s => s.recordPrepared(id, input.slots.get('prepared-challenge'))],
  ['authorize', 'authorized', s => s.recordAuthorization(id, { presenceBytes: input.slots.get('presence'),
    receiptBytes: input.slots.get('receipt'), authorizationBytes: input.slots.get('authorization') })],
  ['release', 'released', s => s.recordRelease(id, input.slots.get('release'))],
  ['outcome', 'indeterminate', s => s.recordOutcome(id, input.slots.get('initial-outcome'))],
  ['observe', 'indeterminate', s => s.recordObservation(id, input.slots.get('observation-reference'))],
  ['resolve', 'applied', s => s.recordResolution(id, input.slots.get('terminal-reference'))],
];
function prefix(dir, length, options) {
  const s = open(dir, options); s.admit(input.slots.get('original-action'), input.slots.get('acceptance'));
  for (const [, , run] of steps.slice(0, length)) run(s); return s;
}
function children(t) {
  const active = new Set();
  t.after(async () => { await Promise.all([...active].map(async child => {
    const done = once(child, 'close'); child.kill('SIGKILL'); await done;
  })); });
  return async source => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_BOT_ID: '', QWTS_AGENT_ID: '', AGENT_BOT_BINDING: '' } });
    active.add(child); let output = '', total = 0, timedOut = false;
    const capture = chunk => { total += chunk.length; if (total <= 16384) output += chunk; else child.kill('SIGKILL'); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
    try { const [code, signal] = await once(child, 'close'); assert.equal(timedOut, false); assert(total <= 16384); return { code, signal, output }; }
    finally { clearTimeout(timer); active.delete(child); }
  };
}
const journalUrl = new URL('../lib/owner-decision-journal.mjs', import.meta.url).href;
const helperUrl = new URL('./helpers/owner-decision-lifecycle.mjs', import.meta.url).href;
function childSource(dir, step, event) {
  return `import { OwnerDecisionJournalStore as Store } from ${JSON.stringify(journalUrl)};
    import { lifecycleInput, config, namespaceDigest } from ${JSON.stringify(helperUrl)};
    const i=lifecycleInput(), id=i.action.requestId;
    const s=new Store(${JSON.stringify(dir)},{namespaceDigest,format:'fixed-v1',lifecycle:{brokerPublicKeys:config.brokerPublicKeys,presencePublicKeys:config.presencePublicKeys},now:()=>i.acceptance.acceptedAt*1000,
      fault:at=>{if(at===${JSON.stringify(event)})process.kill(process.pid,'SIGKILL')}});
    s.recover(id);
    ${[
      "s.recordPrepared(id,i.slots.get('prepared-challenge'))",
      "s.recordAuthorization(id,{presenceBytes:i.slots.get('presence'),receiptBytes:i.slots.get('receipt'),authorizationBytes:i.slots.get('authorization')})",
      "s.recordRelease(id,i.slots.get('release'))", "s.recordOutcome(id,i.slots.get('initial-outcome'))",
      "s.recordObservation(id,i.slots.get('observation-reference'))", "s.recordResolution(id,i.slots.get('terminal-reference'))",
    ][step]}; process.exit(42);`;
}

test('typed fixed storage extends the same inodes through the graph and returns no live permit', darwin, t => {
  for (const vector of f.positive) {
    const i = lifecycleInput(vector), requestId = i.action.requestId, dir = temporary(t);
    const s = open(dir); s.admit(i.slots.get('original-action'), i.slots.get('acceptance'));
    const names = fs.readdirSync(path.join(dir, 'requests', requestId));
    const inodes = names.map(name => fs.statSync(path.join(dir, 'requests', requestId, name)).ino);
    const run = [() => s.recordPrepared(requestId, i.slots.get('prepared-challenge')),
      () => s.recordAuthorization(requestId, { presenceBytes: i.slots.get('presence'), receiptBytes: i.slots.get('receipt'), authorizationBytes: i.slots.get('authorization') }),
      () => s.recordRelease(requestId, i.slots.get('release')), () => s.recordOutcome(requestId, i.slots.get('initial-outcome')),
      () => s.recordObservation(requestId, i.slots.get('observation-reference')), () => s.recordResolution(requestId, i.slots.get('terminal-reference'))];
    for (let n = 0; n < run.length; n++) {
      const r = run[n](); assert.equal(r.state, steps[n][1]); assert.equal(r.duplicate, false);
      assert.equal(r.authorizationSupported, false); assert.equal(r.physicalAllocationSupported, false); assert.equal(Object.hasOwn(r, 'mayApply'), false);
      assert.equal(run[n]().duplicate, true); assert.equal(s.read(requestId).state, steps[n][1]);
    }
    assert.equal(run[0]().state, 'applied'); // Late duplicate never rewinds the graph.
    assert.deepEqual(fs.readdirSync(path.join(dir, 'requests', requestId)), names);
    assert.deepEqual(names.map(name => fs.statSync(path.join(dir, 'requests', requestId, name)).ino), inodes);
    const view = s.read(requestId); view.slots.get('release').fill(0); assert.equal(s.read(requestId).state, 'applied');
    reject(() => new Store(dir, { namespaceDigest, format: 'fixed-v1' }), 'owner-journal-unsupported-phase');
  }
});

test('reopened phases require explicit recovery before duplicate acknowledgment or next publication', darwin, t => {
  const dir = temporary(t); prefix(dir, 1); const s = open(dir);
  assert.equal(s.read(id).state, 'prepared'); assert.equal(s.read(id).finding, 'admission-visible');
  reject(() => steps[0][2](s), 'owner-journal-recovery-required'); reject(() => steps[1][2](s), 'owner-journal-recovery-required');
  assert.equal(s.recover(id).state, 'prepared'); assert.equal(steps[0][2](s).duplicate, true);
  assert.equal(steps[1][2](s).state, 'authorized');
  const changed = bytes({ ...input.authorization, exp: input.authorization.exp + 1 });
  reject(() => s.recordAuthorization(id, { presenceBytes: input.slots.get('presence'), receiptBytes: input.slots.get('receipt'), authorizationBytes: changed }), 'owner-journal-conflict');
});

test('invalid graph and expired live proofs are refused before writes; terminal/observation are immutable', darwin, t => {
  const dir = temporary(t); let now = input.acceptance.acceptedAt * 1000;
  const s = prefix(dir, 0, { now: () => now });
  reject(() => steps[2][2](s), 'owner-journal-conflict');
  reject(() => s.recordPrepared(id, bytes({ ...input.prepared, stage: {} })), 'owner-journal-input-invalid');
  assert.equal(s.read(id).state, 'preparing'); assert.equal(s.read(id).slots.size, 2);
  steps[0][2](s); now = input.vector.receiptPayload.exp * 1000;
  reject(() => steps[1][2](s), 'owner-journal-input-invalid'); assert.equal(s.read(id).slots.size, 3);
  now = input.acceptance.acceptedAt * 1000; steps[1][2](s);
  now = input.vector.receiptPayload.exp * 1000;
  reject(() => steps[2][2](s), 'owner-journal-input-invalid'); assert.equal(s.read(id).state, 'authorized');
  now = input.acceptance.acceptedAt * 1000; for (const [, , run] of steps.slice(2)) run(s);
  reject(() => s.recordObservation(id, bytes({ ...input.reference, evidenceDigest: 'e'.repeat(64) })), 'owner-journal-conflict');
  reject(() => s.recordResolution(id, bytes({ ...input.reference, finding: 'refused' })), 'owner-journal-conflict');
  assert.equal(s.read(id).state, 'applied');
});

test('all later publication crash points retain typed prefixes or freeze torn frames without authority', darwin, async t => {
  const runChild = children(t); let crashes = 0;
  for (let n = 0; n < steps.length; n++) {
    const measureDir = temporary(t), events = [];
    const measure = prefix(measureDir, n, { fault: at => events.push(at) }); events.length = 0; steps[n][2](measure);
    assert.equal(events.length, n === 1 ? 18 : n === 4 ? 14 : 6);
    for (const event of events) {
      const dir = temporary(t); prefix(dir, n);
      const result = await runChild(childSource(dir, n, event));
      assert.deepEqual(result, { code: null, signal: 'SIGKILL', output: '' }, event); crashes++;
      let s;
      try { s = open(dir); } catch (error) { assert.equal(error.message, 'owner-journal-corrupt', event); continue; }
      assert.equal(s.read(id).finding, 'admission-visible'); assert.equal(s.read(id).authorizationSupported, false);
      reject(() => steps[n][2](s), 'owner-journal-recovery-required'); s.recover(id);
      const saved = s.read(id);
      if (n === 4 && saved.observation.finding === 'quarantined') {
        reject(() => s.recoverObservation(id), 'owner-journal-recovery-required');
        assert.equal(steps[5][2](s).state, 'applied');
      } else if (n === 4 && saved.observation.finding === 'pending') {
        s.recoverObservation(id); assert.equal(steps[n][2](s).duplicate, true);
      } else if (n === 1 && !saved.slots.has('authorization')) {
        assert.equal(saved.state, 'prepared'); reject(() => steps[n][2](s), 'owner-journal-id-spent');
      } else assert.equal(steps[n][2](s).duplicate, true);
    }
  }
  assert.equal(crashes, 56);
});

test('EIO/ENOSPC/EDQUOT at each later flush never acknowledges; valid visibility needs recovery', darwin, t => {
  for (let n = 0; n < steps.length; n++) for (const code of ['EIO', 'ENOSPC', 'EDQUOT']) {
    const flushes = n === 1 ? 6 : n === 4 ? 5 : 2;
    for (let selected = 1; selected <= flushes; selected++) {
      const dir = temporary(t); prefix(dir, n); let calls = 0, armed = false;
      const s = open(dir, { io: { ...fs, fsyncSync: fd => {
        if (armed && ++calls === selected) { const e = new Error('secret-canary'); e.code = code; throw e; }
        return fs.fsyncSync(fd);
      } } }); s.recover(id); armed = true;
      reject(() => steps[n][2](s), 'owner-journal-storage-failed'); reject(() => s.inspect(), 'owner-journal-reopen-required');
      try { const r = open(dir); assert.equal(r.read(id).finding, 'admission-visible'); reject(() => steps[n][2](r), 'owner-journal-recovery-required'); r.recover(id); }
      catch (error) { assert.equal(error.message, 'owner-journal-corrupt'); }
    }
  }
});

test('recovery rechecks complete typed graph, every inode, unknown names, and changed bytes', darwin, t => {
  for (const mutate of [
    dir => fs.writeFileSync(file(dir, 'presence'), encodeOwnerJournalFrame(Buffer.from('p1.invalid.invalid'), { slot: 'presence', requestId: id, namespaceDigest })),
    dir => fs.writeFileSync(path.join(dir, 'requests', id, 'unknown'), '', { mode: 0o600 }),
    dir => { const name = file(dir, 'release'), b = fs.readFileSync(name); fs.renameSync(name, name + '.old'); fs.writeFileSync(name, b, { mode: 0o600 }); fs.unlinkSync(name + '.old'); },
  ]) {
    const dir = temporary(t); prefix(dir, 3); let changed = false;
    const s = open(dir, { fault: at => { if (at === 'recovery:parent-directory-flushed' && !changed) { changed = true; mutate(dir); } } });
    reject(() => s.recover(id), 'owner-journal-corrupt'); reject(() => s.inspect(), 'owner-journal-reopen-required');
  }
  const dir = temporary(t), s = prefix(dir, 3), name = file(dir, 'release'), saved = fs.readFileSync(name);
  fs.renameSync(name, name + '.old'); fs.writeFileSync(name, saved, { mode: 0o600 }); fs.unlinkSync(name + '.old');
  assert.equal(s.read(id).finding, 'admission-visible'); reject(() => steps[2][2](s), 'owner-journal-recovery-required');
  assert.equal(s.recover(id).state, 'released'); assert.equal(steps[2][2](s).duplicate, true);
});

test('fixed error mapping is sanitized and never invents outcome state', () => {
  for (const [message, code] of [['owner-journal-input-invalid', 'bad-request'], ['owner-journal-conflict', 'conflict'],
    ['owner-journal-id-spent', 'conflict'], ['owner-journal-capacity', 'journal-capacity'], ['owner-journal-unsupported-phase', 'owner-decision-unsupported'],
    ['owner-journal-corrupt', 'storage-failed'], ['owner-journal-recovery-required', 'storage-failed'], ['secret-canary', 'storage-failed']]) {
    const result = ownerDecisionJournalError(new Error(message)); assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes('secret-canary'), false); assert.equal(Object.hasOwn(result, 'state'), false);
  }
});
