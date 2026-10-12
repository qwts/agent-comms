import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const deadline=async(promise,ms=5000)=>{
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('inspector-deadline')),ms);})]);}finally{clearTimeout(timer);}
};

import {controlReady,inspectorRpc} from './inspector-client.mjs';

test('pinned local workerd inspector reports bounded heap observations', {timeout:30000},async()=>{
 const scratch=await mkdtemp(join(tmpdir(),'agent-comms-inspector-'));
 let child,exit,ws,primary;
 const report={scope:'local-inspector-capability-experiment',providerMemoryCompliance:false,heapIsNotCompleteNativeOrSQLiteAccounting:true,observations:[]};
 try {
  report.node=process.version;report.workerd=require('workerd').version;assert.equal(report.workerd,'1.20260730.1');
  report.sourceHashes={};for(const name of ['inspector.test.mjs','inspector-client.mjs','package-lock.json']) report.sourceHashes[name]=createHash('sha256').update(await readFile(new URL(name,import.meta.url))).digest('hex');
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const config=join(scratch,'probe.capnp');
  await writeFile(config,`using W = import ${JSON.stringify(require.resolve('workerd/workerd.capnp'))};
const config :W.Config = (services = [(name = "inspector-probe", worker = (compatibilityDate = "2026-07-30", globalOutbound = "deny", modules = [(name = "probe.mjs", esModule = "export default {fetch(){return new Response('synthetic');}};")])), (name = "deny", worker = (compatibilityDate = "2026-07-30", modules = [(name = "deny.mjs", esModule = "export default {fetch(){return new Response(null,{status:403});}};")]))], sockets = [(name = "probe", address = "127.0.0.1:0", http = (), service = "inspector-probe")]);`,{mode:0o600});
  child=spawn(require('workerd').default,['serve','--inspector-addr=127.0.0.1:'+port,'--control-fd=3','-I/',config],{stdio:['ignore','ignore','pipe','pipe']});
  exit=once(child,'exit');exit.catch(()=>{});
  let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
  const httpPort=await controlReady(child.stdio[3],child);
  const assertOwnedLive=()=>{assert.ok(child.pid);assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);};
  assertOwnedLive();
  assert.equal(await (await fetch('http://127.0.0.1:'+httpPort,{signal:AbortSignal.timeout(5000)})).text(),'synthetic');
  const response=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(5000)});const raw=await response.text();assert.ok(raw.length<65536);const targets=JSON.parse(raw);assert.ok(targets.length>0&&targets.length<=8);
  report.targets=targets.map(({id,title,type})=>({id,title,type}));
  const target=targets.find(row=>row.id==='inspector-probe');assert.ok(target,'exact configured service inspector target');
  const url=new URL(target.webSocketDebuggerUrl);assert.equal(url.hostname,'127.0.0.1');assert.equal(Number(url.port),port);assert.equal(url.protocol,'ws:');
  ws=new WebSocket(url);await deadline(once(ws,'open'));
  let serial=0;const rpc=method=>inspectorRpc(ws,++serial,method);
  for(let i=0;i<3;i++){const result=await rpc('Runtime.getHeapUsage');if(result.error){report.heapMethodSupported=false;report.unsupportedCode=result.error.code;break;}report.heapMethodSupported=true;const observed={};for(const key of ['usedSize','totalSize','embedderHeapUsedSize','backingStorageSize'])if(result.result[key]!==undefined){assert.ok(Number.isFinite(result.result[key])&&result.result[key]>=0);observed[key]=result.result[key];}assert.ok('usedSize' in observed);report.observations.push(observed);}
  assertOwnedLive();report.childPid=child.pid;
 }catch(error){primary=error;report.failure={name:error.name,code:error.code??null,message:error.message};}
 finally{
  ws?.close();if(child?.pid&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  try{if(child?.pid)await deadline(exit);report.ownedProcessStopped=true;}catch(error){primary??=error;report.cleanupFailure='owned-process-exit';}
  if(!child?.pid||report.ownedProcessStopped)await rm(scratch,{recursive:true,force:true});
  report.pass=!primary;console.log(JSON.stringify(report));
 }
 if(primary)throw primary;
});

 test('malformed inspector messages, close and timeout remove every RPC listener',async()=>{
  class Socket extends EventTarget {listeners=new Set();addEventListener(type,fn){this.listeners.add(fn);super.addEventListener(type,fn);}removeEventListener(type,fn){this.listeners.delete(fn);super.removeEventListener(type,fn);}send(){}}
  for(const mode of ['malformed','oversized','close','error','timeout']) {
   const ws=new Socket();const pending=inspectorRpc(ws,1,'Runtime.getHeapUsage',10);
   if(mode==='malformed')ws.dispatchEvent(new MessageEvent('message',{data:'{'}));
   if(mode==='oversized')ws.dispatchEvent(new MessageEvent('message',{data:'x'.repeat(65537)}));
   if(mode==='close'||mode==='error')ws.dispatchEvent(new Event(mode));
   await assert.rejects(pending);assert.equal(ws.listeners.size,0);
  }
 });
 test('control overflow and timeout detach stream and process handlers',async()=>{
  const {EventEmitter}=await import('node:events');
  for(const overflow of [true,false]){const stream=new EventEmitter(),child=new EventEmitter();const pending=controlReady(stream,child,10);if(overflow)stream.emit('data',Buffer.alloc(65537));await assert.rejects(pending);assert.equal(stream.listenerCount('data'),0);assert.equal(child.listenerCount('error'),0);assert.equal(child.listenerCount('exit'),0);stream.emit('data',Buffer.alloc(65537));}
 });
