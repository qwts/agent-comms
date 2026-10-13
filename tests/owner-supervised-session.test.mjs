import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { pairAccount } from './helpers/broker.mjs';
import { admin, call } from '../lib/client.mjs';
import { bytes } from './helpers/owner-decision-lifecycle.mjs';
import { bindInheritedOwnerSession } from '../lib/platform/owner-supervised-session.mjs';
const darwin = { skip: process.platform !== 'darwin', timeout: 10000 };
const config = { v: 1, kind: 'agent-comms-owner-broker-configuration', brokerStateDir: '/fixed/state', sharedDir: '/fixed', socketGroupGid: 20,
  brokerUid: process.getuid?.(), brokerAccountGuid: '02020202-0202-2202-8202-020202020202', ownerUid: (process.getuid?.() ?? 1) + 1,
  ownerAccountGuid: '01010101-0101-1101-8101-010101010101', namespaceDigest: 'c'.repeat(64) };
function observation(configOverride = config) {
  const config = configOverride;
  const hash = b => createHash('sha256').update(b).digest('hex');
  const key = n => { const raw = Buffer.alloc(32, n); return { alg: 'ed25519', keyId: hash(Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])), publicKey: raw.toString('base64url') }; };
  const installation = { v: 2, kind: 'geniusbar-native-installation', namespaceDigest: config.namespaceDigest, publicSocket: path.join(config.sharedDir,'broker.sock'),
    brokerUid: config.brokerUid, brokerAccountGuid: config.brokerAccountGuid, ownerUid: config.ownerUid, ownerAccountGuid: config.ownerAccountGuid,
    helperProtocol: 1, helperService: 'app.geniusbar.owner-admin', helperIdentifier: 'app.geniusbar.owner-admin', brokerLocalRevision: 1, brokerEnrollmentHeadDigest: 'd'.repeat(64) };
  const pins = { v: 2, kind: 'geniusbar-native-enrollment-pins', namespaceDigest: config.namespaceDigest, brokerLocalRevision: 1,
    brokerEnrollmentHeadDigest: installation.brokerEnrollmentHeadDigest, receiptKey: key(1), presenceKey: key(2), service: { platform: 'darwin', brokerUid: config.brokerUid } };
  const projection = bytes({ installation: bytes(installation).toString(), kind: 'geniusbar-native-cutover-inspection', pins: bytes(pins).toString(), v: 1 });
  return bytes({ custodyFingerprint: 'e'.repeat(64), kind: 'owner-enrollment-observation', observationDigest: hash(projection), projection: projection.toString('base64url'), v: 2 }).toString('base64url');
}
// Explicit synthetic parent tests the actual inherited client, not installed custody.
async function childCase(t, program, mutate = () => {}, expected = 0, fixtureConfig = config, watchdogMs = 5000) {
  const url = new URL('../lib/platform/owner-supervised-session.mjs', import.meta.url).href;
  // Node's synthetic stdio sockets start blocking. A short owned child sets
  // O_NONBLOCK on the shared open descriptions, matching the native contract.
  // Its handles disappear before the actual client uses these descriptors.
  const configure = `import net from 'node:net'; import fs from 'node:fs'; import assert from 'node:assert/strict'; for(const fd of [3,4]) { const s=new net.Socket({fd,readable:true,writable:true}); s.pause(); s._handle.setBlocking(false); s.unref(); } assert.throws(()=>fs.readSync(4,Buffer.alloc(1),0,1,null),error=>['EAGAIN','EWOULDBLOCK'].includes(error.code));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process'; const setup=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(configure)}],{env:{},stdio:['ignore','ignore','pipe',3,4],timeout:1000}); assert.equal(setup.status,0); assert.equal(setup.signal,null); assert.equal(setup.stderr.length,0); const { acquireInheritedOwnerSession, bindInheritedOwnerSession } = await import(${JSON.stringify(url)}); ${program}`],
    { env: { AGENT_COMMS_DIAGNOSTICS: 'off' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  const terminal = once(child, 'close');
  let timer = setTimeout(() => child.kill('SIGKILL'), watchdogMs);
  t.after(async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await terminal; });
  let output = '', pending = Buffer.alloc(0), sequence = 0, scope = null; const ops = [];
  child.stderr.on('data', b => { output += b; assert.ok(output.length <= 4096); });
  child.stdout.resume();
  child.stdio[4].on('error', error => assert.equal(error.code, 'EPIPE', 'only peer rejection may close the synthetic reply pipe'));
  child.stdio[3].on('data', chunk => {
    pending = Buffer.concat([pending, chunk]); assert.ok(pending.length <= 32772);
    while (pending.length >= 4 && pending.length >= pending.readUInt32BE(0) + 4) {
      const size = pending.readUInt32BE(0), body = pending.subarray(4, 4 + size), request = JSON.parse(body);
      pending = pending.subarray(4 + size);
      assert.deepEqual(body, bytes(request)); assert.equal(request.sequence, sequence++);
      assert.equal(request.session, request.op === 'hello' ? null : 'a'.repeat(32));
      assert.equal(Object.keys(request).join(','), 'op,scope,sequence,session,v'); ops.push(request.op);
      let encoded = null;
      if (request.op === 'open-observation-scope') { assert.equal(request.scope, null); scope = request.sequence; encoded = observation(fixtureConfig); }
      if (request.op === 'observe-current-scope') { assert.equal(request.scope, scope); encoded = observation(fixtureConfig); }
      if (request.op === 'close-observation-scope') { assert.equal(request.scope, scope); scope = null; }
      const reply = { configuration: request.op === 'hello' ? fixtureConfig : null, installation: 'b'.repeat(64), observation: encoded,
        op: request.op, scope, sequence: request.sequence, session: 'a'.repeat(32), v: 1 };
      const replacement = mutate(reply, request, child, terminal);
      if (replacement === false) continue;
      const data = Buffer.isBuffer(replacement) ? replacement : bytes(reply);
      const frame = Buffer.alloc(4 + data.length); frame.writeUInt32BE(data.length); data.copy(frame, 4);
      child.stdio[4].write(frame);
    }
  });
  const [code, signal] = await terminal; clearTimeout(timer);
  assert.equal(signal, null, output); assert.equal(code, expected, output); assert.equal(pending.length, 0);
  return ops;
}
test('unbranded caller object cannot attach session to a broker', () => {
  assert.throws(() => bindInheritedOwnerSession({}, { configuration: config }));
});
test('actual inherited pipes sequence native scopes and close; copied hello gives no activation', darwin, async t => {
  const ops = await childCase(t, `const s=acquireInheritedOwnerSession(); assert.equal(s.installationDigest,'b'.repeat(64)); assert.equal(s.installationProvenanceVerified,undefined); s.checkIdle(); const x=s.open(); assert.equal(x.snapshot.active,true); x.observe(); x.close(); x.close(); s.close(); s.close();`);
  assert.deepEqual(ops, ['hello', 'open-observation-scope', 'observe-current-scope', 'close-observation-scope', 'close-session']);
});
for (const mutation of ['extra', 'session', 'sequence', 'installation', 'scope', 'configuration', 'fixture', 'drift', 'noncanonical', 'oversize', 'eof']) {
  test(`inherited session poisons permanently on ${mutation}`, darwin, async t => {
    const ops = await childCase(t, `const s=acquireInheritedOwnerSession(); assert.throws(()=>s.open()); assert.throws(()=>s.open()); assert.throws(()=>s.close());`, (reply, request, child) => {
      if (request.op !== 'open-observation-scope') return;
      if (mutation === 'extra') reply.extra = true;
      if (mutation === 'session') reply.session = 'f'.repeat(32);
      if (mutation === 'sequence') reply.sequence++;
      if (mutation === 'installation') reply.installation = 'f'.repeat(64);
      if (mutation === 'scope') reply.scope++;
      if (mutation === 'configuration') reply.configuration = config;
      if (mutation === 'fixture') { const v=JSON.parse(Buffer.from(reply.observation,'base64url')); v.v=1; v.kind='owner-enrollment-observation-fixture'; reply.observation=bytes(v).toString('base64url'); }
      if (mutation === 'drift') { const v=JSON.parse(Buffer.from(reply.observation,'base64url')); const p=JSON.parse(Buffer.from(v.projection,'base64url')); const i=JSON.parse(p.installation); i.ownerAccountGuid='03030303-0303-3303-8303-030303030303'; p.installation=bytes(i).toString(); const b=bytes(p); v.projection=b.toString('base64url'); v.observationDigest=createHash('sha256').update(b).digest('hex'); reply.observation=bytes(v).toString('base64url'); }
      if (mutation === 'noncanonical') return Buffer.from(' '+bytes(reply));
      if (mutation === 'oversize') return Buffer.alloc(65537, 32);
      if (mutation === 'eof') { child.stdio[4].end(); return false; }
    });
    assert.deepEqual(ops, ['hello', 'open-observation-scope']);
  });
}
for (const [operation, bodyNumber, expiredAt] of [['hello',1,15000],['open',2,10000],['observe',3,10000],['close',3,10000]]) {
  test(`completed ${operation} reply at elapsed deadline is refused`, darwin, async t => {
    const program = `const {default:fs}=await import('node:fs'); const {syncBuiltinESMExports}=await import('node:module'); const {performance}=await import('node:perf_hooks'); let now=0,bodies=0; Object.defineProperty(performance,'now',{value:()=>now}); const original=fs.readSync; fs.readSync=function(fd,buffer,offset,length,...rest){const n=original(fd,buffer,offset,length,...rest); if(fd===4&&length>4&&n===length&&++bodies===${bodyNumber}) now=${expiredAt}; return n;}; syncBuiltinESMExports(); ${operation === 'hello' ? 'assert.throws(()=>acquireInheritedOwnerSession());' : `const s=acquireInheritedOwnerSession(); ${operation === 'open' ? 'assert.throws(()=>s.open());' : `const scope=s.open(); assert.throws(()=>scope.${operation}());`} assert.throws(()=>s.open()); assert.throws(()=>s.close());`}`;
    const ops=await childCase(t,program);
    assert.deepEqual(ops,operation==='hello'?['hello']:operation==='open'?['hello','open-observation-scope']:['hello','open-observation-scope',operation==='observe'?'observe-current-scope':'close-observation-scope']);
  });
}
test('active scope cannot nest or close session, and misuse poisons', darwin, async t => {
  await childCase(t, 'const s=acquireInheritedOwnerSession(); s.open(); assert.throws(()=>s.close()); assert.throws(()=>s.open());');
});
test('production factory closes actual native observation then refuses coordinator activation', darwin, async t => {
  const brokerUrl = new URL('../lib/broker.mjs', import.meta.url).href;
  const factoryUrl = new URL('../lib/broker/owner-decisions.mjs', import.meta.url).href;
  const ops = await childCase(t, `const {Broker}=await import(${JSON.stringify(brokerUrl)}); const {createProductionOwnerDecisionCoordinator}=await import(${JSON.stringify(factoryUrl)}); const s=acquireInheritedOwnerSession(); const b=new Broker({paths:{state:'/fixed/state',shared:'/fixed'},gid:20,mode:'group'}); bindInheritedOwnerSession(b,s); assert.throws(()=>createProductionOwnerDecisionCoordinator({broker:b}),{code:'owner-decision-unsupported'}); s.close();`);
  assert.deepEqual(ops, ['hello','open-observation-scope','observe-current-scope','close-observation-scope','close-session']);
});

test('idle launcher EOF is detected without an owner request', darwin, async t => {
  const ops = await childCase(t, `const s=acquireInheritedOwnerSession(); await new Promise(r=>setTimeout(r,50)); assert.throws(()=>s.checkIdle()); assert.throws(()=>s.open());`, (reply, request, child) => {
    if (request.op === 'hello') setTimeout(()=>child.stdio[4].end(), 10);
  });
  assert.deepEqual(ops, ['hello']);
});

test('dedicated entry starts an actual ordinary broker from inherited configuration and closes on SIGTERM', darwin, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'comms-supervised-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const shared=path.join(root,'shared'), state=path.join(root,'state');
  const fixtureConfig={...config,sharedDir:shared,brokerStateDir:state,socketGroupGid:process.getgid()};
  const entry = new URL('../bin/owner-supervised-broker.mjs', import.meta.url).href;
  // This synthetic composition exercises the real entry and ordinary ingress;
  // it is deliberately not root installation or native launcher acceptance.
  let work, workError;
  const ops = await childCase(t, `process.argv=[process.execPath,${JSON.stringify(fileURLToPath(new URL('../bin/owner-supervised-broker.mjs',import.meta.url)))}]; await import(${JSON.stringify(entry)});`, (reply, request, child, terminal)=>{
    if (request.op==='close-observation-scope' && !work) work=(async()=>{
      const paths={shared,state,socket:path.join(shared,'broker.sock'),proofs:path.join(shared,'pairing'),admin:path.join(state,'admin.sock')};
      // The existing owned child watchdog bounds startup. Observe readiness or
      // actual terminal, rather than assuming startup fits a one-second sleep.
      let ended=false;
      const stopped=terminal.then(()=>{ended=true; throw new Error('broker terminated before startup acceptance');});
      const ready=(async()=>{while(!ended&&!existsSync(paths.admin)) await new Promise(r=>setTimeout(r,10)); if(ended) throw new Error('broker terminated before readiness');})();
      await Promise.race([ready,stopped]);
      const paired=await pairAccount(paths,os.userInfo().username,process.getuid());
      await admin(paths,{op:'approve',code:paired.code});
      await call(paths,paired.credential,{op:'join',agentId:'agent_11111111-1111-4111-8111-111111111111'});
      assert.deepEqual((await call(paths,paired.credential,{op:'read',agentId:'agent_11111111-1111-4111-8111-111111111111'})).messages,[]);
      child.kill('SIGTERM');
    })().catch(error=>{workError=error;child.kill('SIGKILL');});
  },0,fixtureConfig);
  await work; assert.ifError(workError);
  assert.deepEqual(ops,['hello','open-observation-scope','observe-current-scope','close-observation-scope','close-session']);
});

for (const defect of ['delay', 'reject']) {
  test(`launcher EOF forces actual broker terminal and socket refusal despite stop ${defect}`, darwin, async t => {
    const root=mkdtempSync(path.join(os.tmpdir(),'comms-supervised-stop-'));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const shared=path.join(root,'shared'),state=path.join(root,'state');
    const fixtureConfig={...config,sharedDir:shared,brokerStateDir:state,socketGroupGid:process.getgid()};
    const brokerUrl=new URL('../lib/broker.mjs',import.meta.url).href;
    const entry=new URL('../bin/owner-supervised-broker.mjs',import.meta.url);
    let trigger;
    const ops=await childCase(t, `const {Broker}=await import(${JSON.stringify(brokerUrl)}); Broker.prototype.stop=${defect === 'delay' ? '()=>new Promise(()=>{})' : '()=>Promise.reject(new Error("synthetic-stop-refusal"))'}; process.argv=[process.execPath,${JSON.stringify(fileURLToPath(entry))}]; await import(${JSON.stringify(entry.href)});`, (reply,request,child)=>{
      if(request.op==='close-observation-scope'&&!trigger) trigger=(async()=>{
        for(let i=0;i<100&&!existsSync(path.join(shared,'broker.sock'));i++) await new Promise(r=>setTimeout(r,10));
        assert.ok(existsSync(path.join(shared,'broker.sock')));
        child.stdio[4].end();
        if(defect==='delay') { await new Promise(r=>setTimeout(r,300)); child.kill('SIGTERM'); }
      })();
    },1,fixtureConfig);
    await trigger;
    assert.deepEqual(ops,['hello','open-observation-scope','observe-current-scope','close-observation-scope']);
    await new Promise((resolve,reject)=>{
      const socket=net.createConnection(path.join(shared,'broker.sock'));
      const timer=setTimeout(()=>{socket.destroy();reject(new Error('socket refusal unconfirmed'));},500);
      socket.once('connect',()=>{clearTimeout(timer);socket.destroy();reject(new Error('ordinary ingress survived fatal exit'));});
      socket.once('error',error=>{clearTimeout(timer);socket.destroy();assert.ok(['ECONNREFUSED','ENOENT'].includes(error.code));resolve();});
    });
  });
}
for (const malformed of ['surrogate', 'negative-zero', 'bad-uid']) {
  test(`hello refuses ${malformed} before configuration is usable`,darwin,async t=>{
    const ops=await childCase(t,'assert.throws(()=>acquireInheritedOwnerSession());',(reply,request)=>{
      if(malformed==='surrogate') reply.configuration={...config,sharedDir:'/fixed/'+String.fromCharCode(0xd800)};
      if(malformed==='negative-zero') return Buffer.from(bytes(reply).toString().replace('"sequence":0','"sequence":-0'));
      if(malformed==='bad-uid') reply.configuration={...config,brokerUid:config.ownerUid};
    });
    assert.deepEqual(ops,['hello']);
  });
}

test('SIGTERM during awaited broker startup invokes owned stop and closes session',darwin,async t=>{
  const brokerUrl=new URL('../lib/broker.mjs',import.meta.url).href;
  const entry=new URL('../bin/owner-supervised-broker.mjs',import.meta.url);
  const ops=await childCase(t,`const {Broker}=await import(${JSON.stringify(brokerUrl)}); let hold; Broker.prototype.start=function(){hold=setInterval(()=>{},1000);return new Promise(()=>{});}; Broker.prototype.stop=async function(){assert.ok(hold);clearInterval(hold);}; process.argv=[process.execPath,${JSON.stringify(fileURLToPath(entry))}]; await import(${JSON.stringify(entry.href)});`,(reply,request,child)=>{
    if(request.op==='close-observation-scope') setTimeout(()=>child.kill('SIGTERM'),100);
  });
  assert.deepEqual(ops,['hello','open-observation-scope','observe-current-scope','close-observation-scope','close-session']);
});

test('partial nonblocking reply header/body progresses without resetting the exchange',darwin,async t=>{
  const ops=await childCase(t,'const s=acquireInheritedOwnerSession(); s.close();',(reply,request,child)=>{
    if(request.op!=='hello') return;
    const data=bytes(reply), frame=Buffer.alloc(4+data.length);frame.writeUInt32BE(data.length);data.copy(frame,4);
    child.stdio[4].write(frame.subarray(0,2));
    setTimeout(()=>{child.stdio[4].write(frame.subarray(2,7));setTimeout(()=>child.stdio[4].write(frame.subarray(7)),5);},5);
    return false;
  });
  assert.deepEqual(ops,['hello','close-session']);
});
for(const defect of ['observation-change','close-refusal']) {
  test(`native scope ${defect} permanently poisons the context`,darwin,async t=>{
    await childCase(t,`const s=acquireInheritedOwnerSession();const x=s.open();assert.throws(()=>x.${defect==='observation-change'?'observe':'close'}());assert.throws(()=>x.observe());assert.throws(()=>s.close());`,(reply,request)=>{
      if(defect==='observation-change'&&request.op==='observe-current-scope') {
        const v=JSON.parse(Buffer.from(reply.observation,'base64url'));v.custodyFingerprint='f'.repeat(64);reply.observation=bytes(v).toString('base64url');
      }
      if(defect==='close-refusal'&&request.op==='close-observation-scope') reply.scope=request.scope;
    });
  });
}
test('idle open reply pipe reaches the unchanged ten-second scope deadline and poisons', { ...darwin, timeout: 20000 }, async t=>{
  const ops=await childCase(t,'const s=acquireInheritedOwnerSession(); assert.throws(()=>s.open()); assert.throws(()=>s.open());',(_reply,request)=>request.op==='open-observation-scope'?false:undefined,0,config,15000);
  assert.deepEqual(ops,['hello','open-observation-scope']);
});
