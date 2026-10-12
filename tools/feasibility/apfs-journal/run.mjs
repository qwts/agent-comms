#!/usr/bin/env node
// Explicit test-only command. Not imported by production or the normal test suite.
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const MiB=1024*1024;
const args=process.argv.slice(2);
const inventoryIndex=args.indexOf('--inventory');
const inventoryPath=inventoryIndex<0 ? undefined : args[inventoryIndex+1];
if(inventoryIndex>=0) args.splice(inventoryIndex,2);
const withSnapshot=args.includes('--snapshot');
const comparison=args.includes('--comparison');
const fixedNames=args.includes('--fixed-names');
if (process.platform!=='darwin' || !inventoryPath || !path.isAbsolute(inventoryPath)
  || args.some(x=>!['--snapshot','--comparison','--fixed-names'].includes(x)) || new Set(args).size!==args.length
  || Number(comparison)+Number(withSnapshot)+Number(fixedNames)>1) {
  throw new Error('requires-darwin-inventory-and-exclusive-lab-mode');
}
const rootName=/^owner-journal-apfs-(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|preflight\.[A-Za-z0-9]{6})$/;
const allowedParents=new Set([fs.realpathSync('/tmp'),fs.realpathSync(os.tmpdir())]);
function validateRoot(candidate) {
  if(typeof candidate!=='string' || !path.isAbsolute(candidate) || !allowedParents.has(path.dirname(candidate))
    || !rootName.test(path.basename(candidate)) || fs.realpathSync(candidate)!==candidate) throw new Error('retained-root-path');
  const info=fs.lstatSync(candidate);
  if(!info.isDirectory() || info.uid!==process.getuid() || (info.mode&0o7777)!==0o700) throw new Error('retained-lab-root-type');
}
function readInventory(file) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const info=fs.fstatSync(fd);
    if(!info.isFile() || info.uid!==process.getuid() || (info.mode&0o7777)!==0o600
      || info.nlink!==1 || info.size<1 || info.size>16384) throw new Error('inventory-file');
    const value=JSON.parse(fs.readFileSync(fd,'utf8'));
    if(!value || typeof value!=='object' || Object.keys(value).sort().join(',')!=='roots,v'
      || value.v!==1 || !Array.isArray(value.roots) || value.roots.length>15
      || new Set(value.roots).size!==value.roots.length) throw new Error('inventory-shape');
    value.roots.forEach(validateRoot);return value.roots;
  } finally {fs.closeSync(fd);}
}
// Trusted, reviewed local manifest lists every retained root from prior receipts;
// no unrelated shared-temporary-directory scan or implicit deletion occurs.
const retainedRoots=readInventory(inventoryPath);
const id=randomUUID();
const root=path.join(fs.realpathSync('/tmp'),`owner-journal-apfs-${id}`);
fs.mkdirSync(root,{mode:0o700});
const image=path.join(root,'journal.dmg');
const mount=path.join(root,'mnt');
const executable=path.join(root,'allocator');
const build=path.join(root,'build');
const nonce=randomBytes(16).toString('hex');
const source=fileURLToPath(new URL(fixedNames ? './fixed-allocator.c' : './allocator.c',import.meta.url));
const result=path.join(root,'results.jsonl');
let logBytes=0, attached=null, attachmentMayExist=false, volumeUuid=null, outcome='failed',primaryFailure=null;
let aggregateRetainedBytes=0;
const imageMiB=comparison || fixedNames ? 64 : 128;
let lastSuccessfulPhase=null,lastDurablePhase=null,fixedPublicationOutcome='not-started';
const deadline=Date.now()+600_000;
const slotCaps=new Map([
  ['acceptance',4096],['action',32768],['challenge',32768],['presence',4096],['receipt',4096],
  ['authorization',4096],['release',4096],['outcome',4096],['observation',2048],['resolution',2048],['scratch',32768],
]);
console.log(JSON.stringify({labRoot:root,holdMustAlreadyBeReleased:true}));

function record(value) {
  const bytes=Buffer.from(`${JSON.stringify({at:new Date().toISOString(),...value})}\n`);
  if (logBytes+bytes.length>4*MiB) throw new Error('result-ceiling');
  fs.appendFileSync(result,bytes,{mode:0o600}); logBytes+=bytes.length;
}
function rootAllocation(directory) {
  // Never descend into mnt: those allocations are backed by the one image and
  // counting both would double count. Never follow symlinks or unknown entries.
  let allocated=0;
  for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    const p=path.join(directory,entry.name); const st=fs.lstatSync(p);
    if (entry.name==='mnt') { if (!st.isDirectory()) throw new Error('mountpoint-type'); continue; }
    if (entry.name==='build') {
      if (!st.isDirectory() || st.uid!==process.getuid()) throw new Error('build-directory-type');
      const names=fs.readdirSync(p);
      if(names.length>16) throw new Error('build-entry-ceiling');
      let buildBytes=0;
      for(const name of names) {
        const artifact=fs.lstatSync(path.join(p,name));
        if(!artifact.isFile() || artifact.uid!==process.getuid() || artifact.nlink!==1) throw new Error('build-artifact-type');
        buildBytes+=artifact.blocks*512;
      }
      if(buildBytes>8*MiB) throw new Error('build-allocation-ceiling');
      allocated+=buildBytes;continue;
    }
    if (!['journal.dmg','allocator','results.jsonl','journal.dmg.gz','archive-verification.json','archive-removal.json'].includes(entry.name) || !st.isFile()
      || st.uid!==process.getuid() || st.nlink!==1) throw new Error('unexpected-lab-artifact');
    allocated+=st.blocks*512;
    const permittedImageMiB=directory===root ? imageMiB : 128;
    if (entry.name==='journal.dmg' && (st.size>(permittedImageMiB+16)*MiB
      || st.blocks*512>(permittedImageMiB+32)*MiB)) throw new Error('image-ceiling');
    if (entry.name==='journal.dmg.gz' && (st.size>32*MiB || st.blocks*512>32*MiB
      || (st.mode&0o7777)!==0o600)) throw new Error('archive-ceiling');
    if (entry.name==='archive-verification.json') {
      if(st.size<1 || st.size>16384 || (st.mode&0o7777)!==0o600) throw new Error('archive-receipt-ceiling');
      const receipt=JSON.parse(fs.readFileSync(p,'utf8'));
      if(receipt.v!==1 || !['verified','failed'].includes(receipt.status)
        || receipt.image!==path.join(directory,'journal.dmg')
        || receipt.archive!==path.join(directory,'journal.dmg.gz')
        || receipt.originalRemoved!==false) throw new Error('archive-receipt-binding');
    }
    if (entry.name==='archive-removal.json') {
      if(st.size<1 || st.size>16384 || (st.mode&0o7777)!==0o600) throw new Error('archive-removal-ceiling');
      const receipt=JSON.parse(fs.readFileSync(p,'utf8'));
      if(receipt.v!==1 || receipt.status!=='removed'
        || receipt.image!==path.join(directory,'journal.dmg')
        || receipt.archive!==path.join(directory,'journal.dmg.gz')
        || receipt.priorVerificationReceiptPreserved!==true) throw new Error('archive-removal-binding');
    }
    if (entry.name==='allocator' && (st.size>8*MiB || st.blocks*512>8*MiB)) throw new Error('helper-ceiling');
    if (entry.name==='results.jsonl' && st.size>4*MiB) throw new Error('result-ceiling');
  }
  if (allocated>192*MiB) throw new Error('live-allocation-ceiling');
  return allocated;
}
function footprint() {
  const roots=new Set([...retainedRoots,root]);
  if(roots.size>16) throw new Error('retained-lab-root-count');
  aggregateRetainedBytes=0;
  for(const candidate of roots) {validateRoot(candidate);aggregateRetainedBytes+=rootAllocation(candidate);}
  // Include retained attempt and compiler-preflight roots. Leave eight MiB
  // below the requested live-file ceiling; do not infer host CoW/metadata use.
  if(aggregateRetainedBytes>248*MiB) throw new Error('aggregate-retained-allocation-ceiling');
  return rootAllocation(root);
}
async function command(program,args,{input,timeout=60_000,killWhenReady=false}={}) {
  if (Date.now()>=deadline) throw new Error('overall-timeout');
  record({event:'command-start',program,args});
  const child=spawn(program,args,{stdio:['pipe','pipe','pipe'],detached:true,env:{...process.env,TMPDIR:build}});
  let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),cause=null,ready=false,killTimer;
  const kill=(why)=>{
    if (!cause) cause=why;
    try { process.kill(-child.pid,'SIGKILL'); } catch (e) { if(e.code!=='ESRCH') cause='kill-failed'; }
  };
  const timer=setTimeout(()=>kill('command-timeout'),Math.min(timeout,deadline-Date.now()));
  const allocationTimer=setInterval(()=>{try{footprint();}catch(e){kill(e.message);}},250);
  const collect=(stream,which)=>stream.on('data',bytes=>{
    const saved=which==='stdout'?stdout:stderr;
    if (saved.length+bytes.length>64*1024) {kill('command-output-ceiling');return;}
    if (which==='stdout') stdout=Buffer.concat([saved,bytes]); else stderr=Buffer.concat([saved,bytes]);
    if (killWhenReady && !ready && stdout.toString('utf8').split('\n').some(line=>{
      try{return JSON.parse(line).event==='ready';}catch{return false;}
    })) {
      ready=true;
      // Kill only this owned child after it reports that all reservation FDs
      // were closed and the containing directory flushed.
      child.kill('SIGKILL');
      killTimer=setTimeout(()=>kill('child-kill-timeout'),5000);
    }
  });
  collect(child.stdout,'stdout');collect(child.stderr,'stderr');
  child.stdin.on('error',()=>{});child.stdin.end(input);
  const terminal=await new Promise(resolve=>{
    let spawnError;
    child.once('error',e=>{spawnError=e.code;});
    child.once('close',(code,signal)=>resolve({code,signal,spawnError}));
  });
  clearTimeout(timer);clearTimeout(killTimer);clearInterval(allocationTimer);
  if(fixedNames && program===executable) {
    for(const line of stdout.toString('utf8').split('\n')) {
      let event;try{event=JSON.parse(line);}catch{continue;}
      if(event.event==='fixed-phase') {
        lastSuccessfulPhase=`${event.slot}:${event.phase}`;
        if(event.durableFlushCompleted===true) lastDurablePhase=lastSuccessfulPhase;
      }
    }
  }
  record({event:'command-terminal',program,...terminal,cause,ready,lastSuccessfulPhase,lastDurablePhase,
    stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8'),allocatedLiveBytes:footprint(),aggregateRetainedBytes});
  if (cause || terminal.spawnError || (killWhenReady
    ? !(ready && terminal.signal==='SIGKILL') : terminal.code!==0)) throw new Error(cause??'command-failed');
  return stdout;
}
async function plist(program,args) {
  const xml=await command(program,args);
  const json=await command('/usr/bin/plutil',['-convert','json','-o','-','-'],{input:xml});
  return JSON.parse(json.toString('utf8'));
}
async function imageIdentity() {
  const info=await plist('/usr/bin/hdiutil',['info','-plist']);
  const matches=(info.images??[]).filter(i=>i['image-path']===image);
  if (matches.length!==1) throw new Error('image-not-exclusively-attached');
  const devices=(matches[0]['system-entities']??[]).map(e=>e['dev-entry']);
  if (!attached || !devices.includes(attached.whole)) throw new Error('image-device-mismatch');
  return matches[0];
}
async function verifyMounted() {
  await imageIdentity();
  const info=await plist('/usr/sbin/diskutil',['info','-plist',mount]);
  if (info.MountPoint!==mount || String(info.FilesystemType).toLowerCase()!=='apfs'
    || `/dev/${info.DeviceIdentifier}`!==attached.volume || !info.VolumeUUID
    || (volumeUuid && info.VolumeUUID!==volumeUuid)) throw new Error('mounted-volume-mismatch');
  volumeUuid=info.VolumeUUID;
  const st=fs.statSync(mount);
  if (st.dev===fs.statSync(root).dev) throw new Error('mount-is-host-filesystem');
  record({event:'verified-volume',device:attached.volume,wholeDevice:attached.whole,volumeUuid,dev:st.dev});
  return info;
}
async function attach() {
  if(attached) throw new Error('already-attached');
  attachmentMayExist=true;
  const info=await plist('/usr/bin/hdiutil',['attach','-plist','-nobrowse','-noautoopen','-owners','on','-mountpoint',mount,image]);
  const entities=info['system-entities']??[];
  const mounted=entities.filter(e=>e['mount-point']===mount);
  const whole=entities.find(e=>/^\/dev\/disk[0-9]+$/.test(e['dev-entry']??''));
  if(mounted.length!==1 || !whole || !/^\/dev\/disk[0-9]+s[0-9]+$/.test(mounted[0]['dev-entry']??'')) {
    // Uncertain attachment stays intact. Never infer a detach device from paths.
    throw new Error('attachment-shape-unsupported');
  }
  attached={whole:whole['dev-entry'],volume:mounted[0]['dev-entry']};
  await verifyMounted();
}
async function detach() {
  if(!attached) return;
  // This invocation's recorded image path must still own the exact root device.
  await imageIdentity();
  const old=attached;
  await command('/usr/bin/hdiutil',['detach',old.whole],{timeout:30_000});
  const info=await plist('/usr/bin/hdiutil',['info','-plist']);
  if((info.images??[]).some(i=>i['image-path']===image)) throw new Error('detach-unconfirmed');
  attached=null;attachmentMayExist=false;record({event:'detached',device:old.whole});
}
async function native(operation,{crash=false,timeout=60_000}={}) {
  await verifyMounted();
  const bytes=await command(executable,[operation,mount,nonce],{killWhenReady:crash,timeout});
  const events=bytes.toString('utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const names=fs.readdirSync(path.join(mount,'journal'));
  if(fixedNames && (names.length>12 || names.some(n=>!['filler',...[...slotCaps.keys()].map(k=>`${k}.record`)].includes(n)))) {
    throw new Error('fixed-final-name-bound');
  }
  if(names.length>24 || names.some(n=>n.length>64 || !/^(reserve\.|control\.)?(acceptance|action|challenge|presence|receipt|authorization|release|outcome|observation|resolution|scratch)(\.record)?$|^filler$/.test(n))) {
    throw new Error('journal-name-bound');
  }
  return events;
}
function verifyFixedFrames(prefix=false) {
  const hash=bytes=>createHash('sha256').update(bytes).digest();
  const allZero=bytes=>bytes.every(b=>b===0);
  const summaries=[];let index=0;
  for(const [slot,cap] of slotCaps) {
    const filename=path.join(mount,'journal',`${slot}.record`);
    const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {
      const stat=fs.fstatSync(fd),size=cap+256;
      if(!stat.isFile() || stat.uid!==process.getuid() || stat.nlink!==1
        || (stat.mode&0o7777)!==0o600 || stat.dev!==fs.statSync(mount).dev
        || stat.size!==size || stat.blocks*512<size) throw new Error('fixed-node-file-binding');
      const bytes=Buffer.alloc(size);let done=0;
      while(done<size) {
        const n=fs.readSync(fd,bytes,done,size-done,done);
        if(n<=0) throw new Error('fixed-node-short-read');done+=n;
      }
      if(prefix && !['acceptance','action'].includes(slot)) {
        if(!allZero(bytes)) throw new Error('fixed-node-unexpected-prefix-slot');
      } else {
        const header=bytes.subarray(0,128),payload=bytes.subarray(128,128+cap),trailer=bytes.subarray(128+cap);
        const context=hash(Buffer.from(JSON.stringify({namespaceDigest:nonce+nonce,
          requestId:'00000000-0000-4000-8000-000000000077',slot,v:1})));
        if(header.toString('ascii',0,8)!=='ODJSLOT1' || header.readUInt16BE(8)!==1
          || header.readUInt16BE(10)!==index+1 || header.readUInt32BE(12)!==0
          || header.readUInt32BE(16)!==cap || header.readUInt32BE(20)!==cap
          || header.readBigUInt64BE(24)!==1n || !header.subarray(32,64).equals(context)
          || !header.subarray(64,96).equals(hash(payload)) || !allZero(header.subarray(96))
          || trailer.toString('ascii',0,8)!=='ODJCOM01' || trailer.readUInt16BE(8)!==1
          || trailer.readUInt16BE(10)!==index+1 || trailer.readUInt32BE(12)!==0
          || trailer.readBigUInt64BE(16)!==1n || trailer.readUInt32BE(24)!==cap
          || trailer.readUInt32BE(28)!==0 || !allZero(trailer.subarray(96))
          || !trailer.subarray(64,96).equals(context)
          || !trailer.subarray(32,64).equals(hash(Buffer.concat([Buffer.from('owner-journal-frame-v1\n'),header,payload])))) {
          throw new Error('fixed-node-frame-grammar-digest-binding');
        }
        if(!payload.every((byte,k)=>byte===1+((k+index+1)%251))) throw new Error('fixed-node-deterministic-content');
        summaries.push({slot,bytes:size,sha256:hash(bytes).toString('hex')});
      }
    } finally {fs.closeSync(fd);}
    index++;
  }
  record({event:'fixed-independent-node-frame-verification',prefix,frames:summaries,
    acceptanceEstablished:false,authority:false});
}
const baselineInodes=new Map();
function observations(events,label,seeded=false) {
  const inodes=events.filter(e=>e.event==='inode');
  if(inodes.length!==11 || new Set(inodes.map(e=>e.slot)).size!==11) throw new Error('inode-observation-count');
  for(const e of inodes) {
    if(!slotCaps.has(e.slot) || !Number.isSafeInteger(e.blocks512)
      || e.blocks512*512<slotCaps.get(e.slot)+256 || !Number.isSafeInteger(e.ino)
      || e.bytes!==((seeded || fixedNames) ? slotCaps.get(e.slot)+256 : 0)) throw new Error('allocation-or-length-not-observed');
    const previous=baselineInodes.get(e.slot);
    if(previous && (previous.ino!==e.ino || e.blocks512<previous.blocks512)) throw new Error('allocation-or-inode-not-retained');
    if(!previous) baselineInodes.set(e.slot,e);
  }
  record({event:'observations-validated',label,slots:inodes});
}
try {
  const host=fs.statfsSync(root);
  if(host.bavail*host.bsize<512*MiB) throw new Error('lab-host-space-guard');
  footprint();
  if(aggregateRetainedBytes+(imageMiB+32+20)*MiB>248*MiB) throw new Error('projected-retained-allocation-ceiling');
  record({event:'limits',imageMiB,liveAllocatedCeilingMiB:192,aggregateRetainedCeilingMiB:248,overallTimeoutSeconds:600,
    snapshot:withSnapshot,comparison,fixedNames,physicalCapacitySupported:false,powerLossTested:false});
  if(fixedNames) {
    record({event:'tested-source-hashes',files:Object.fromEntries(['allocator.c','fixed-allocator.c','run.mjs'].map(name=>[name,
      createHash('sha256').update(fs.readFileSync(new URL(`./${name}`,import.meta.url))).digest('hex')]))});
  }
  record({event:'reviewed-retained-inventory',manifest:inventoryPath,roots:retainedRoots,aggregateRetainedBytes});
  const fixture=JSON.parse(fs.readFileSync(new URL('../../../tests/fixtures/owner-decisions/journal-budget-v1.json',import.meta.url)));
  const aliases={'original-action':'action','prepared-challenge':'challenge','initial-outcome':'outcome',
    'observation-reference':'observation','terminal-reference':'resolution'};
  if(fixture.limits.framingBytes!==256 || fixture.limits.namedFileEntries!==24
    || fixture.limits.scratchPayloadBytes!==slotCaps.get('scratch') || fixture.stores.broker.slots.length!==10
    || fixture.stores.broker.slots.some(s=>slotCaps.get(aliases[s.name]??s.name)!==s.payloadCap)) throw new Error('contract-cap-drift');
  record({event:'contract-cap-comparison',framingBytes:256,slots:Object.fromEntries(slotCaps)});
  fs.mkdirSync(build,{mode:0o700});
  await command('/usr/bin/clang',['-std=c11','-Wall','-Wextra','-Werror','-O2','-c',source,'-o',path.join(build,'allocator.o')]);
  await command('/usr/bin/clang',[path.join(build,'allocator.o'),'-o',executable]);
  await command('/usr/bin/hdiutil',['create','-size',`${imageMiB}m`,'-layout','NONE','-fs','APFS',
    '-type','UDIF','-nospotlight','-volname',`ODJ-${id.slice(0,8)}`,'-o',image]);
  footprint();fs.mkdirSync(mount,{mode:0o700});
  await attach();fs.chmodSync(mount,0o700);
  fs.writeFileSync(path.join(mount,'.lab-identity'),nonce,{mode:0o600,flag:'wx'});
  const identity=fs.openSync(path.join(mount,'.lab-identity'),'r');fs.fsyncSync(identity);fs.closeSync(identity);
  if(fixedNames) {
    await native('reserve-hold',{crash:true,timeout:30_000});
    observations(await native('verify-zero'),'fixed-zero-after-owned-child-sigkill');
    await detach();await attach();
    observations(await native('verify-zero'),'fixed-zero-after-detach-remount');
    await native('fill',{timeout:180_000});
    observations(await native('verify-zero'),'fixed-zero-after-fill-before-first-nonzero-write');
    fixedPublicationOutcome='uncertain';
    await native('commit-crash',{crash:true,timeout:30_000});
    record({event:'fixed-kill-before-flush',outcome:'uncertain',lastSuccessfulPhase,lastDurablePhase,
      acceptanceEstablished:false,authority:false});
    await native('inspect-prefix'); // Visible valid trailer is explicitly NOT durable acceptance.
    verifyFixedFrames(true);
    record({event:'fixed-visible-prefix',outcome:'uncertain',acceptanceEstablished:false,authority:false});
    await native('recover-prefix'); // Explicit full flush before any saved-record finding.
    fixedPublicationOutcome='recovery-flushed-nonauthorizing';
    record({event:'fixed-prefix-recovery',outcome:fixedPublicationOutcome,acceptanceEstablished:false,authority:false});
    await native('commit-rest');
    observations(await native('verify'),'fixed-all-maximal-frames-before-remount',true);
    verifyFixedFrames();
    await detach();await attach();
    observations(await native('verify'),'fixed-all-maximal-frames-after-remount',true);
    verifyFixedFrames();
    fixedPublicationOutcome='verified-test-frames-nonauthorizing';
  } else {
    await native('reserve-hold',{crash:true,timeout:30_000});
    observations(await native('observe'),'after-child-sigkill-eof-zero');
    if(comparison) {
      const controls=(await native('control-reserve')).filter(e=>e.event==='inode');
      if(controls.length!==11 || new Set(controls.map(e=>e.slot)).size!==11
        || controls.some(e=>!slotCaps.has(e.slot) || e.bytes!==0 || e.blocks512!==0)) throw new Error('unreserved-control-baseline');
      record({event:'unreserved-control-baseline',slots:controls});
    }
    await detach();await attach();
    observations(await native('observe'),'after-detach-remount-eof-zero');
    // Essential: exhaust the disposable filesystem before the FIRST payload write.
    await native('fill',{timeout:180_000});
    observations(await native('observe'),'after-fill-before-first-write');
    if(comparison) {
      record({event:'comparison-group-start',group:'unreserved-first',reclaim:false});
      const controls=await native('control-seed');
      const results=controls.filter(e=>e.event==='control-result');
      if(results.length!==11 || new Set(results.map(e=>e.slot)).size!==11) throw new Error('control-result-count');
      record({event:'comparison-control-results',results,
        allCompleted:results.every(e=>e.completed),causalityEstablished:false,order:'control-first'});
      observations(await native('observe'),'after-control-before-reserved-first-write');
      record({event:'comparison-group-start',group:'reserved-second',reclaim:false});
    }
    await native('seed'); // First writes consume the reserved extents, at full caps.
    observations(await native('observe'),'after-first-max-write',true);
    if(withSnapshot) {
      await verifyMounted();
      await native('snapshot');
      record({event:'snapshot-observed',volumeUuid});
    }
    await native('overwrite');
    observations(await native('observe'),'after-whole-file-max-overwrite',true);
    await native('publish');
    observations(await native('observe'),'after-exclusive-link-publication',true);
    await detach();await attach();
    observations(await native('observe'),'after-published-remount',true);
    observations(await native('verify'),'after-published-remount-generation-two-content',true);
  }
  outcome='observed-pass';
} catch(error) {
  primaryFailure=error.message;record({event:'lab-failed',code:primaryFailure});
  // Retain all payload, reservations, filler and image. No retry, quota refund,
  // automatic flag fallback, unmount force or cleanup of uncertain artifacts.
  if(attached) {
    try {await native('observe',{timeout:10_000});} catch(observeError) {
      record({event:'failure-observation-unavailable',code:observeError.message});
    }
  }
} finally {
  try {await detach();} catch(error) {
    outcome='failed';primaryFailure??='detach-unconfirmed';
    record({event:'detach-unconfirmed-retained',code:error.message});
  }
  let allocatedLiveBytes=null,allocationError=null;
  try {allocatedLiveBytes=footprint();} catch(error) {allocationError=error.message;aggregateRetainedBytes=null;outcome='failed';}
  record({event:'lab-terminal',outcome,primaryFailure,lastSuccessfulPhase,lastDurablePhase,fixedPublicationOutcome,
    acceptanceEstablished:false,authority:false,attached,attachmentMayExist,allocatedLiveBytes,aggregateRetainedBytes,allocationError,
    limits:'reported task-owned live allocation; excludes host APFS metadata/external snapshots',
    physicalCapacitySupported:false,powerLossTested:false});
  console.log(JSON.stringify({outcome,primaryFailure,lastSuccessfulPhase,lastDurablePhase,fixedPublicationOutcome,
    acceptanceEstablished:false,authority:false,labRoot:root,results:result,
    attachmentUncertain:attachmentMayExist,allocationUnknown:allocationError!==null}));
  if(outcome!=='observed-pass') process.exitCode=1;
}
