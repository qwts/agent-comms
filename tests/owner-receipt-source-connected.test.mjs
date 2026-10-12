// Explicit local integration: both native binaries scan the same fixture source.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createOwnerReceiptNativeSourceFixtureInvoker, encodeOwnerReceiptSourceFixtureFrame } from '../lib/platform/owner-receipt-native.mjs';
import { encodeOwnerReceiptNativeCommand } from '../lib/platform/owner-receipt-wire.mjs';
import { createNativeOwnerObserverFixture } from '../lib/platform/owner-observer-native.mjs';
import { createFixtureEnrollmentGuard } from '../lib/platform/owner-enrollment-guard.mjs';
import { SyntheticOwnerReceiptCapability } from '../lib/broker/owner-receipt-fixture.mjs';
import { fixture } from './helpers/owner-coordinator.mjs';
import { observerSource } from './helpers/owner-observer-source.mjs';
import { f } from './helpers/owner-decision-lifecycle.mjs';
const observerBinary=process.env.COMMS_OWNER_OBSERVER_SOURCE_FIXTURE_BINARY,receiptBinary=process.env.COMMS_OWNER_RECEIPT_SOURCE_FIXTURE_BINARY;
const options={skip:process.platform!=='darwin'||!observerBinary||!receiptBinary,timeout:300000};
const hash=b=>createHash('sha256').update(b).digest('hex');
const brokerPrivate=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,0x77)]),format:'der',type:'pkcs8'});
const broker={privateKey:brokerPrivate,publicKey:createPublicKey(brokerPrivate)};
function sourceSetup(t,keys=broker){
  const presence=generateKeyPairSync('ed25519'),namespaceDigest='c'.repeat(64);
  const source=observerSource(t,keys.publicKey,presence.publicKey,namespaceDigest);
  const observer=createNativeOwnerObserverFixture({binary:observerBinary,binarySha256:hash(fs.readFileSync(observerBinary)),syntheticFixture:true});
  const guard=createFixtureEnrollmentGuard({...source,observer,syntheticFixture:true});
  const assertUnlocked=()=>{const fd=fs.openSync(`${source.sourceRoot}/.journal-lock`,fs.constants.O_RDWR|fs.constants.O_NONBLOCK|0x20);fs.closeSync(fd);};
  return {source,guard,presence,namespaceDigest,keys,assertUnlocked};
}
function coordinator(t,s,vector=f.positive[0],hooks={}){
  let calls=0,lastCommand,lastTerminal=Promise.resolve({terminalConfirmed:true,safeClose:true});
  const invoker=createOwnerReceiptNativeSourceFixtureInvoker({binary:receiptBinary,binarySha256:hash(fs.readFileSync(receiptBinary)),...s.source,syntheticFixture:true});
  class ActualNativeSigner extends SyntheticOwnerReceiptCapability{
    observe(){const g=s.guard.open();try{return g.snapshot;}finally{g.close();}}
    startDecisionReceipt(command,args){
      calls++;lastCommand=command;s.assertUnlocked();hooks.beforeStart?.();
      const owned=invoker.startDecisionReceipt(command,args);lastTerminal=owned.terminal;
      hooks.started?.(owned);return owned;
    }
  }
  const x=fixture(t,vector,{}, {fixtureKeys:{broker:s.keys,presence:s.presence,namespaceDigest:s.namespaceDigest},enrollmentGuard:s.guard,
    makeSigningCapability:e=>new ActualNativeSigner(e,{syntheticFixture:true})});
  t.after(async()=>{x.core.close();assert.deepEqual(await lastTerminal,{terminalConfirmed:true,safeClose:true});});
  return {...x,get calls(){return calls;},get command(){return lastCommand;},terminal:()=>lastTerminal};
}
test('actual observer and receipt worker share scanned bindings for all eleven coordinator operations',options,async t=>{
  const s=sourceSetup(t),durations=[];
  for(const vector of f.positive){
    const x=coordinator(t,s,vector);x.prepare();x.prepared();const start=performance.now();
    assert.equal((await x.confirm()).state,'authorized');durations.push(Math.round(performance.now()-start));
    const g=s.guard.open();try{assert.equal(x.command.brokerEnrollmentHeadDigest,g.snapshot.brokerEnrollmentHeadDigest);assert.equal(x.command.observationDigest,g.snapshot.observationDigest);assert.notEqual(x.command.brokerEnrollmentHeadDigest,'d'.repeat(64));assert.notEqual(x.command.observationDigest,'e'.repeat(64));}finally{g.close();}
    const token=x.journal.read(x.action.requestId).slots.get('receipt').toString().split('.');
    assert.equal(verify(null,Buffer.from(token[1]),broker.publicKey,Buffer.from(token[2],'base64url')),true);
    assert.equal(x.calls,1);assert.equal(x.check().mayApply,true);assert.equal(x.check().mayApply,false);s.assertUnlocked();
  }
  t.diagnostic(JSON.stringify({actualNativeSigningPhaseMilliseconds:durations,signingDeadlineMilliseconds:10000,childDeadlineMilliseconds:8000}));
});
test('independent native signer lock refuses parent contention and retains one spent attempt',options,async t=>{
  const s=sourceSetup(t);let held;
  const x=coordinator(t,s,f.positive[0],{beforeStart(){held=fs.openSync(`${s.source.sourceRoot}/.journal-lock`,fs.constants.O_RDWR|fs.constants.O_NONBLOCK|0x20);}});
  x.prepare();x.prepared();try{await assert.rejects(x.confirm());await x.terminal();}finally{if(held!==undefined)fs.closeSync(held);}
  assert.equal(x.calls,1);assert.equal(x.journal.read(x.action.requestId).slots.has('receipt'),false);s.assertUnlocked();
});
test('scanned public key must equal compiled synthetic signing key',options,async t=>{
  const s=sourceSetup(t,generateKeyPairSync('ed25519')),x=coordinator(t,s);x.prepare();x.prepared();await assert.rejects(x.confirm());
  assert.equal(x.calls,1);assert.equal(x.journal.read(x.action.requestId).slots.has('authorization'),false);assert.equal(x.socket.events.filter(e=>e.event==='owner-decision').length,0);
});
test('actual source worker rejects wrong binding malformed frame extra bytes and caller selectors',options,async t=>{
  const s=sourceSetup(t),x=coordinator(t,s);x.prepare();x.prepared();await x.confirm();
  const command=encodeOwnerReceiptNativeCommand(x.command),good=encodeOwnerReceiptSourceFixtureFrame(s.source.bootstrap,command);
  for(const [input,args]of [[Buffer.concat([good,Buffer.from([0])]),[]],[Buffer.from('GBRSFX01\0\0\x10\x01','binary'),[]],[good,['--source','caller']],
    [encodeOwnerReceiptSourceFixtureFrame(s.source.bootstrap,encodeOwnerReceiptNativeCommand({...x.command,observationDigest:'e'.repeat(64)})),[]],
    [encodeOwnerReceiptSourceFixtureFrame(s.source.bootstrap,encodeOwnerReceiptNativeCommand({...x.command,brokerEnrollmentHeadDigest:'d'.repeat(64)})),[]]]){
    const r=spawnSync(receiptBinary,args,{input,env:{},cwd:'/',stdio:['pipe','pipe','pipe',s.source.rootFd],timeout:10000,maxBuffer:2048});
    assert.equal(r.error,undefined);assert.equal(r.status,1);assert.equal(r.stdout.length,0);assert.equal(r.stderr.length,0);s.assertUnlocked();
  }
  const missing=spawnSync(receiptBinary,[],{input:good,env:{},cwd:'/',timeout:10000,maxBuffer:2048});assert.equal(missing.status,1);assert.equal(missing.stdout.length,0);
});
test('native source mutation while independently locked withholds candidate and cannot retry',options,async t=>{
  const s=sourceSetup(t);let changed=false,poll;
  const x=coordinator(t,s,f.positive[0],{started(){poll=setInterval(()=>{
    try{s.assertUnlocked();}catch{
      if(!changed){changed=true;const name=`${s.source.sourceRoot}/records/0001.record`,bytes=fs.readFileSync(name);bytes[128]^=1;fs.writeFileSync(name,bytes);}clearInterval(poll);
    }
  },5);}});
  x.prepare();x.prepared();try{await assert.rejects(x.confirm());await x.terminal();}finally{clearInterval(poll);}
  assert.equal(changed,true);assert.equal(x.calls,1);assert.equal(x.journal.read(x.action.requestId).slots.has('receipt'),false);
  try{await x.confirm();}catch{}assert.equal(x.calls,1);s.assertUnlocked();
});
test('native source child owns idle-stdin deadline and closed-output terminal',options,async t=>{
  const s=sourceSetup(t),x=coordinator(t,s);x.prepare();x.prepared();await x.confirm();
  const frame=encodeOwnerReceiptSourceFixtureFrame(s.source.bootstrap,encodeOwnerReceiptNativeCommand(x.command));
  for(const idle of [false,true]){
    const c=spawn(receiptBinary,[],{env:{},cwd:'/',stdio:['pipe','pipe','pipe',s.source.rootFd]});let count=0;c.stdin.on('error',()=>{});c.stderr.on('data',()=>{});
    c.stdout.on('data',b=>{count+=b.length;});const done=new Promise(resolve=>c.once('close',(code,signal)=>resolve({code,signal})));
    const timer=setTimeout(()=>c.kill('SIGKILL'),11000);t.after(()=>clearTimeout(timer));
    const start=performance.now();if(!idle){c.stdout.destroy();c.stdin.end(frame);}const status=await done;clearTimeout(timer);
    assert.ok(status.code!==0||status.signal!==null);assert.equal(count,0);if(idle){assert.ok(performance.now()-start>=7500);assert.ok(performance.now()-start<10500);}s.assertUnlocked();
  }
});

test('native source cancellation and owner revocation settle actual child before final refusal',options,async t=>{
  for(const boundary of ['cancel','revocation']){
    const s=sourceSetup(t),x=coordinator(t,s);x.prepare();x.prepared();
    const pending=x.confirm(),refusal=assert.rejects(pending);await new Promise(resolve=>setTimeout(resolve,30));
    if(boundary==='cancel')x.core.cancel(x.principal('owner-decision-cancel'));
    else x.pairing.handleAdmin({op:'principal-owner-grants',principal:x.action.principal,grants:[]});
    await refusal;assert.deepEqual(await x.terminal(),{terminalConfirmed:true,safeClose:true});
    assert.equal(x.calls,1);assert.equal(x.journal.read(x.action.requestId).slots.has('receipt'),false);
    assert.equal(x.socket.events.filter(e=>e.event==='owner-decision').length,0);s.assertUnlocked();
  }
});
test('entered source-fixture stuck signer is terminated by its original native deadline',{
  ...options,skip:options.skip||!process.env.COMMS_OWNER_RECEIPT_SOURCE_STUCK_BINARY
},async t=>{
  const s=sourceSetup(t),x=coordinator(t,s);x.prepare();x.prepared();await x.confirm();
  const input=encodeOwnerReceiptSourceFixtureFrame(s.source.bootstrap,encodeOwnerReceiptNativeCommand(x.command));
  const c=spawn(process.env.COMMS_OWNER_RECEIPT_SOURCE_STUCK_BINARY,[],{env:{},cwd:'/',stdio:['pipe','pipe','pipe',s.source.rootFd]});
  let output=Buffer.alloc(0),errors=Buffer.alloc(0);c.stdin.on('error',()=>{});c.stdout.on('data',b=>{output=Buffer.concat([output,b]);});c.stderr.on('data',b=>{errors=Buffer.concat([errors,b]);});
  const done=new Promise(resolve=>c.once('close',(code,signal)=>resolve({code,signal}))),timer=setTimeout(()=>c.kill('SIGKILL'),11000),start=performance.now();
  t.after(()=>clearTimeout(timer));c.stdin.end(input);const result=await done;clearTimeout(timer);
  assert.ok(result.signal==='SIGKILL'||result.code===1);assert.equal(output.length,0);assert.equal(errors.toString(),'fixture-watchdog-ready\nfixture-stuck\n');
  assert.ok(performance.now()-start>=7500);assert.ok(performance.now()-start<10500);s.assertUnlocked();
});
