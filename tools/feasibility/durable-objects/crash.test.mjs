import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require=createRequire(import.meta.url);
const bounded=async(promise)=>{
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('owned-process-exit-timeout')),5000);})]); }
  finally {clearTimeout(timer);}
};

async function runCrash({badBinary=false,badConfig=false}={}) {
  const scratch=await mkdtemp(join(tmpdir(),'agent-comms-do-crash-'));
  const storage=join(scratch,'storage'); await mkdir(storage,{mode:0o700});
  const schema=require.resolve('workerd/workerd.capnp');
  const binary=badBinary?join(scratch,'missing-workerd'):require('workerd').default;
  const worker=fileURLToPath(new URL('./probe-worker.mjs',import.meta.url));
  const config=join(scratch,'probe.capnp');
  await writeFile(join(scratch,'dispatch.mjs'),`export {SyntheticProbe} from './probe.mjs'; export default { fetch(request,env) { return env.PROBE.get(env.PROBE.idFromName('crash')).fetch(request); } };`);
  await writeFile(config,`using W = import ${JSON.stringify(schema)};
const config :W.Config = (
 services = [
  (name = "main", worker = (
   modules = [(name = "dispatch.mjs", esModule = embed "dispatch.mjs"), (name = "probe.mjs", esModule = embed ${JSON.stringify(worker)})],
   compatibilityDate = "2026-07-30",
   globalOutbound = "deny",
   bindings = [(name = "PROBE", durableObjectNamespace = (className = "SyntheticProbe"))],
   durableObjectNamespaces = [(className = "SyntheticProbe", uniqueKey = "synthetic-crash-only", enableSql = true)],
   durableObjectStorage = (localDisk = "storage")
  )),
  (name = "deny", worker = (compatibilityDate = "2026-07-30", modules = [(name = "deny.mjs", esModule = "export default {fetch(){return new Response(null,{status:403});}};")])),
  (name = "storage", disk = (path = ${JSON.stringify(storage)}, writable = true))
 ],
 sockets = [(name = "probe", address = "127.0.0.1:0", http = (), service = "main")]
);
`,{mode:0o600});
  if(badConfig) await writeFile(config,'invalid configuration');
  let child,exited,port,stderr='',primary;
  const report={scope:'local-owned-workerd-process-crash',signal:'SIGKILL',powerLossTested:false,productionGuarantees:false};
  report.node=process.version;report.workerd=require('workerd').version;
  assert.equal(report.workerd,'1.20260730.1');
  report.sourceHashes={};
  for(const name of ['probe-worker.mjs','crash.test.mjs','package-lock.json'])
    report.sourceHashes[name]=createHash('sha256').update(await readFile(new URL(name,import.meta.url))).digest('hex');
  const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const sentinelExit=once(sentinel,'exit');sentinelExit.catch(()=>{});
  const stop=async(signal)=>{
    if(child && child.exitCode===null && child.signalCode===null) child.kill(signal);
    let result;
    try {result=exited?await bounded(exited):undefined;}
    catch(error) {if(child?.pid) throw error;} // Failed spawn owns no live process.
    child=undefined;exited=undefined;
    return result;
  };
  const start=async()=>{
    child=spawn(binary,['serve','--experimental','--control-fd=3','-I/',config],{stdio:['ignore','ignore','pipe','pipe']});
    exited=once(child,'exit');exited.catch(()=>{});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
    port=await new Promise((resolve,reject)=>{
      let buffered=''; const timer=setTimeout(()=>reject(new Error('workerd-ready-timeout')),10000);
      child.stdio[3].on('data',chunk=>{
        if(Buffer.byteLength(buffered)+chunk.length>65536) {clearTimeout(timer);reject(new Error('workerd-control-buffer-limit'));return;}
        buffered+=chunk;
        let boundary;
        while((boundary=buffered.indexOf('\n'))!==-1) {
          const line=buffered.slice(0,boundary);buffered=buffered.slice(boundary+1);
          try { const ready=JSON.parse(line);if(ready.event==='listen'&&ready.socket==='probe') {clearTimeout(timer);resolve(ready.port);} } catch {}
        }
      });
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('workerd-start-failed: '+stderr));});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
    });
  };
  const call=async(input)=>{
    const response=await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify(input),signal:AbortSignal.timeout(5000)});
    if(response.status===500) throw new Error('workerd-request-failed: '+stderr);
    return response.status===503?{status:503}:response.json();
  };
  const admission=(id,extra={})=>({op:'admit',id,digest:'synthetic-'+id,expires:2592000000,bytes:16,
    limits:{bodies:10,bodyBytes:160,outcomes:10,outcomeBytes:1000},...extra});
  try {
    await start();
    assert.equal((await call({op:'egress-check'})).outboundStatus,403);
    assert.deepEqual(await call(admission('committed',{dropReply:true})),{status:503});
    assert.equal((await call(admission('removed'))).result,'accepted');
    await call({op:'drop-body',id:'removed'});
    assert.equal((await call(admission('rollback',{failAfter:'outcome'}))).error,'injected-outcome');
    const before=await call({op:'inspect'});
    const oldPid=child.pid;
    const terminated=await stop('SIGKILL');
    assert.deepEqual(terminated,[null,'SIGKILL']);
    assert.equal(sentinel.exitCode,null);assert.equal(sentinel.signalCode,null);
    await start();assert.notEqual(child.pid,oldPid);
    assert.deepEqual(await call({op:'inspect'}),before);
    assert.equal((await call(admission('committed'))).result,'duplicate');
    assert.equal((await call(admission('removed'))).result,'duplicate');
    assert.equal((await call(admission('removed',{digest:'changed'}))).result,'conflict');
    assert.equal((await call(admission('rollback'))).result,'accepted');
    report.committedAndRemovedEvidencePreserved=true;
    report.rollbackAbsent=true;
    report.unrelatedSentinelSurvived=true;
  } catch(error) {primary=error;report.failure={name:error.name,code:error.code??null};}
  finally {
    try {await stop('SIGKILL');} catch(error) {primary??=error;report.cleanupFailure='workerd-exit';}
    try {sentinel.kill('SIGTERM');await bounded(sentinelExit);} catch(error) {primary??=error;report.cleanupFailure='sentinel-exit';}
    if(!child) {try {await rm(scratch,{recursive:true,force:true});} catch(error) {primary??=error;report.cleanupFailure='scratch-remove';}}
    report.scratchRemoved=await stat(scratch).then(()=>false,error=>error.code==='ENOENT');
    report.pass=!primary;console.log(JSON.stringify(report));
  }
  if(primary) {primary.probeReport=report;throw primary;}
  return report;
}

test('owned workerd SIGKILL preserves committed synthetic SQLite outcomes',async()=>{await runCrash();});
test('bad binary and invalid startup preserve failure and bound cleanup',async()=>{
  for(const options of [{badBinary:true},{badConfig:true}]) {
    const began=performance.now();
    await assert.rejects(runCrash(options),error=>{
      assert.equal(error.probeReport.pass,false);
      assert.equal(error.probeReport.scratchRemoved,true);
      assert.equal(error.probeReport.cleanupFailure,undefined);
      if(options.badBinary) assert.equal(error.code,'ENOENT');
      else assert.match(error.message,/workerd-start-failed/);
      return true;
    });
    assert.ok(performance.now()-began<15000,'startup failure cleanup must be bounded');
  }
});
