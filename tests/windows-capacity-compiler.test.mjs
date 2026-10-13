import assert from 'node:assert/strict';
import test from 'node:test';
import { connectWindowsPipe } from '../lib/platform/windows-pipe-client.mjs';
import { captureCompilerPrefix, deriveCompilerPrefix, compilerControlArgs, collectCompilerControls, sampleCompilerControl, COMPILER_ORDER, COMPILER_DEADLINE_MS } from '../tools/acceptance/windows-capacity-compiler.mjs';

const prefix = captureCompilerPrefix(connectWindowsPipe, { PSModulePath: 'CANARY-private-path' });
test('derived control uses the exact actual production worker compile prefix without invoking pipe Run', () => {
  assert.ok(prefix.includes('[void](Add-Type -TypeDefinition $source -Language CSharp'));
  assert.equal(prefix.includes('[AgentCommsPipeClient]::Run('), false);
  for (const variant of ['implicit','explicit']) {
    const args = compilerControlArgs(prefix, variant), command = args.at(-1);
    assert.deepEqual(args.slice(0,-1), ['-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-Command']);
    assert.ok(command.includes(prefix));
    assert.equal(command.includes('Import-Module -Name $manifest'), variant === 'explicit');
    assert.equal(command.includes('ConvertTo-Json'), false); assert.equal(command.includes('CANARY'), false);
    assert.ok(command.indexOf('compiler-entry') < command.indexOf('module-observation'));
    assert.ok(command.indexOf('compiler-compile') < command.indexOf(prefix));
    assert.ok(command.indexOf(prefix) < command.indexOf('compiler-compiled'));
  }
  assert.equal(COMPILER_DEADLINE_MS, 15000);
});
test('captured public command refuses changed shell, argv, worker bytes and arbitrary prefix without exposing inputs', () => {
  let file, args;
  const captured = captureCompilerPrefix((pipe, options) => connectWindowsPipe(pipe, { ...options, spawnProcess(f,a,o) {
    file=f;args=a;return options.spawnProcess(f,a,o);
  } }), {});
  assert.equal(captured,prefix);
  const changed = [...args];changed[changed.length-1]=changed.at(-1).replace('FromBase64String', 'CANARY-private');
  for (const [f,a] of [['CANARY-executable',args],[file,args.slice(1)],[file,changed],[file,[...args.slice(0,-1),args.at(-1)+';CANARY-secret']]]) {
    assert.throws(() => deriveCompilerPrefix(f,a), { message:'compiler-source-mismatch' });
  }
  assert.throws(() => compilerControlArgs(prefix+'CANARY-secret','implicit'), { message:'compiler-source-mismatch' });
  assert.throws(() => compilerControlArgs(prefix,'CANARY-variant'), { message:'compiler-source-mismatch' });
});
test('counterbalanced controls preserve failed outcomes and continue only with all owned cleanup proofs', async () => {
  const rows=[],calls=[];
  await collectCompilerControls(async variant => {calls.push(variant);return {status:variant==='implicit'?'failed':'passed', ownedTerminalConfirmed:true,stdioClosedConfirmed:true,descendantsEmptyConfirmed:true,cleanupConfirmed:true};},row=>rows.push(row));
  assert.deepEqual(calls,COMPILER_ORDER);assert.deepEqual(rows.map(row=>row.index),[0,1,2,3]);
  assert.deepEqual(rows.map(row=>row.status),['failed','passed','passed','failed']);
  for (const missing of ['ownedTerminalConfirmed','stdioClosedConfirmed','descendantsEmptyConfirmed','cleanupConfirmed']) {
    const retained=[];let count=0;
    await collectCompilerControls(async()=>{count++;return {status:'failed',ownedTerminalConfirmed:true,stdioClosedConfirmed:true,descendantsEmptyConfirmed:true,cleanupConfirmed:true,[missing]:false};},row=>retained.push(row));
    assert.equal(count,1);assert.deepEqual(retained.slice(1).map(row=>row.reason),Array(3).fill('prior-cleanup-unconfirmed'));
  }
});

function deferred() {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
test('compiler sampling drains the one in-flight exact-command check before completion',async()=>{
  const started=deferred(),entered=deferred(),sample=deferred();let calls=0,settled=false;
  const pending=sampleCompilerControl({request(op,fields,ms){
    assert.equal(op,'sample');assert.deepEqual(fields,{});assert.equal(ms,5000);
    calls++;entered.resolve();return sample.promise;
  }},started.promise,{intervalMs:1});
  pending.finally(()=>{settled=true;});
  await entered.promise;started.resolve({ok:true});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(calls,1);assert.equal(settled,false);
  sample.resolve({totals:{relay:{count:1}}});assert.deepEqual(await pending,{ok:true});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);
});
test('compiler sampling refusal stops the control and clears polling; missing relay refuses completion',async()=>{
  const entered=deferred(),sample=deferred(),started=deferred();let calls=0;
  const failure=new Error('job-supervisor-failed');
  const pending=sampleCompilerControl({request(){calls++;entered.resolve();return sample.promise;}},started.promise,{intervalMs:1});
  const refused=assert.rejects(pending,error=>error===failure);
  await entered.promise;sample.reject(failure);await refused;
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);
  started.reject(new Error('CANARY-late-start-failure'));
  await assert.rejects(sampleCompilerControl({request(){assert.fail('already complete start must clear polling');}},Promise.resolve({ok:true})),{message:'owned-startup-fault'});
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createCompilerObserver, observeCompilerControl, projectCompilerObservation } from '../tools/acceptance/windows-capacity-compiler.mjs';
function memoryOwned() {
  let close;const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough()});
  return {child,stdioClosed:new Promise(resolve=>{close=resolve;}),close:()=>close()};
}
const records = [
  {id:-1,ok:true,phase:'compiler-entry'},
  {id:-1,ok:true,phase:'module-observation',manifestPresent:true,expectedPSHome:true},
  {id:-1,ok:true,phase:'compiler-compile'},
  {id:-1,ok:true,phase:'compiler-compiled'},
  {id:0,ok:true,phase:'ready'},
];
test('compiler parser retains only fixed ordered rows, immutable booleans and bounded times',async()=>{
  const owned=memoryOwned();let clock=0;const control=createCompilerObserver(owned,'implicit',()=>clock++);
  for(const row of records) owned.child.stdout.write(JSON.stringify(row)+'\n');
  await control.ready;
  const snapshot=control.state();snapshot.phases[0].phase='CANARY-secret';snapshot.moduleObservation.expectedPSHome=false;
  assert.equal(control.state().phases[0].phase,'compiler-entry');assert.equal(control.state().moduleObservation.expectedPSHome,true);
  assert.equal(control.state().phases.length,4);assert.ok(control.state().phases.every(row=>Number.isSafeInteger(row.elapsedMs)));
  owned.close();
});
test('compiler parser refuses unexpected phase/schema/output and preserves first fixed failure without raw text',async()=>{
  for(const bad of [{id:-1,ok:true,phase:'compiler-compiled'}, {...records[0],path:'CANARY-secret'},'CANARY-not-json','x'.repeat(65537)]){
    const owned=memoryOwned(),control=createCompilerObserver(owned,'implicit',()=>0);
    owned.child.stdout.write(typeof bad==='string'?bad+'\n':JSON.stringify(bad)+'\n');
    await assert.rejects(control.ready,error=>['control-invalid','control-output-bound'].includes(error.message));
    assert.equal(JSON.stringify(control.state()).includes('CANARY'),false);
    owned.child.stdout.emit('error',new Error('CANARY-late'));owned.close();
    assert.notEqual(control.state().check,'control-closed');
  }
});
test('compiler parser refuses duplicate completion and unterminated trailing output after ready',async()=>{
  for (const trailing of [JSON.stringify(records.at(-1))+'\n','CANARY-private-trailing']) {
    const owned=memoryOwned(),control=createCompilerObserver(owned,'implicit',()=>0);
    for (const row of records) owned.child.stdout.write(JSON.stringify(row)+'\n');
    await control.ready;
    owned.child.stdout.write(trailing);owned.close();
    await owned.stdioClosed;
    assert.equal(control.state().check,'control-invalid');
    assert.equal(JSON.stringify(control.state()).includes('CANARY'),false);
  }
});
function actualOwned(script){
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});let terminal=false;
  const exited=new Promise(resolve=>{child.once('error',()=>{if(!child.pid){terminal=true;resolve({code:null,signal:null});}});child.once('exit',(code,signal)=>{terminal=true;resolve({code,signal});});});
  const stdioClosed=new Promise(resolve=>child.once('close',resolve));return{child,exited,stdioClosed,terminal:()=>terminal};
}
test('real control channel natural completion and forced deadline await the same owned terminal/stdio handles',async()=>{
  const text=records.map(row=>JSON.stringify(row)+'\n').join('');
  const natural=actualOwned(`process.stdout.write(${JSON.stringify(text)});`);
  const passed=await observeCompilerControl(natural,'implicit',{deadlineMs:1000});
  assert.equal(passed.status,'passed');assert.equal(passed.terminal.code,0);assert.equal(passed.forcedTerminationRequested,false);
  assert.equal(passed.ownedTerminalConfirmed,true);assert.equal(passed.stdioClosedConfirmed,true);
  const stuck=actualOwned(`process.stdout.write(${JSON.stringify(JSON.stringify(records[0])+'\n')});process.stderr.write('CANARY-private-path');setInterval(()=>{},1000);`);
  const refused=await observeCompilerControl(stuck,'implicit',{deadlineMs:150,cleanupMs:1000});
  assert.equal(refused.status,'failed');assert.equal(refused.check,'compiler-deadline');assert.equal(refused.forcedTerminationRequested,true);
  assert.equal(refused.ownedTerminalConfirmed,true);assert.equal(refused.stdioClosedConfirmed,true);assert.ok(refused.stderrBytes>0);
  assert.equal(JSON.stringify(refused).includes('CANARY'),false);
});

test('owned IPC observation projection rejects forged bounds, metadata and accessors without replacing raw receipt data',()=>{
  const receipt={status:'failed',requestDeadlineMs:15000,ownedTerminalConfirmed:true,stdioClosedConfirmed:true,
    forcedTerminationRequested:true,stderrBytes:0,stderrByteCountCapped:false,check:'compiler-deadline',
    terminal:{code:null,signal:'SIGTERM'},phases:[{phase:'compiler-entry',elapsedMs:1}],elapsedMs:15002};
  const projected=projectCompilerObservation(receipt,'implicit');
  receipt.phases[0].elapsedMs=2;assert.equal(projected.phases[0].elapsedMs,1);
  const getter={...receipt};Object.defineProperty(getter,'path',{enumerable:true,get(){assert.fail('getter executed');}});
  for(const forged of [{...receipt,path:'CANARY-secret'},getter,{...receipt,requestDeadlineMs:15001},
    {...receipt,phases:[{phase:'compiler-entry',elapsedMs:-1}]},{...receipt,phases:Array(1)},
    {...receipt,phases:[{phase:'compiler-entry',elapsedMs:Infinity}]},{...receipt,elapsedMs:30001},
    {...receipt,terminal:{code:0,signal:'CANARY-signal'}},{...receipt,status:'passed'}]) {
    assert.throws(()=>projectCompilerObservation(forged,'implicit'),{message:'compiler-control-failed'});
  }
});


test('sampling refusal retains only projected owned diagnostics and still blocks continuation',async()=>{
  const receipt={status:'failed',requestDeadlineMs:15000,ownedTerminalConfirmed:true,stdioClosedConfirmed:true,
    forcedTerminationRequested:true,stderrBytes:0,stderrByteCountCapped:false,check:'compiler-deadline',
    terminal:{code:null,signal:'SIGTERM'},phases:[{phase:'compiler-entry',elapsedMs:1}],elapsedMs:15002};
  for(const value of [receipt,{...receipt,path:'CANARY-raw'},null]) {
    let retained, admitted, calls=0;const rows=[];
    await collectCompilerControls(async variant=>{
      calls++;
      await assert.rejects(sampleCompilerControl({request(){assert.fail('no sample before first interval');}},
        Promise.resolve({compilerObservation:value,raw:'CANARY-envelope'}),{onReply(reply){
          try {retained=projectCompilerObservation(reply.compilerObservation,variant);}catch {}
        }}),{message:'owned-startup-fault'});
      return {status:'failed',...(retained?{compilerObservation:retained}:{}),
        ownedTerminalConfirmed:admitted?.ownedTerminalConfirmed===true,
        stdioClosedConfirmed:admitted?.stdioClosedConfirmed===true,
        descendantsEmptyConfirmed:true,cleanupConfirmed:true,relayCommandConfirmed:false};
    },async row=>rows.push(row));
    assert.equal(calls,1);assert.equal(rows[0].status,'failed');
    assert.equal(rows[0].relayCommandConfirmed,false);
    assert.deepEqual(rows.slice(1).map(row=>row.reason),Array(3).fill('prior-cleanup-unconfirmed'));
    assert.equal(JSON.stringify(rows).includes('CANARY'),false);
    if(value===receipt) {
      assert.deepEqual(retained,receipt);receipt.phases[0].elapsedMs=2;
      assert.equal(retained.phases[0].elapsedMs,1);
    } else assert.equal(retained,undefined);
  }
});
