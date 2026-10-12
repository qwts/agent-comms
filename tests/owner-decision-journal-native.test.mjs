import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireOwnerJournalLock } from '../lib/platform/owner-journal-lock.mjs';
import { OwnerDecisionAdmissionStore as OriginalStore } from '../lib/owner-decision-journal.mjs';
import { OWNER_JOURNAL_FIXED_SLOTS } from '../lib/owner-decision-journal-frame.mjs';
import { lifecycleInput, config, bytes as lifecycleBytes } from './helpers/owner-decision-lifecycle.mjs';
const darwin = { skip: process.platform !== 'darwin', timeout: 30000 };
const namespaceDigest = 'a'.repeat(64), hash = b => createHash('sha256').update(b).digest('hex');
const allSlots = [...OWNER_JOURNAL_FIXED_SLOTS, { slot: 'scratch', cap: 32768 }];
const actionBytes = Buffer.from(JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/v1.json', import.meta.url))).positive[0].actionJson);
const action = JSON.parse(actionBytes), requestId = action.requestId;
const canonical = v => v && typeof v === 'object' ? Array.isArray(v) ? `[${v.map(canonical)}]`
  : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const acceptanceBytes = Buffer.from(canonical({ v: 1, kind: 'acceptance', requestId, principal: action.principal,
  account: action.account, soul: action.soul, operation: action.operation, payloadDigest: hash(actionBytes), namespaceDigest,
  acceptedAt: 2000000000, daemonKey: 'b'.repeat(64), daemonEpoch: 1,
  watchId: '11111111-1111-4111-8111-111111111111', reservationBytes: 262144 }));
let build, binary, highFdWrapper;
before(() => {
  if (process.platform !== 'darwin') return;
  build = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-native-build-')); fs.chmodSync(build, 0o700);
  binary = path.join(build, 'helper');
  const c = spawnSync('/usr/bin/clang', ['-std=c11','-Wall','-Wextra','-Werror','-mmacosx-version-min=13.0',
    fileURLToPath(new URL('../lib/platform/native/owner-journal-darwin-helper.c', import.meta.url)), '-o', binary],
  { encoding: 'utf8', timeout: 15000, maxBuffer: 16384 });
  assert.equal(c.error, undefined); assert.equal(c.status, 0, c.stderr); fs.chmodSync(binary, 0o700);
  highFdWrapper = path.join(build, 'high-fd-wrapper'); const wrapper = highFdWrapper + '.c';
  fs.writeFileSync(wrapper, '#include <sys/stat.h>\n#include <sys/resource.h>\n#include <unistd.h>\nint main(int argc,char **argv){struct stat s;if((argc!=2&&argc!=3)||dup2(17,65537)!=65537||fstat(65537,&s))return 70;if(argc==3){struct rlimit r;if(getrlimit(RLIMIT_NOFILE,&r))return 73;r.rlim_cur=4096;if(setrlimit(RLIMIT_NOFILE,&r))return 74;}if(write(1,"H",1)!=1)return 71;char *args[]={argv[1],0};execv(argv[1],args);return 72;}\n');
  const w = spawnSync('/usr/bin/clang', ['-std=c11','-Wall','-Wextra','-Werror',wrapper,'-o',highFdWrapper],
    {encoding:'utf8',timeout:15000,maxBuffer:16384}); assert.equal(w.error,undefined); assert.equal(w.status,0,w.stderr);

});
after(() => { if (build) fs.rmSync(build, { recursive: true, force: true }); });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-native-fixture-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(new URL('../lib/', import.meta.url), path.join(root, 'lib'), { recursive: true });
  const native = path.join(root, 'lib/platform/native'), executable = path.join(native, `owner-journal-darwin-helper-${process.arch}`);
  fs.copyFileSync(binary, executable); fs.chmodSync(executable, 0o700);
  const manifestPath = executable + '.json';
  const manifest = { v: 1, platform: 'darwin', architecture: process.arch, minimumMacOS: '13.0',
    sourceSha256: hash(fs.readFileSync(path.join(native, 'owner-journal-darwin-helper.c'))),
    binarySha256: hash(fs.readFileSync(executable)), compiler: 'isolated-test /usr/bin/clang', sdk: 'installed SDK; deployment target is not runtime proof' };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const { OwnerDecisionAdmissionStore: Store } = await import(pathToFileURL(path.join(root, 'lib/owner-decision-journal.mjs')));
  const state = path.join(root, 'state'); fs.mkdirSync(state, { mode: 0o700 });
  return { root, state, Store, native, executable, manifestPath, manifest };
}
const open = (f, extra = {}) => new f.Store(f.state, { namespaceDigest, format: 'fixed-v1', nativeBridge: true, ...extra });
const reject = (fn, message) => assert.throws(fn, { message });

test('native bridge allocates eleven actual final inodes and full-flushes admission/recovery without authority claims', darwin, async t => {
  const f = await fixture(t), s = open(f);
  assert.equal(s.admit(actionBytes, acceptanceBytes).duplicate, false);
  const dir = path.join(f.state, 'requests', requestId), identities = [];
  for (const { slot, cap } of allSlots) {
    const st = fs.statSync(path.join(dir, `${slot}.record`)); identities.push(st.ino);
    assert.equal(st.size, cap + 256); assert(st.blocks * 512 >= cap + 256); assert.equal(st.nlink, 1);
  }
  assert.equal(new Set(identities).size, 11);
  const reopened = open(f); assert.equal(reopened.read(requestId).finding, 'admission-visible');
  reject(() => reopened.admit(actionBytes, acceptanceBytes), 'owner-journal-recovery-required');
  assert.equal(reopened.recover(requestId).finding, 'admission-complete');
  assert.equal(reopened.admit(actionBytes, acceptanceBytes).duplicate, true);
  assert.equal(reopened.inspect().physicalAllocationSupported, false); assert.equal(reopened.inspect().authorizationSupported, false);
});
test('native retained-mirror publication and recovery bind scratch11 EOF33024 and destination9 EOF2304 without file-fsync fallback', darwin, async t => {
  const f = await fixture(t), i = lifecycleInput(); let armed = false;
  const extra = { lifecycle: { brokerPublicKeys: config.brokerPublicKeys, presencePublicKeys: config.presencePublicKeys },
    now: () => i.acceptance.acceptedAt * 1000, io: { ...fs, fsyncSync: fd => {
      if (armed) assert(fs.fstatSync(fd).isDirectory(), 'native slot flush must not fall back to Node file fsync');
      return fs.fsyncSync(fd);
    } } };
  const s = open(f, extra), id = i.action.requestId;
  s.admit(i.slots.get('original-action'), i.slots.get('acceptance')); s.recordPrepared(id, i.slots.get('prepared-challenge'));
  s.recordAuthorization(id, { presenceBytes: i.slots.get('presence'), receiptBytes: i.slots.get('receipt'), authorizationBytes: i.slots.get('authorization') });
  s.recordRelease(id, i.slots.get('release')); s.recordOutcome(id, i.slots.get('initial-outcome')); armed = true;
  for (let n = 1; n <= 2; n++) assert.equal(s.recordObservation(id, lifecycleBytes({ ...i.reference, at: n })).generation, n);
  const dir = path.join(f.state, 'requests', id), d = fs.readFileSync(path.join(dir, 'observation-reference.record'));
  const saved = fs.readFileSync(path.join(dir, 'scratch.record'));
  assert.equal(d.length, 2304); assert.equal(saved.length, 33024); assert(saved.subarray(0, 2304).equals(d)); assert(saved.subarray(2304).every(b => b === 0));
  const interrupted = Buffer.from(d); interrupted.fill(0, 2176);
  fs.writeFileSync(path.join(dir, 'observation-reference.record'), interrupted);
  const reopened = open(f, extra); reopened.recover(id);
  assert.equal(reopened.read(id).observation.finding, 'pending');
  assert.equal(reopened.recoverObservation(id).generation, 2); assert.equal(reopened.inspect().physicalAllocationSupported, false);
  assert(fs.readFileSync(path.join(dir, 'observation-reference.record')).equals(d));
});

test('missing or untrusted pinned artifacts refuse before journal creation; no PATH/runtime compiler fallback', darwin, async t => {
  for (const mutate of [
    f => fs.unlinkSync(f.executable), f => fs.chmodSync(f.executable, 0o722),
    f => fs.writeFileSync(f.manifestPath, JSON.stringify({ ...f.manifest, binarySha256: '0'.repeat(64) })),
    f => fs.appendFileSync(path.join(f.native, 'owner-journal-darwin-helper.c'), '/* changed */'),
    f => fs.writeFileSync(f.manifestPath, JSON.stringify({ ...f.manifest, extra: true })),
    f => fs.linkSync(f.executable, f.executable + '.alias'), f => fs.chmodSync(f.executable,0o4700),
  ]) {
    const f = await fixture(t); mutate(f); reject(() => open(f), 'owner-journal-native-unavailable');
    assert.deepEqual(fs.readdirSync(f.state), []);
  }
});

test('artifact bytes and inode revalidated after construction; interrupted native initialization stays charged', darwin, async t => {
  for (const mutate of [
    f=>fs.appendFileSync(f.executable,Buffer.from([0])),
    f=>fs.writeFileSync(f.manifestPath,JSON.stringify({...f.manifest,compiler:'changed provenance'})),
    f=>{const name=path.join(f.native,'owner-journal-darwin-helper.c');const saved=fs.readFileSync(name);fs.unlinkSync(name);fs.writeFileSync(name,saved,{mode:0o600});},
  ]) {
    const f = await fixture(t), s = open(f); mutate(f);
    reject(() => s.admit(actionBytes, acceptanceBytes), 'owner-journal-storage-failed');
    reject(() => s.inspect(), 'owner-journal-reopen-required');
    const old = new OriginalStore(f.state, { namespaceDigest, format: 'fixed-v1' });
    assert.equal(old.inspect().retainedIds, 1); assert.equal(old.inspect().logicalReservedBytes, 262144);
    assert.equal(old.read(requestId).finding, 'orphan');
    reject(() => old.admit(actionBytes, acceptanceBytes), 'owner-journal-id-spent');
  }
});

test('cleanup attempts every owned descriptor once after close failure and poisons the instance', darwin, async t => {
  for (const kind of ['directory', 'slot']) {
    const f = await fixture(t); let injected = false, armed = false, injectArmed = false; const targets = new Set(), attempted = new Map();
    const io = { ...fs, openSync: (name, flags, ...rest) => {
      const fd = fs.openSync(name, flags, ...rest);
      if (armed && (kind === 'directory' ? injectArmed && (name === f.state || name === path.join(f.state, 'requests', requestId))
        : name.startsWith(path.join(f.state, 'requests', requestId)) && (flags & fs.constants.O_CREAT))) targets.add(fd);
      return fd;
    }, closeSync: fd => {
      if (targets.has(fd)) { attempted.set(fd, (attempted.get(fd) ?? 0) + 1);
        if (injectArmed && !injected) { injected = true; fs.closeSync(fd); throw Object.assign(new Error('private close canary'), { code: 'EIO' }); } }
      return fs.closeSync(fd);
    } };
    const s = open(f, { io, fault: at => { if (at === 'initialize:native-names-flushed') injectArmed = true; } }); armed = true;
    reject(() => s.admit(actionBytes, acceptanceBytes), 'owner-journal-storage-failed');
    assert.equal(injected, true); assert.equal(targets.size, kind === 'directory' ? 2 : 11);
    for (const fd of targets) { assert.equal(attempted.get(fd), 1); assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' }); }
    reject(() => s.inspect(), 'owner-journal-reopen-required');
  }
});

function direct(f, mutate = () => {}, inputMutate = () => {}, noMutation = true) {
  new OriginalStore(f.state, { namespaceDigest, format: 'fixed-v1' });
  const dir = path.join(f.state, 'requests', requestId); fs.mkdirSync(dir, { mode: 0o700 });
  const lock = acquireOwnerJournalLock(f.state), store = fs.openSync(f.state, fs.constants.O_RDONLY), request = fs.openSync(dir, fs.constants.O_RDONLY);
  const slots = allSlots.map(({ slot }) => fs.openSync(path.join(dir, `${slot}.record`), 'wx+', 0o600));
  try {
    mutate({ dir, slots, store, request, lock, state: f.state });
    const initialSizes = slots.map(fd => fs.fstatSync(fd).size);
    const input = Buffer.alloc(65); input.write('ODJNAT01'); input[8] = 1; input.write(requestId, 16); input[64] = 0xa5;
    const child = spawnSync(f.executable, [], { input: inputMutate(input) ?? input, stdio: ['pipe','pipe','pipe',lock,store,request,...slots],
      env: {}, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 512 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 1);
    assert.equal(child.stderr.length, 0); assert([32,64].includes(child.stdout.length));
    assert.equal(child.stdout.at(-24), 2); assert.equal(child.stdout.subarray(-32,-24).toString(), 'ODJNRES1');
    if (noMutation) slots.forEach((fd,index)=>assert.equal(fs.fstatSync(fd).size, initialSizes[index], 'refusal must precede mutation'));
    return child.stdout.subarray(-32);
  } finally { for (const fd of [...slots, request, store, lock]) fs.closeSync(fd); }
}
test('native helper rejects bad protocol, custody, name/inode and initial EOF before mutation', darwin, async t => {
  for (const mutation of [
    ({ dir }) => fs.chmodSync(dir, 0o755),
    ({ dir }) => { const name = path.join(dir, 'acceptance.record'); fs.renameSync(name, name + '.old'); fs.writeFileSync(name, '', { mode: 0o600 }); },
    ({ dir }) => fs.chmodSync(path.join(dir, 'receipt.record'), 0o644),
    ({ dir }) => fs.linkSync(path.join(dir, 'receipt.record'), path.join(dir, 'alias')),
    ({ slots }) => fs.ftruncateSync(slots[0],1),
    ({ dir, slots }) => { fs.closeSync(slots[0]);slots[0]=fs.openSync(path.join(dir,'acceptance.record'),'a+'); },
    ({ dir }) => { const name=path.join(dir,'receipt.record');fs.renameSync(name,name+'.old');fs.symlinkSync(name+'.old',name); },
    ({ state }) => fs.chmodSync(path.join(state,'requests'),0o755),
    ({ state }) => { fs.renameSync(path.join(state,'requests'),path.join(state,'old-requests'));fs.mkdirSync(path.join(state,'requests'),{mode:0o700}); },
  ]) direct(await fixture(t), mutation);
  for (const mutate of [b => { b[10] = 1; }, b => { b[30] = 53; }, b => { b[64] = 0; },
    b => b.subarray(0,64), b => Buffer.concat([b,Buffer.from([0])])]) direct(await fixture(t), undefined, mutate);
});

test('privileged current-owner artifact fixture smoke (does not exercise differing root/broker UIDs)', { ...darwin, skip: process.platform !== 'darwin' || process.getuid() !== 0 }, async t => {
  const f = await fixture(t); assert.equal(fs.statSync(f.executable).uid, 0); assert.equal(open(f).inspect().retainedIds, 0);
});

function emptyRequest(f) {
  new OriginalStore(f.state, { namespaceDigest, format: 'fixed-v1' });
  const dir = path.join(f.state, 'requests', requestId); fs.mkdirSync(dir, { mode: 0o700 });
  for (const { slot } of allSlots) fs.writeFileSync(path.join(dir, `${slot}.record`), '', { mode: 0o600 });
  return dir;
}
async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(10); }
  assert.fail(message);
}

test('parent death retains inherited open-description lock until stopped helper exits; no orphan mutation', darwin, async t => {
  const f = await fixture(t), dir = emptyRequest(f);
  const lockModule = new URL('../lib/platform/owner-journal-lock.mjs', import.meta.url).href;
  const source = `import * as fs from 'node:fs'; import {spawn} from 'node:child_process';
    import {acquireOwnerJournalLock} from ${JSON.stringify(lockModule)};
    const root=${JSON.stringify(f.state)}, dir=${JSON.stringify(dir)};
    const descriptors=[acquireOwnerJournalLock(root),fs.openSync(root,'r'),fs.openSync(dir,'r'),
      ...${JSON.stringify(allSlots.map(e => e.slot))}.map(slot=>fs.openSync(dir+'/'+slot+'.record','r+'))];
    const helper=spawn(${JSON.stringify(f.executable)},[],{stdio:['pipe',3,'ignore',...descriptors],env:{}});
    fs.closeSync(3); for(const fd of descriptors)fs.closeSync(fd);
    const header=Buffer.alloc(64);header.write('ODJNAT01');header[8]=1;header.write(${JSON.stringify(requestId)},16);
    helper.stdin.write(header); process.stdout.write(JSON.stringify({pid:helper.pid})+'\\n');`;
  const parent = spawn(process.execPath, ['--input-type=module','-e',source], { stdio: ['ignore','pipe','pipe','pipe'], env: {} });
  let helperPid, output = '', errors = '', responses = Buffer.alloc(0), terminal = false;
  const exited = once(parent, 'exit'), closed = once(parent, 'close').then(v => { terminal = true; return v; });
  const timer = setTimeout(() => { if (helperPid) { try { process.kill(helperPid, 'SIGKILL'); } catch {} } parent.kill('SIGKILL'); }, 10000);
  parent.stdout.on('data', b => { output += b; if (output.length > 512) parent.kill('SIGKILL'); });
  parent.stderr.on('data', b => { errors += b; if (errors.length > 512) parent.kill('SIGKILL'); });
  parent.stdio[3].on('data', b => { responses = Buffer.concat([responses,b]); if (responses.length > 64 && helperPid) process.kill(helperPid,'SIGKILL'); });
  t.after(async () => {
    clearTimeout(timer);
    if (!terminal) { if (helperPid) { try { process.kill(helperPid,'SIGKILL'); } catch {} } parent.kill('SIGKILL'); await closed; }
  });
  await until(() => output.includes('\n'), 'parent must report helper PID'); helperPid = JSON.parse(output).pid;
  assert(Number.isSafeInteger(helperPid) && helperPid > 1);
  await until(() => responses.length >= 32, 'helper READY deadline'); assert.equal(responses.length, 32); assert.equal(responses[8],0);
  process.kill(helperPid, 'SIGSTOP');
  await until(() => spawnSync('/bin/ps', ['-o','state=','-p',String(helperPid)], {encoding:'utf8',timeout:1000,maxBuffer:512}).stdout?.trim().startsWith('T'), 'helper stop observed');
  parent.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL');
  reject(() => acquireOwnerJournalLock(f.state), 'owner-journal-busy');
  for (const { slot } of allSlots) assert.equal(fs.statSync(path.join(dir,slot+'.record')).size,0);
  process.kill(helperPid,'SIGCONT'); await closed; clearTimeout(timer);
  assert.equal(errors, ''); assert.equal(responses.length,64); assert.equal(responses[40],2); assert.equal(responses[41],9);
  const fd = acquireOwnerJournalLock(f.state); fs.closeSync(fd);
  for (const { slot } of allSlots) assert.equal(fs.statSync(path.join(dir,slot+'.record')).size,0);
});

async function inheritedDescriptor(t, lower = false) {
  const f = await fixture(t), dir = emptyRequest(f), descriptors = [acquireOwnerJournalLock(f.state),fs.openSync(f.state,'r'),fs.openSync(dir,'r'),
    ...allSlots.map(({slot})=>fs.openSync(path.join(dir,slot+'.record'),'r+'))];
  const extra = fs.openSync(f.executable,'r'); const stdio = ['pipe','pipe','pipe',...descriptors,extra];
  let helper, closed, timer, terminal=false;
  t.after(async()=>{
    clearTimeout(timer);
    try { if(helper&&!terminal){helper.kill('SIGKILL');await closed;} }
    finally { for(const fd of [...descriptors,extra])fs.closeSync(fd); }
  });
  const start = performance.now(); helper = spawn(highFdWrapper,[f.executable,...(lower?['lower']:[])],{stdio,env:{}});
  let output=Buffer.alloc(0), errors=''; closed=once(helper,'close').then(v=>{terminal=true;return v;});
  helper.stdout.on('data',b=>{output=Buffer.concat([output,b]);if(output.length>65)helper.kill('SIGKILL');});
  helper.stderr.on('data',b=>{errors+=b;if(errors.length>512)helper.kill('SIGKILL');});
  timer=setTimeout(()=>helper.kill('SIGKILL'),10000);
  const header=Buffer.alloc(64);header.write('ODJNAT01');header[8]=1;header.write(requestId,16);helper.stdin.write(header);
  await until(()=>output.length>=33,'helper READY after closing high descriptor');
  assert.equal(output[0],72,'test-only exec wrapper proved descriptor65537 inherited before helper');
  assert.equal(output[9],0);assert.equal(output.length,33);
  const observed=spawnSync('/usr/sbin/lsof',['-a','-p',String(helper.pid),'-d','65537','-Ff'],{encoding:'utf8',timeout:2000,maxBuffer:1024});
  assert.equal(observed.error,undefined);assert([0,1].includes(observed.status));assert.equal(observed.stdout,'');assert.equal(observed.stderr,'');
  const known=spawnSync('/usr/sbin/lsof',['-a','-p',String(helper.pid),'-d','6','-Ff'],{encoding:'utf8',timeout:2000,maxBuffer:1024});
  assert.equal(known.error,undefined);assert.equal(known.status,0);assert(known.stdout.split('\n').includes('f6'));assert.equal(known.stderr,'');
  helper.stdin.end(Buffer.from([0xa5])); const [code,signal]=await closed;clearTimeout(timer);
  assert.equal(code,0);assert.equal(signal,null);assert.equal(errors,'');assert.equal(output.length,65);assert.equal(output[41],1);
  t.diagnostic(`helper exec + bounded actual descriptor enumeration + eleven allocations/full-flushes: ${(performance.now()-start).toFixed(1)}ms`);
}
test('helper closes actually inherited descriptor65537 while preserving all fixed descriptors', darwin, inheritedDescriptor);
test('helper closes inherited descriptor65537 even after soft limit lowered to4096', darwin, t=>inheritedDescriptor(t,true));

function faultArtifact(f, fault) {
  // Compile-time synthetic syscall failure only, never production source hooks.
  const prefix = path.join(f.root,'synthetic-fault.h');
  fs.writeFileSync(prefix, `#include <fcntl.h>\n#include <sys/stat.h>\n#include <stdarg.h>\n#include <errno.h>\n#include <unistd.h>\n
    static unsigned allocations; static int synthetic_fcntl(int fd,int command,...) {
      va_list args;va_start(args,command);int result;
      if(command==F_GETFL){va_end(args);return fcntl(fd,command);}
      if(command==F_SETFD){int value=va_arg(args,int);va_end(args);return fcntl(fd,command,value);}
      if(command==F_PREALLOCATE){void *value=va_arg(args,void*);va_end(args);allocations++;
        ${fault === 'allocate' ? 'if(allocations==2){errno=ENOSPC;return -1;}' : ''}return fcntl(fd,command,value);}
      int value=va_arg(args,int);va_end(args);
      ${fault === 'flush' ? 'if(command==F_FULLFSYNC){errno=EIO;return -1;}' : ''}
      ${fault === 'body-flush' ? 'struct stat st;if(command==F_FULLFSYNC&&fd==6&&fstat(fd,&st)==0&&st.st_size==33024){errno=EIO;return -1;}' : ''}
      result=fcntl(fd,command,value);return result;
    }
    #define fcntl synthetic_fcntl\n
    ${fault === 'directory-flush' ? 'static int synthetic_fsync(int fd){(void)fd;errno=EIO;return -1;}\n#define fsync synthetic_fsync\n' : ''}`);
  fs.unlinkSync(f.executable);
  const c=spawnSync('/usr/bin/clang',['-std=c11','-Wall','-Wextra','-Werror','-mmacosx-version-min=13.0','-include',prefix,
    path.join(f.native,'owner-journal-darwin-helper.c'),'-o',f.executable],{encoding:'utf8',timeout:15000,maxBuffer:16384});
  assert.equal(c.error,undefined);assert.equal(c.status,0,c.stderr);fs.chmodSync(f.executable,0o700);
  fs.writeFileSync(f.manifestPath,JSON.stringify({...f.manifest,binarySha256:hash(fs.readFileSync(f.executable)),compiler:'isolated-test clang with synthetic syscall failure'}));
}
test('native allocation/full-flush refusals retain exact diagnostics and charged partial prefixes without fallback', darwin, async t => {
  for (const [fault,stage,slot,errno] of [['allocate',3,2,28],['flush',5,1,5],['directory-flush',6,0,5]]) {
    const f=await fixture(t);faultArtifact(f,fault);const reply=direct(f,undefined,undefined,false);
    assert.equal(reply[9],stage);assert.equal(reply[10],slot);assert.equal(reply.readUInt32BE(12),errno);
    const partial=new OriginalStore(f.state,{namespaceDigest,format:'fixed-v1'});
    assert.equal(partial.inspect().retainedIds,1);assert.equal(partial.inspect().logicalReservedBytes,262144);
    assert.equal(partial.read(requestId).finding,'orphan');reject(()=>partial.admit(actionBytes,acceptanceBytes),'owner-journal-id-spent');
  }
  const f=await fixture(t);faultArtifact(f,'body-flush');const s=open(f);
  reject(()=>s.admit(actionBytes,acceptanceBytes),'owner-journal-storage-failed');reject(()=>s.inspect(),'owner-journal-reopen-required');
  const reopened=new OriginalStore(f.state,{namespaceDigest,format:'fixed-v1'});
  assert.equal(reopened.read(requestId).finding,'orphan');assert.equal(reopened.inspect().retainedIds,1);
});

test('native initialization/publication SIGKILL boundaries retain spent prefixes and require explicit recovery', { ...darwin, timeout: 120000 }, async t => {
  const points=[...allSlots.map(({slot})=>`initialize:${slot}:native-created`),'initialize:native-names-flushed',
    'initialize:native-completed','original-action:fixed-body-written','original-action:fixed-trailer-written',
    'acceptance:fixed-body-written','acceptance:fixed-trailer-written'];
  for (const point of points) {
    const f=await fixture(t);const moduleUrl=pathToFileURL(path.join(f.root,'lib/owner-decision-journal.mjs')).href;
    const source=`import{OwnerDecisionAdmissionStore as Store}from ${JSON.stringify(moduleUrl)};
      const s=new Store(${JSON.stringify(f.state)},{namespaceDigest:${JSON.stringify(namespaceDigest)},format:'fixed-v1',nativeBridge:true,
        fault:at=>{if(at===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL');}});
      s.admit(Buffer.from(${JSON.stringify(actionBytes.toString('base64'))},'base64'),Buffer.from(${JSON.stringify(acceptanceBytes.toString('base64'))},'base64'));process.exit(42);`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',source],{env:{},timeout:10000,killSignal:'SIGKILL',maxBuffer:512});
    assert.equal(child.error,undefined,point);assert.equal(child.signal,'SIGKILL',point);assert.equal(child.stdout.length,0);assert.equal(child.stderr.length,0);
    const s=open(f);assert.equal(s.inspect().retainedIds,1);assert.equal(s.inspect().logicalReservedBytes,262144);
    const r=s.read(requestId);assert.notEqual(r.finding,'admission-complete',point);
    if(r.finding==='admission-visible') {
      reject(()=>s.admit(actionBytes,acceptanceBytes),'owner-journal-recovery-required');
      assert.equal(s.recover(requestId).finding,'admission-complete');assert.equal(s.admit(actionBytes,acceptanceBytes).duplicate,true);
    } else { assert.equal(r.finding,'orphan',point);reject(()=>s.admit(actionBytes,acceptanceBytes),'owner-journal-id-spent'); }
  }
  t.diagnostic(`${points.length} actual SIGKILL boundaries`);
});

test('inherited limit above explicit one-million ceiling refuses before mutation', darwin, async t => {
  const f=await fixture(t), actual=path.join(f.root,'actual-helper');fs.renameSync(f.executable,actual);
  const wrapper=path.join(f.root,'limit-wrapper.c');
  fs.writeFileSync(wrapper,`#include <sys/resource.h>\n#include <unistd.h>\nint main(void){struct rlimit r;if(getrlimit(RLIMIT_NOFILE,&r))return 70;r.rlim_cur=1048577;if(setrlimit(RLIMIT_NOFILE,&r))return 71;char *args[]={${JSON.stringify(actual)},0};execv(args[0],args);return 72;}\n`);
  const c=spawnSync('/usr/bin/clang',['-std=c11','-Wall','-Wextra','-Werror',wrapper,'-o',f.executable],{encoding:'utf8',timeout:15000,maxBuffer:16384});
  assert.equal(c.error,undefined);assert.equal(c.status,0,c.stderr);fs.chmodSync(f.executable,0o700);
  const reply=direct(f);assert.equal(reply[9],1);assert.equal(reply.readUInt32BE(12),45);
});

test('publication and initialization never retry a descriptor after an uncertain close', darwin, async t => {
  for(const [format,nativeBridge,point] of [['scratch-v1',false,'action:file-flushed'],
    ['fixed-v1',false,'initialize:acceptance:flushed'],['fixed-v1',false,'original-action:fixed-trailer-flushed'],
    ['fixed-v1',true,'original-action:fixed-trailer-flushed']]) {
    const f=await fixture(t);let armed=false,failedFd,attempts=0;
    const io={...fs,closeSync:fd=>{
      if(armed&&failedFd===undefined){failedFd=fd;attempts++;fs.closeSync(fd);throw Object.assign(new Error('private close canary'),{code:'EIO'});}
      if(fd===failedFd){attempts++;assert.fail('unknown-close-state descriptor must not be retried');}
      return fs.closeSync(fd);
    }};
    const s=new f.Store(f.state,{namespaceDigest,format,nativeBridge,io,fault:at=>{if(at===point)armed=true;}});
    reject(()=>s.admit(actionBytes,acceptanceBytes),'owner-journal-storage-failed');assert.equal(attempts,1,point);
    reject(()=>s.inspect(),'owner-journal-reopen-required');
  }
});

test('saturated actual inherited descriptor list refuses before READY or mutation', darwin, async t => {
  const f=await fixture(t), actual=path.join(f.root,'actual-helper');fs.renameSync(f.executable,actual);
  const wrapper=path.join(f.root,'saturated-wrapper.c');
  fs.writeFileSync(wrapper,`#include <unistd.h>\nint main(void){for(int n=0;n<4097;n++)if(dup(6)<0)return 70;char *args[]={${JSON.stringify(actual)},0};execv(args[0],args);return 71;}\n`);
  const c=spawnSync('/usr/bin/clang',['-std=c11','-Wall','-Wextra','-Werror',wrapper,'-o',f.executable],{encoding:'utf8',timeout:15000,maxBuffer:16384});
  assert.equal(c.error,undefined);assert.equal(c.status,0,c.stderr);fs.chmodSync(f.executable,0o700);
  const reply=direct(f);assert.equal(reply[9],1);assert.equal(reply.readUInt32BE(12),os.constants.errno.EOVERFLOW);
});

test('adapter timeout confirms helper terminal before releasing lock and keeps orphan charged', { ...darwin, timeout: 30000 }, async t => {
  const f=await fixture(t), stub=path.join(f.root,'synthetic-timeout.c');
  fs.writeFileSync(stub,'#include <unistd.h>\nint main(void){sleep(60);return 0;}\n');fs.unlinkSync(f.executable);
  const c=spawnSync('/usr/bin/clang',['-std=c11','-Wall','-Wextra','-Werror',stub,'-o',f.executable],{encoding:'utf8',timeout:15000,maxBuffer:16384});
  assert.equal(c.error,undefined);assert.equal(c.status,0,c.stderr);fs.chmodSync(f.executable,0o700);
  fs.writeFileSync(f.manifestPath,JSON.stringify({...f.manifest,binarySha256:hash(fs.readFileSync(f.executable)),compiler:'isolated-test synthetic timeout binary'}));
  const s=open(f), start=performance.now();reject(()=>s.admit(actionBytes,acceptanceBytes),'owner-journal-storage-failed');
  assert(performance.now()-start>=9000);reject(()=>s.inspect(),'owner-journal-reopen-required');
  const lock=acquireOwnerJournalLock(f.state);fs.closeSync(lock);
  const recovered=new OriginalStore(f.state,{namespaceDigest,format:'fixed-v1'});
  assert.equal(recovered.inspect().retainedIds,1);assert.equal(recovered.read(requestId).finding,'orphan');
});
