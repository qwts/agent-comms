import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';

const limits = { bodies: 10, bodyBytes: 10240, outcomes: 20, outcomeBytes: 10000 };
const admission = (id, extra = {}) => ({ op: 'admit', id, digest: `synthetic-${id}`, expires: 2592000000, bytes: 1024, limits, ...extra });
const empty = { bodies: 0, body_bytes: 0, outcomes: 0, outcome_bytes: 0 };

test('local SQLite DO atomicity, capacity, persisted outcomes and indexed paging', async () => {
  const scratch = await mkdtemp(join(tmpdir(),'agent-comms-do-probe-'));
  let runtime;
  const start = () => new Miniflare({ modules: true, scriptPath: fileURLToPath(new URL('./probe-worker.mjs',import.meta.url)),
    compatibilityDate: '2026-07-30', cf: false, host: '127.0.0.1', port: 0,
    durableObjects: { PROBE: { className: 'SyntheticProbe', useSQLite: true } },
    durableObjectsPersist: join(scratch,'storage'),
    outboundService: () => new Response(null,{status:403}) });
  let primary;
  const lock = JSON.parse(await readFile(new URL('./package-lock.json',import.meta.url),'utf8'));
  const installed = JSON.parse(await readFile(new URL('./node_modules/miniflare/package.json',import.meta.url),'utf8'));
  assert.equal(installed.version,'4.20260730.0');
  const sourceHashes = {};
  for (const name of ['probe-worker.mjs','probe.test.mjs','package-lock.json']) {
    sourceHashes[name]=createHash('sha256').update(await readFile(new URL(name,import.meta.url))).digest('hex');
  }
  const report = { scope: 'local-synthetic-only', node:process.version, miniflare:installed.version,
    miniflareIntegrity:lock.packages['node_modules/miniflare'].integrity,
    workerd:lock.packages['node_modules/workerd'].version, sourceHashes, cases: [], productionGuarantees: false };
  const call = async (name,input) => {
    const ns = await runtime.getDurableObjectNamespace('PROBE');
    const response = await ns.get(ns.idFromName(name)).fetch('https://local.invalid/probe',{
      method:'POST',body:JSON.stringify(input),headers:{'content-type':'application/json'} });
    return { status: response.status, ...(response.status === 503 ? {} : await response.json()) };
  };
  const usage = async name => { const {status,databaseBytes,...rest}=await call(name,{op:'usage'}); assert.equal(status,200); return rest; };
  try {
    runtime=start();
    assert.equal((await call('egress',{op:'egress-check'})).outboundStatus,403);
    for (const failAfter of ['body','outcome','counter']) {
      assert.equal((await call('rollback',admission('same',{failAfter}))).status,409);
      assert.deepEqual(await usage('rollback'),empty);
    }
    assert.equal((await call('rollback',admission('same'))).result,'accepted');
    report.cases.push({ name:'rollback-at-each-write',pass:true });

    const races=await Promise.all(Array.from({length:25},(_,i)=>call('count',admission(String(i)))));
    assert.equal(races.filter(r=>r.result==='accepted').length,10);
    assert.equal(races.filter(r=>r.result==='capacity').length,15);
    assert.equal((await usage('count')).body_bytes,10240);
    for (const [name,cap] of [['bytes',{...limits,bodyBytes:1024}],['outcomes',{...limits,outcomes:1}],['evidence',{...limits,outcomeBytes:1}]]) {
      const first=await call(name,admission('a',{limits:cap}));
      assert.equal(first.result,name==='evidence'?'capacity':'accepted');
      const before=await usage(name);
      const rowsBefore=await call(name,{op:'inspect'});
      assert.equal((await call(name,admission('b',{limits:cap}))).result,'capacity');
      assert.deepEqual(await usage(name),before);
      assert.deepEqual(await call(name,{op:'inspect'}),rowsBefore);
    }
    const fit=admission('exact');
    const exactBytes=new TextEncoder().encode(JSON.stringify([fit.id,fit.digest,fit.expires])).byteLength;
    assert.equal((await call('exact-fit',{...fit,limits:{...limits,outcomeBytes:exactBytes}})).result,'accepted');
    assert.equal((await call('one-byte-over',{...fit,limits:{...limits,outcomeBytes:exactBytes-1}})).result,'capacity');
    assert.deepEqual(await call('one-byte-over',{op:'inspect'}),{status:200,bodies:[],outcomes:[]});
    const countBefore=await call('count',{op:'inspect'});
    assert.equal((await call('count',admission('0'))).result,'duplicate');
    assert.equal((await call('count',admission('0',{digest:'different'}))).result,'conflict');
    assert.deepEqual(await call('count',{op:'inspect'}),countBefore);
    report.cases.push({name:'concurrent-count-and-independent-byte-outcome-caps',pass:true,exactOutcomeBytes:exactBytes});
    assert.equal((await call('lost-reply',admission('lost',{dropReply:true}))).status,503);

    await call('rollback',{op:'drop-body',id:'same'});
    assert.equal((await usage('rollback')).bodies,0);
    await runtime.dispose(); runtime=start();
    assert.equal((await call('rollback',admission('same'))).result,'duplicate');
    assert.equal((await call('rollback',admission('same',{digest:'changed'}))).result,'conflict');
    assert.equal((await usage('rollback')).outcomes,1);
    assert.equal((await usage('rollback')).bodies,0);
    assert.equal((await call('lost-reply',admission('lost'))).result,'duplicate');
    assert.equal((await usage('lost-reply')).bodies,1);
    report.cases.push({name:'clean-runtime-restart-body-removed-and-lost-reply-outcomes-preserved',pass:true});

    const sample={ bodies:512,bodyBytes:512*4096,outcomes:512,outcomeBytes:100000 };
    const began=performance.now();
    for (let i=0;i<512;i++) assert.equal((await call('paging',admission(String(i).padStart(6,'0'),{bytes:4096,limits:sample}))).result,'accepted');
    let after='',seen=0,pages=0,maxRowsRead=0;
    do {
      const page=await call('paging',{op:'page',after,limit:32});
      assert.equal(page.status,200); assert.ok(page.rows.length<=32);
      assert.ok(page.rowsRead<=64,'keyset query must not scan full population');
      maxRowsRead=Math.max(maxRowsRead,page.rowsRead); pages++;
      for(const row of page.rows){assert.ok(row.id>after); assert.equal(row.bytes,4096);after=row.id;seen++;}
      if(!page.rows.length)break;
    }while(true);
    assert.equal(seen,512);
    const state=await call('paging',{op:'usage'});
    assert.equal(state.body_bytes,2097152);
    assert.ok(state.databaseBytes>state.body_bytes,'measure SQLite overhead separately');
    assert.equal((await call('paging',{op:'page',after:'',limit:33})).status,409);
    report.cases.push({name:'bounded-indexed-keyset-paging',pass:true,sampleBodies:512,payloadBytes:state.body_bytes,
      serializedOutcomeBytes:state.outcome_bytes,databaseBytes:state.databaseBytes,pages,maxRowsRead,elapsedMs:Math.round(performance.now()-began),
      runnerRssBytes:process.memoryUsage().rss,runnerRssIncludesWorkerd:false,fullAcceptedCapsTested:false});
  } catch(error) {
    primary=error;
    report.failure={name:error.name,code:error.code??null};
  } finally {
    try { await runtime?.dispose(); } catch(error) { primary??=error; report.cleanupFailure='runtime-dispose'; }
    try { await rm(scratch,{recursive:true,force:true}); } catch(error) { primary??=error; report.cleanupFailure='scratch-remove'; }
    report.pass=!primary;
    report.abruptTerminationTested=false;
    if(process.env.PROBE_REPORT) {
      try { await writeFile(process.env.PROBE_REPORT,JSON.stringify(report,null,2)+'\n',{mode:0o600}); }
      catch(error) {
        primary??=error;
        report.reportWriteFailure='probe-report-write-failed';
        report.failure??={name:error.name,code:'probe-report-write-failed'};
      }
    }
    report.pass=!primary;
    console.log(JSON.stringify(report));
  }
  if(primary) throw primary;
});
