import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWindowsPipe } from '../lib/platform/windows-pipe-client.mjs';
import { captureCompilerPrefix, compilerControlArgs } from '../tools/acceptance/windows-capacity-compiler.mjs';
import { createCapacityController } from '../tools/acceptance/windows-capacity-control.mjs';
import { retainCapacityFailure } from '../tools/acceptance/windows-capacity-lifecycle.mjs';
import { projectSupervisorClassification, supervisorClassificationFromFailure, supervisorClassificationFromError } from '../tools/acceptance/windows-capacity-classification.mjs';

test('classification projector retains closed own primitive fields and independent snapshots',()=>{
  const classification={check:'argv-equality',argvCountMatches:true,argvMatches:false};
  const projected=supervisorClassificationFromFailure({failure:{classification}});
  assert.deepEqual(projected,classification);classification.check='CANARY-secret';
  assert.equal(projected.check,'argv-equality');
  const error=new Error('CANARY-error');Object.defineProperty(error,'supervisorClassification',{value:projected});
  assert.deepEqual(supervisorClassificationFromError(error),projected);
  for (const check of ['argv-parse','executable','compiler-parent','compiler-arguments','compiler-response','owned-parent','pid-reuse','history-bound','kind-bound']) {
    assert.deepEqual(projectSupervisorClassification({check}),{check});
  }
});

test('classification projector rejects unknown keys, accessors, inherited fields and inconsistent booleans',()=>{
  const accessor={check:'argv-parse'};Object.defineProperty(accessor,'argvMatches',{enumerable:true,get(){assert.fail('getter executed');}});
  for(const value of [null,[],{check:'CANARY-secret'},{check:'argv-parse',path:'CANARY-path'},accessor,
    Object.create({check:'argv-parse'}),{check:'argv-count',argvCountMatches:true},
    {check:'argv-count',argvCountMatches:false,argvMatches:false},
    {check:'argv-equality',argvCountMatches:true,argvMatches:true},
    {check:'argv-parse',argvCountMatches:'CANARY'},
    {check:'argv-parse',argvMatches:false}]) assert.equal(projectSupervisorClassification(value),undefined);
  const record={};Object.defineProperty(record,'failure',{get(){assert.fail('getter executed');}});
  assert.equal(supervisorClassificationFromFailure(record),undefined);
  assert.equal(supervisorClassificationFromError(Object.create({supervisorClassification:{check:'argv-parse'}})),undefined);
});

test('real supervisor control IPC preserves fixed classification through failure retention and owned exit',async()=>{
  const classification={check:'argv-equality',argvCountMatches:true,argvMatches:false};
  const source=`import {createInterface} from 'node:readline';
process.stdout.write(JSON.stringify({id:0,ok:true,phase:'ready'})+'\\n');
createInterface({input:process.stdin}).once('line',line=>{
 const {id}=JSON.parse(line);process.stdout.write(JSON.stringify({id,ok:false,failure:{check:'job-supervisor-failed',phase:'sample-classify',classification:${JSON.stringify(classification)}}})+'\\n',()=>process.exit(1));
});`;
  const child=owned(process.execPath,['--input-type=module','-e',source],['pipe','pipe','pipe']);
  const control=createCapacityController(child,{classifyFailure(record){
    const error=new Error('job-supervisor-failed');Object.defineProperty(error,'supervisorClassification',{value:supervisorClassificationFromFailure(record)});return error;
  }});
  try {
    assert.equal((await within(control.startup,5000)).phase,'ready');
    await assert.rejects(control.request('sample'),error=>{
      const original={stage:'derived-compiler-control',check:error.message,supervisorClassification:supervisorClassificationFromError(error)};
      const retained=retainCapacityFailure(original,{revision:'candidate'},{});
      assert.deepEqual(retained.supervisorClassification,classification);return true;
    });
    assert.equal((await within(child.exited,5000)).code,1);await within(child.closed,5000);
    assert.equal(child.stderrBytes(),0);
  } finally {
    if(!child.terminal()) child.child.kill();await within(child.exited,5000);await within(child.closed,5000);
  }
});

async function within(promise,ms) {
  let timer;try{return await Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('owned-native-deadline')),ms);})]);}
  finally{clearTimeout(timer);}
}
function owned(file,args,stdio) {
  const child=spawn(file,args,{stdio,windowsHide:true});let terminal=false,stderrBytes=0;
  const exited=new Promise(resolve=>{child.once('error',()=>{terminal=true;resolve({code:null});});child.once('exit',(code)=>{terminal=true;resolve({code});});});
  const closed=new Promise(resolve=>child.once('close',resolve));
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;});child.stderr.on('error',()=>{stderrBytes=-1;});
  return{child,exited,closed,terminal:()=>terminal,stderrBytes:()=>stderrBytes};
}

// Public derived command is inert argv on a Node descendant. This exercises
// actual Node serialization -> WMI -> the existing CommandLineToArgvW guard,
// without running the worker. CI's account/profile is not hosted standard-user
// PowerShell bootstrap or production compiler acceptance.
for (const variant of ['exact','count-mismatch','value-mismatch']) test(`native classifier preserves ${variant} for trusted multiline worker argv`,{skip:process.platform!=='win32',timeout:60000},async()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'comms argv parity '));
  const script=path.join(directory,'paused.mjs');
  writeFileSync(script,`import {spawn} from 'node:child_process';
let child;process.send({id:0,paused:true});
process.on('message',({id,op,args})=>{
 if(op==='start'){child=spawn(process.execPath,args,{stdio:'ignore',windowsHide:true});child.once('spawn',()=>process.send({id,ok:true,spawned:true}));}
 if(op==='stop'){child.once('close',()=>process.send({id,ok:true,stopped:true},()=>process.disconnect()));child.kill();}
});`);
  const shell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const supervisorScript=fileURLToPath(new URL('../tools/acceptance/windows-capacity-job.ps1',import.meta.url));
  const fixtureArgs=[script];
  const prefix=captureCompilerPrefix(connectWindowsPipe,process.env);
  const actualArgs=['-e','setInterval(()=>{},1000)','--',...compilerControlArgs(prefix,'implicit')];
  const expectedArgs=[...actualArgs];
  if(variant==='count-mismatch') expectedArgs.pop();
  if(variant==='value-mismatch') expectedArgs[expectedArgs.length-1]+=';CANARY-public-mismatch';
  const fixture=owned(process.execPath,fixtureArgs,['ignore','ignore','pipe','ipc']);
  const fixtureControl=createCapacityController(fixture,{ipc:true});
  const supervisor=owned(shell,['-NoLogo','-NoProfile','-NonInteractive','-File',supervisorScript],['pipe','pipe','pipe']);
  const control=createCapacityController(supervisor,{classifyFailure(record){
    const error=new Error('job-supervisor-failed');
    Object.defineProperty(error,'supervisorClassification',{value:supervisorClassificationFromFailure(record)});return error;
  }});
  try {
    assert.equal((await within(fixtureControl.startup,5000)).paused,true);
    assert.equal((await within(control.startup,15000)).phase,'ready');
    assert.equal((await control.request('attach',{pid:fixture.child.pid,parentPid:process.pid,nodeExecutable:realpathSync(process.execPath),shellExecutable:shell,fixtureArgs,
      relayArgs:[],diagnosticArgs:expectedArgs,compilerExecutables:[],compilerTemp:realpathSync(process.env.TEMP),commitLimitBytes:536870912},15000)).attached,true);
    assert.equal((await fixtureControl.request('start',{args:actualArgs},5000)).spawned,true);
    if(variant==='exact') {
      const sample=await control.request('sample',{},5000).catch(error=>{
        assert.fail('native-classification-refused '+JSON.stringify(supervisorClassificationFromError(error)??{check:'classification-unavailable'}));
      });
      assert.equal(sample.totals.main.count,1);assert.equal(sample.totals.diagnostic.count,1);
      assert.equal((await fixtureControl.request('stop',{},5000)).stopped,true);
      await within(fixture.exited,5000);await within(fixture.closed,5000);
      assert.equal((await control.request('members')).activeMembers,0);
      assert.equal((await control.request('close',{},10000)).jobEmptyConfirmed,true);
    } else {
      const expected=variant==='count-mismatch'?{check:'argv-count',argvCountMatches:false}:{check:'argv-equality',argvCountMatches:true,argvMatches:false};
      await assert.rejects(control.request('sample',{},5000),error=>{
        assert.equal(error.message,'job-supervisor-failed');assert.deepEqual(supervisorClassificationFromError(error),expected);return true;
      });
    }
    await within(supervisor.exited,5000);await within(supervisor.closed,5000);
    await within(fixture.exited,5000);await within(fixture.closed,5000);
    assert.equal(supervisor.stderrBytes(),0);assert.equal(fixture.stderrBytes(),0);
  } finally {
    for(const item of [fixture,supervisor]) if(!item.terminal()) item.child.kill();
    await Promise.all([fixture,supervisor].map(async item=>{await within(item.exited,5000);await within(item.closed,5000);}));
    rmSync(directory,{recursive:true,force:true});
  }
});
