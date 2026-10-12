import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require=createRequire(import.meta.url);
const BODY_COUNT=10000,BODY_BYTES=256*1024*1024,OUTCOMES=100000,OUTCOME_BYTES=32*1024*1024;
const EXPIRES=2592000000;
const limits={bodies:BODY_COUNT,bodyBytes:BODY_BYTES,outcomes:OUTCOMES,outcomeBytes:OUTCOME_BYTES};
function admission(index) {
  const id=String(index).padStart(6,'0');
  const evidenceBytes=Math.floor(OUTCOME_BYTES/OUTCOMES)+(index<OUTCOME_BYTES%OUTCOMES?1:0);
  const emptyBytes=Buffer.byteLength(JSON.stringify([id,'',EXPIRES]));
  return {id,digest:'x'.repeat(evidenceBytes-emptyBytes),expires:EXPIRES,limits,
    bytes:index<90000?0:Math.floor(BODY_BYTES/BODY_COUNT)+(index-90000<BODY_BYTES%BODY_COUNT?1:0),dropBody:index<90000};
}
test('full relay body/outcome caps, bounded pages and injected-clock protection',async()=>{
  assert.ok(['darwin','linux'].includes(process.platform),'RSS sampling requires supported ps platform');
  const scratch=await mkdtemp(join(tmpdir(),'agent-comms-do-full-cap-'));
  let child,exited,primary,port,commandLine,stderr='';
  const report={scope:'local-synthetic-full-relay-caps',node:process.version,workerd:require('workerd').version,
    caps:limits,fullRelayBodyOutcomeCapsTested:true,otherAdmissionScopesTested:false,processRssIsNotIsolateHeap:true,productionGuarantees:false,cases:[],sourceHashes:{}};
  const began=performance.now();
  const deadline=Date.now()+15*60*1000;
  const rss=[];
  const sampleRss=()=>{
    assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
    const identity=execFileSync('/bin/ps',['-o','ppid=','-o','rss=','-o','args=','-p',String(child.pid)],{encoding:'utf8',timeout:2000}).trim();
    const match=/^(\d+)\s+(\d+)\s+(.+)$/.exec(identity);assert.ok(match);
    assert.equal(Number(match[1]),process.pid);assert.equal(match[3],commandLine);
    const value=Number(match[2])*1024;
    assert.ok(Number.isFinite(value)&&value>0);rss.push(value);
    assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
  };
  const call=async(input)=>{
    assert.ok(Date.now()<deadline,'finite overall probe deadline');
    const body=JSON.stringify(input);assert.ok(Buffer.byteLength(body)<=65536,'bounded synthetic request');
    const response=await fetch(`http://127.0.0.1:${port}`,{method:'POST',body,signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200,'synthetic operation must succeed');
    const text=await response.text();assert.ok(Buffer.byteLength(text)<=65536,'bounded serialized response');
    return JSON.parse(text);
  };
  const pages=async(op,limit)=>{
    let after='',count=0,maxRowsRead=0,actualBytes=0;const hash=createHash('sha256');
    while(true) {
      const page=await call({op,after,limit});
      assert.ok(page.rows.length<=limit);assert.ok(page.rowsRead<=limit*2,'indexed page scan bound');
      maxRowsRead=Math.max(maxRowsRead,page.rowsRead);
      if(!page.rows.length)break;
      for(const row of page.rows){
        assert.ok(row.id>after);after=row.id;hash.update(JSON.stringify(row)+'\n');count++;
        if(op==='body-page') {assert.equal(row.body.length,admission(Number(row.id)).bytes*2);assert.match(row.body,/^0*$/);actualBytes+=row.body.length/2;}
        else {const bytes=Buffer.byteLength(JSON.stringify([row.id,row.digest,row.expires]));assert.equal(row.bytes,bytes);actualBytes+=bytes;}
      }
      if(count%1024===0)sampleRss();
    }
    return {count,actualBytes,hash:hash.digest('hex'),maxRowsRead};
  };
  try {
    for(const name of ['full-cap-worker.mjs','full-cap.test.mjs','probe-worker.mjs','package-lock.json'])
      report.sourceHashes[name]=createHash('sha256').update(await readFile(new URL(name,import.meta.url))).digest('hex');
    assert.equal(report.workerd,'1.20260730.1');
    const storage=join(scratch,'storage');await mkdir(storage,{mode:0o700});
    const config=join(scratch,'probe.capnp');
    await writeFile(config,`using W = import ${JSON.stringify(require.resolve('workerd/workerd.capnp'))};
const config :W.Config = (
 services = [
  (name = "main", worker = (
   modules = [(name = "full-cap-worker.mjs", esModule = embed ${JSON.stringify(fileURLToPath(new URL('./full-cap-worker.mjs',import.meta.url)))}), (name = "probe-worker.mjs", esModule = embed ${JSON.stringify(fileURLToPath(new URL('./probe-worker.mjs',import.meta.url)))})],
   compatibilityDate = "2026-07-30", globalOutbound = "deny",
   bindings = [(name = "PROBE", durableObjectNamespace = (className = "FullCapProbe"))],
   durableObjectNamespaces = [(className = "FullCapProbe", uniqueKey = "synthetic-full-cap-only", enableSql = true)],
   durableObjectStorage = (localDisk = "storage")
  )),
  (name = "deny", worker = (compatibilityDate = "2026-07-30", modules = [(name = "deny.mjs", esModule = "export default {fetch(){return new Response(null,{status:403});}};")])),
  (name = "storage", disk = (path = ${JSON.stringify(storage)}, writable = true))
 ], sockets = [(name = "probe", address = "127.0.0.1:0", http = (), service = "main")]
);`,{mode:0o600});
    const args=['serve','--experimental','--control-fd=3','-I/',config];
    commandLine=[require('workerd').default,...args].join(' ');
    child=spawn(require('workerd').default,args,{stdio:['ignore','ignore','pipe','pipe']});
    exited=once(child,'exit');exited.catch(()=>{});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
    port=await new Promise((resolve,reject)=>{
      let buffered='';const timer=setTimeout(()=>reject(new Error('workerd-ready-timeout')),10000);
      child.stdio[3].on('data',chunk=>{
        if(Buffer.byteLength(buffered)+chunk.length>65536){clearTimeout(timer);reject(new Error('workerd-control-buffer-limit'));return;}
        buffered+=chunk;let boundary;
        while((boundary=buffered.indexOf('\n'))!==-1){const line=buffered.slice(0,boundary);buffered=buffered.slice(boundary+1);
          try{const ready=JSON.parse(line);if(ready.event==='listen'&&ready.socket==='probe'){clearTimeout(timer);resolve(ready.port);}}catch{}}
      });
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('workerd-start-failed: '+stderr));});
    });
    assert.equal((await call({op:'egress-check'})).outboundStatus,403);sampleRss();
    for(let offset=0;offset<OUTCOMES;offset+=100) {
      const items=Array.from({length:100},(_,i)=>admission(offset+i));
      const result=await call({op:'batch',items});assert.deepEqual(result.results,Array(100).fill('accepted'));
      if(offset%10000===0)sampleRss();
    }
    const full=await call({op:'usage'});
    assert.equal(full.bodies,BODY_COUNT);assert.equal(full.body_bytes,BODY_BYTES);
    assert.equal(full.outcomes,OUTCOMES);assert.equal(full.outcome_bytes,OUTCOME_BYTES);
    report.databaseBytesAtFull=full.databaseBytes;sampleRss();
    const bodyBefore=await pages('body-page',1),evidenceBefore=await pages('evidence-page',32);
    assert.equal(bodyBefore.count,BODY_COUNT);assert.equal(evidenceBefore.count,OUTCOMES);
    assert.equal(bodyBefore.actualBytes,BODY_BYTES);assert.equal(evidenceBefore.actualBytes,OUTCOME_BYTES);
    const rejected={...admission(OUTCOMES),bytes:1,expires:EXPIRES*2};
    assert.equal((await call({op:'admit',...rejected})).result,'capacity');
    const lowered={bodies:1,bodyBytes:1,outcomes:1,outcomeBytes:1};
    assert.equal((await call({op:'admit',...rejected,limits:lowered})).result,'capacity');
    assert.equal((await call({op:'admit',...admission(90000),limits:lowered})).result,'duplicate');
    assert.equal((await call({op:'admit',...admission(90000)})).result,'duplicate');
    assert.equal((await call({op:'admit',...admission(90000),digest:'changed'})).result,'conflict');
    assert.deepEqual(await pages('body-page',1),bodyBefore);
    assert.deepEqual(await pages('evidence-page',32),evidenceBefore);
    report.cases.push({name:'full-count-byte-caps-and-bounded-content-pages',pass:true,bodyBefore,evidenceBefore});
    for(let i=0;i<100;i++)assert.deepEqual(await call({op:'sweep',now:EXPIRES,limit:100}),{bodies:100,outcomes:0});
    assert.equal((await call({op:'usage'})).bodies,0);
    assert.deepEqual(await pages('evidence-page',32),evidenceBefore);
    assert.equal((await call({op:'admit',...rejected})).result,'capacity');
    assert.deepEqual(await call({op:'sweep',now:EXPIRES+119999,limit:100}),{bodies:0,outcomes:0});
    assert.deepEqual(await call({op:'sweep',now:EXPIRES+120000,limit:100}),{bodies:0,outcomes:0});
    assert.equal((await call({op:'admit',...admission(90000)})).result,'duplicate');
    assert.deepEqual(await call({op:'sweep',now:EXPIRES+120001,limit:1}),{bodies:0,outcomes:1});
    assert.equal((await call({op:'admit',...rejected})).result,'accepted');
    assert.equal((await call({op:'usage'})).outcomes,OUTCOMES);
    assert.equal((await call({op:'admit',...admission(OUTCOMES+1)})).result,'capacity');
    report.cases.push({name:'body-expiry-does-not-release-protected-outcome-reservation',pass:true,retainedAtBoundaryMs:120000,releasedAtMs:120001});
    sampleRss();report.workerdProcessRssBytes={samples:rss.length,min:Math.min(...rss),max:Math.max(...rss)};
    report.elapsedMs=Math.round(performance.now()-began);
  } catch(error){primary=error;report.failure={name:error.name,code:error.code??null};}
  finally {
    let stopped=!child?.pid;
    try {
      if(child?.exitCode===null&&child?.signalCode===null)child.kill('SIGKILL');
      if(exited){let timer;try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('workerd-exit-timeout')),5000);})]);}finally{clearTimeout(timer);}}
      stopped=true;
    }catch(error){primary??=error;report.cleanupFailure='workerd-exit';}
    if(stopped)try{await rm(scratch,{recursive:true,force:true});}catch(error){primary??=error;report.cleanupFailure='scratch-remove';}
    report.pass=!primary;console.log(JSON.stringify(report));
  }
  if(primary)throw primary;
});
