import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import mutableFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createNativeOwnerObserverFixture, createNativeOwnerObserver } from '../lib/platform/owner-observer-native.mjs';
import { createFixtureEnrollmentGuard, createFixedEnrollmentGuard } from '../lib/platform/owner-enrollment-guard.mjs';
import { SyntheticOwnerReceiptCapability } from '../lib/broker/owner-receipt-fixture.mjs';
import { fixture } from './helpers/owner-coordinator.mjs';
import { observerSource } from './helpers/owner-observer-source.mjs';
import { f } from './helpers/owner-decision-lifecycle.mjs';
const binary=process.env.COMMS_OWNER_OBSERVER_FIXTURE_BINARY;
const options={skip:process.platform!=='darwin'||!binary,timeout:120000};
const hash=b=>createHash('sha256').update(b).digest('hex');
function setup(t, journalOptions={}, hooks={}, coordinatorOptions={}) {
  const broker=generateKeyPairSync('ed25519'),presence=generateKeyPairSync('ed25519'),namespaceDigest='c'.repeat(64);
  const source=observerSource(t,broker.publicKey,presence.publicKey,namespaceDigest);
  const observer=createNativeOwnerObserverFixture({binary,binarySha256:hash(fs.readFileSync(binary)),syntheticFixture:true});
  const guard=createFixtureEnrollmentGuard({...source,observer,syntheticFixture:true});
  let signCalls=0;
  class Signer extends SyntheticOwnerReceiptCapability {
    observe(){const g=guard.open();try{return g.snapshot;}finally{g.close();}}
    startDecisionReceipt(command,args){signCalls++;return super.startDecisionReceipt(command,args);}
  }
  const assertUnlocked=()=>{const fd=fs.openSync(`${source.sourceRoot}/.journal-lock`,fs.constants.O_RDWR|fs.constants.O_NONBLOCK|0x20);fs.closeSync(fd);};
  const x=fixture(t,f.positive[0],journalOptions,{fixtureKeys:{broker,presence,namespaceDigest},enrollmentGuard:guard,...coordinatorOptions,
    makeSigningCapability:e=>new Signer(e,{syntheticFixture:true,beforeSign:async signal=>{assertUnlocked();await hooks.beforeSign?.(signal);},beforeTerminal:async signal=>{assertUnlocked();await hooks.beforeTerminal?.(signal);}})});
  return {...x,source,guard,assertUnlocked,get signCalls(){return signCalls;}};
}
test('compiled 3072-slot observer guards prepare prepared async authorize release and never spans signer awaits',options,async t=>{
  const x=setup(t),times=[];
  for(const [name,operation] of [['prepare',()=>x.prepare()],['prepared',()=>x.prepared()],['confirm',()=>x.confirm()],['check',()=>x.check()]]){
    const start=performance.now(),result=await operation();times.push([name,Math.round(performance.now()-start)]);
    x.assertUnlocked();if(name==='confirm')assert.equal(result.state,'authorized');if(name==='check')assert.equal(result.mayApply,true);
  }
  t.diagnostic(JSON.stringify({real3072SlotPhaseMilliseconds:times,unchangedSignerDeadlineMilliseconds:10000,unchangedObserverDeadlineMilliseconds:8000}));
  assert.equal(x.signCalls,1);assert.equal(x.check().mayApply,false);
});
test('fresh postflush source replacement prevents first decision dispatch and preserves spent authorization',options,async t=>{
  let x,changed=false;
  x=setup(t,{fault:point=>{if(point==='authorization:fixed-verified'&&!changed){changed=true;const file=`${x.source.sourceRoot}/records/0001.record`;const b=fs.readFileSync(file);b[128]^=1;fs.writeFileSync(file,b);}}});
  x.prepare();x.prepared();await assert.rejects(x.confirm());
  assert.equal(changed,true);assert.equal(x.journal.read(x.action.requestId).state,'authorized');
  assert.equal(x.socket.events.filter(e=>e.event==='owner-decision').length,0);assert.equal(x.signCalls,1);
  try{await x.confirm();}catch{}assert.equal(x.signCalls,1);x.assertUnlocked();
});
test('postflush release observation failure returns no apply and retains durable indeterminate release',options,async t=>{
  let x,changed=false;
  x=setup(t,{fault:point=>{if(point==='release:fixed-verified'&&!changed){changed=true;const name=`${x.source.sourceRoot}/.journal-lock`;fs.renameSync(name,`${name}.old`);fs.writeFileSync(name,Buffer.alloc(0),{mode:0o600});}}});
  x.prepare();x.prepared();await x.confirm();assert.equal(x.check().mayApply,false);
  assert.equal(changed,true);const row=x.journal.read(x.action.requestId);assert.equal(row.state,'indeterminate');assert.equal(row.slots.has('release'),true);
  try{assert.equal(x.check().mayApply,false);}catch{}assert.equal(x.signCalls,1);
});
test('guard keeps inherited lock across repeated child exits, and auth rejection starts no scan',options,t=>{
  const x=setup(t),g=x.guard.open();
  assert.throws(()=>fs.openSync(`${x.source.sourceRoot}/.journal-lock`,fs.constants.O_RDWR|fs.constants.O_NONBLOCK|0x20));
  assert.deepEqual(g.observe(),g.snapshot);g.close();g.close();x.assertUnlocked();assert.throws(()=>g.observe());
  // Corrupt storage: any native observation would now refuse. Authentication
  // must retain its original error without consulting that source.
  fs.writeFileSync(`${x.source.sourceRoot}/records/0001.record`,Buffer.from('bad'));
  assert.throws(()=>x.core.prepare({...x.prepareRequest,auth:{principal:x.action.principal,secret:'wrong'}}),e=>e.code==='unauthenticated');
});
test('a scan that exhausts original attempt deadline starts no signer and never receives a renewed budget',options,async t=>{
  const x=setup(t,{}, {}, {signingTimeoutMilliseconds:1});x.prepare();x.prepared();
  await assert.rejects(x.confirm());assert.equal(x.signCalls,0);assert.equal(x.journal.read(x.action.requestId).slots.has('presence'),true);x.assertUnlocked();
  try{await x.confirm();}catch{}assert.equal(x.signCalls,0);
});
test('unknown parent descriptor close poisons provider and never retries that close implicitly',options,t=>{
  const x=setup(t),g=x.guard.open(),original=mutableFs.closeSync;let owned,attempts=0;
  try{
    mutableFs.closeSync=fd=>{owned=fd;attempts++;throw new Error('injected unknown close');};syncBuiltinESMExports();
    assert.throws(()=>g.close());assert.throws(()=>x.guard.open());g.close();assert.equal(attempts,1);
  }finally{mutableFs.closeSync=original;syncBuiltinESMExports();if(owned!==undefined)original(owned);}
  x.assertUnlocked();
});
test('actual unsigned normal artifact refuses and normal constructor never accepts fixture input',{
  ...options,skip:options.skip||!process.env.COMMS_OWNER_OBSERVER_NORMAL_BINARY
},t=>{
  const x=setup(t),normal=process.env.COMMS_OWNER_OBSERVER_NORMAL_BINARY;
  const observer=createNativeOwnerObserver({binary:normal,binarySha256:hash(fs.readFileSync(normal))});
  assert.throws(()=>createFixedEnrollmentGuard(createNativeOwnerObserverFixture({binary,binarySha256:hash(fs.readFileSync(binary)),syntheticFixture:true})));
  const fd=fs.openSync(`${x.source.sourceRoot}/.journal-lock`,fs.constants.O_RDWR|fs.constants.O_NONBLOCK|0x20);
  try{assert.throws(()=>observer.observe(fd,x.source));assert.throws(()=>observer.observe(fd));assert.ok(fs.fstatSync(fd).isFile());}
  finally{fs.closeSync(fd);}x.assertUnlocked();
});
test('artifact mutation and oversized artifacts refuse before launch while caller lock descriptor stays owned',options,t=>{
  const x=setup(t),copy=`${x.root}/observer-copy`;
  fs.copyFileSync(binary,copy);fs.chmodSync(copy,0o500);
  const observer=createNativeOwnerObserverFixture({binary:copy,binarySha256:hash(fs.readFileSync(copy)),syntheticFixture:true});
  fs.chmodSync(copy,0o700);const artifactFd=fs.openSync(copy,fs.constants.O_WRONLY);fs.writeSync(artifactFd,Buffer.from([0]),0,1,0);fs.closeSync(artifactFd);fs.chmodSync(copy,0o500);
  const fd=fs.openSync(`${x.source.sourceRoot}/.journal-lock`,fs.constants.O_RDWR|fs.constants.O_NONBLOCK|0x20);
  try{assert.throws(()=>observer.observe(fd,{bootstrap:x.source.bootstrap,rootFd:x.source.rootFd}));assert.ok(fs.fstatSync(fd).isFile());}
  finally{fs.closeSync(fd);}x.assertUnlocked();
  const large=`${x.root}/observer-large`;fs.writeFileSync(large,'x',{mode:0o700});fs.truncateSync(large,32*1024*1024+1);
  assert.throws(()=>createNativeOwnerObserverFixture({binary:large,binarySha256:'a'.repeat(64),syntheticFixture:true}));
});
test('actual observer watchdog termination poisons launcher and never releases inherited parent descriptor',{
  ...options,skip:options.skip||!process.env.COMMS_OWNER_OBSERVER_STUCK_BINARY
},t=>{
  const x=setup(t),stuck=process.env.COMMS_OWNER_OBSERVER_STUCK_BINARY;
  const observer=createNativeOwnerObserverFixture({binary:stuck,binarySha256:hash(fs.readFileSync(stuck)),syntheticFixture:true});
  const fd=fs.openSync(`${x.source.sourceRoot}/.journal-lock`,fs.constants.O_RDWR|fs.constants.O_NONBLOCK|0x20),input={bootstrap:x.source.bootstrap,rootFd:x.source.rootFd};
  try{
    const start=performance.now();assert.throws(()=>observer.observe(fd,input));assert.ok(performance.now()-start>=7500);
    assert.ok(fs.fstatSync(fd).isFile());assert.throws(()=>fs.openSync(`${x.source.sourceRoot}/.journal-lock`,fs.constants.O_RDWR|fs.constants.O_NONBLOCK|0x20));
    const next=performance.now();assert.throws(()=>observer.observe(fd,input));assert.ok(performance.now()-next<1000);
  }finally{fs.closeSync(fd);}x.assertUnlocked();
});
test('duplicate prepared authenticates cheaply but invalid source prevents even a journal transition call',options,t=>{
  const x=setup(t);x.prepare();const request=x.preparedRequest();x.core.prepared(request);const before=x.journal.read(x.action.requestId).slots.get('prepared-challenge');let calls=0;
  const record=x.journal.recordPrepared.bind(x.journal);x.journal.recordPrepared=(...args)=>{calls++;return record(...args);};
  fs.writeFileSync(`${x.source.sourceRoot}/records/0001.record`,Buffer.from('bad'));
  assert.throws(()=>x.core.prepared(request));assert.equal(calls,0);
  assert.deepEqual(x.journal.read(x.action.requestId).slots.get('prepared-challenge'),before);x.assertUnlocked();
});
