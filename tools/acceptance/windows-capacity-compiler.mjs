// Derived, dev-only compiler control. This never runs the production pipe
// entrypoint and is not a substitute connector or startup acceptance path.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';

const digest = value => createHash('sha256').update(value).digest('hex');
export const COMPILER_SOURCE = Object.freeze({
  workerSha256: 'fffc8e3fbe3ea2b47e0aa7c63ff1c4a5bec3104749f65c3d5c223098bc98a100',
  prefixSha256: '87008069206b02e19ac0c74a8aa672d05c51592c074ba3bc0b94b679ddf90f4d',
});
export const COMPILER_ORDER = Object.freeze(['implicit', 'explicit', 'explicit', 'implicit']);
export const COMPILER_DEADLINE_MS = 15_000;
const ARGS = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command']);
const START = "$ProgressPreference = 'SilentlyContinue'; & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('";
const END = "'))))";
const RUN = '[AgentCommsPipeClient]::Run($env:AGENT_COMMS_PIPE_NAME)\n';
const fail = () => { throw new Error('compiler-source-mismatch'); };

export function deriveCompilerPrefix(file, args) {
  if (file !== 'powershell.exe' || !Array.isArray(args) || args.length !== ARGS.length + 1
      || !ARGS.every((arg, index) => args[index] === arg)) fail();
  const command = args.at(-1);
  if (typeof command !== 'string' || command.length > 8192 || !command.startsWith(START) || !command.endsWith(END)) fail();
  const encoded = command.slice(START.length, -END.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length % 2) fail();
  const worker = bytes.toString('utf16le');
  if (digest(worker) !== COMPILER_SOURCE.workerSha256 || !worker.endsWith(RUN)) fail();
  const prefix = worker.slice(0, -RUN.length);
  if (digest(prefix) !== COMPILER_SOURCE.prefixSha256) fail();
  return prefix;
}

// Ask the actual pinned export for its public fixed command through its
// existing constructor seam; no process, pipe or production source mutation.
export function captureCompilerPrefix(connectWindowsPipe, env) {
  let prefix, calls = 0;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), exitCode: 0, signalCode: null });
  let raw;
  try {
    raw = connectWindowsPipe('\\\\.\\pipe\\agent-comms-compiler-control', { env, spawnProcess(file, args, options) {
      calls++;
      if (calls !== 1 || options?.windowsHide !== true || !Array.isArray(options.stdio)
          || options.stdio.length !== 3 || options.stdio.some(value => value !== 'pipe')) fail();
      prefix = deriveCompilerPrefix(file, args);
      return child;
    } });
    raw.on('error', () => {});
    if (calls !== 1 || prefix === undefined) fail();
    return prefix;
  } finally {
    try { raw?.destroy(); } catch { /* Only in-memory capture streams exist. */ }
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
  }
}

const literal = record => `[Console]::Out.WriteLine('${JSON.stringify(record)}');[Console]::Out.Flush();`;
const phase = value => `$phase='${value}';` + literal({ id: -1, ok: true, phase: value });
export function compilerControlArgs(prefix, variant) {
  if (typeof prefix !== 'string' || digest(prefix) !== COMPILER_SOURCE.prefixSha256
      || !['implicit','explicit'].includes(variant)) fail();
  const observe = `$phase='module-observation';$manifest=[IO.Path]::Combine($PSHOME,'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1');$present=[IO.File]::Exists($manifest);$expected=[string]::Equals([IO.Path]::GetFullPath($PSHOME),[IO.Path]::GetFullPath([IO.Path]::Combine([Environment]::GetEnvironmentVariable('SystemRoot'),'System32\\WindowsPowerShell\\v1.0')),[StringComparison]::OrdinalIgnoreCase);[Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"module-observation","manifestPresent":'+$present.ToString().ToLowerInvariant()+',"expectedPSHome":'+$expected.ToString().ToLowerInvariant()+'}');[Console]::Out.Flush();if (-not $present -or -not $expected) {throw 'compiler-home-refused'};`;
  const load = variant === 'explicit' ? phase('import-utility') + 'Import-Module -Name $manifest -ErrorAction Stop;' + phase('utility-imported') : '';
  const command = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + phase('compiler-entry')
    + 'try {' + observe + load + phase('compiler-compile') + prefix + phase('compiler-compiled')
    + literal({ id: 0, ok: true, phase: 'ready' })
    + `} catch {[Console]::Out.WriteLine('{"id":0,"ok":false,"failure":{"check":"compiler-control-failed","phase":"'+$phase+'"}}');[Console]::Out.Flush();exit 1}`;
  return [...ARGS, command];
}

export async function collectCompilerControls(probe, record) {
  let mayContinue = true;
  for (const [index, variant] of COMPILER_ORDER.entries()) {
    if (!mayContinue) {
      await record({ index, variant, status: 'not-run', reason: 'prior-cleanup-unconfirmed' });
      continue;
    }
    const result = await probe(variant, index);
    await record({ ...result, index, variant });
    mayContinue = result.ownedTerminalConfirmed === true && result.stdioClosedConfirmed === true
      && result.descendantsEmptyConfirmed === true && result.cleanupConfirmed === true;
  }
}

// The existing supervisor owns all command classification. Drain its one
// in-flight request before the caller stops the fixture or closes the job.
export async function sampleCompilerControl(job, started, { intervalMs = 250 } = {}) {
  let sampling, timer, relayCommandConfirmed = false, rejectGuard, guardError;
  const guardFailed = new Promise((resolve,reject) => {rejectGuard=reject;});
  function sample() {
    if (sampling) return;
    sampling = Promise.resolve().then(() => job.request('sample',{},5000)).then(value => {
      const count = value.totals?.relay?.count;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('control-invalid');
      relayCommandConfirmed ||= count > 0;
    }).catch(error => {guardError ??= error;rejectGuard(guardError);}).finally(() => {sampling=undefined;});
  }
  timer = setInterval(sample,intervalMs);
  try {
    const reply = await Promise.race([started,guardFailed]);
    clearInterval(timer);
    if (sampling) await sampling;
    // A guard refusal can arrive while the already-complete start drains.
    if (guardError) throw guardError;
    if (!relayCommandConfirmed) throw new Error('owned-startup-fault');
    return reply;
  } finally {
    clearInterval(timer);
    if (sampling) await sampling;
  }
}

const COMPILER_PHASES = Object.freeze(['compiler-entry','module-observation','import-utility','utility-imported','compiler-compile','compiler-compiled']);
export function createCompilerObserver(owned, variant, now) {
  if (!['implicit','explicit'].includes(variant) || typeof now !== 'function') fail();
  const expected = variant === 'explicit' ? COMPILER_PHASES : COMPILER_PHASES.filter(value => !['import-utility','utility-imported'].includes(value));
  const started = now(), rows = [];
  let resolve, reject, pending = true, completed = false, buffer = '', bytes = 0, rejected, moduleObservation;
  const ready = new Promise((yes,no) => { resolve=yes;reject=no; }); ready.catch(() => {});
  function refuse(code) { rejected ??= code; if (pending) {pending=false;reject(new Error(code));} }
  function receive(record) {
    if (completed) {refuse('control-invalid');return;}
    if (!record || typeof record !== 'object' || Array.isArray(record)) {refuse('control-invalid');return;}
    if (record.id === -1) {
      const observation = record.phase === 'module-observation';
      const keys = observation ? ['id','ok','phase','manifestPresent','expectedPSHome'] : ['id','ok','phase'];
      if (record.ok !== true || record.phase !== expected[rows.length] || Object.keys(record).length !== keys.length
          || Object.keys(record).some(key => !keys.includes(key))
          || (observation && (typeof record.manifestPresent !== 'boolean' || typeof record.expectedPSHome !== 'boolean'))) {refuse('control-invalid');return;}
      const elapsedMs = Math.floor(now()-started);
      rows.push({ phase: record.phase, ...(Number.isSafeInteger(elapsedMs) && elapsedMs >= (rows.at(-1)?.elapsedMs ?? 0) && elapsedMs <= 30_000 ? { elapsedMs } : { timingUnavailable: true }) });
      if (observation) moduleObservation = { manifestPresent: record.manifestPresent, expectedPSHome: record.expectedPSHome };
    } else if (record.id === 0 && record.ok === true && record.phase === 'ready'
        && Object.keys(record).length === 3 && rows.length === expected.length) {
      if (pending) {pending=false;completed=true;resolve();}
    } else if (record.id === 0 && record.ok === false && Object.keys(record).length === 3
        && record.failure && Object.keys(record.failure).length === 2 && record.failure.check === 'compiler-control-failed'
        && record.failure.phase === rows.at(-1)?.phase) refuse('compiler-control-failed');
    else refuse('control-invalid');
  }
  owned.child.stdout.on('data', chunk => {
    bytes = Math.min(65537, bytes + chunk.length);
    if (rejected) return;
    if (bytes > 65536) {buffer='';refuse('control-output-bound');return;}
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      try {receive(JSON.parse(line));} catch {refuse('control-invalid');return;}
      if (rejected) return;
    }
  });
  owned.child.stdout.on('error', () => refuse('control-closed'));
  owned.stdioClosed.then(() => {
    if (buffer.length) refuse('control-invalid');
    else if (pending) refuse('control-closed');
  });
  return { ready, state: () => ({ phases:rows.map(row=>({...row})), ...(moduleObservation ? {moduleObservation:{...moduleObservation}} : {}),
    ...(rejected ? {check:rejected} : {}) }) };
}

const boundedTerminal = value => ({ code: Number.isSafeInteger(value?.code) ? value.code : null,
  signal: ['SIGTERM','SIGKILL','SIGINT'].includes(value?.signal) ? value.signal : null });
async function within(promise, ms, code) {
  let timer;
  try {return await Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error(code)),ms);})]);}
  finally {clearTimeout(timer);}
}
export async function observeCompilerControl(owned, variant, { now = () => performance.now(), deadlineMs = COMPILER_DEADLINE_MS, cleanupMs = 5000 } = {}) {
  // Timing overrides exist only for local ownership regressions; the hosted
  // caller always supplies the fixed exported fifteen-second work deadline.
  const started=now(), observer=createCompilerObserver(owned,variant,now);
  const receipt={status:'failed',requestDeadlineMs:deadlineMs,ownedTerminalConfirmed:false,stdioClosedConfirmed:false,
    forcedTerminationRequested:false,stderrBytes:0,stderrByteCountCapped:false};
  owned.child.stderr.on('data',chunk=>{receipt.stderrBytes=Math.min(1048577,receipt.stderrBytes+chunk.length);receipt.stderrByteCountCapped=receipt.stderrBytes>1048576;});
  owned.child.stderr.on('error',()=>{receipt.stderrStreamError=true;});
  const remaining=()=>Math.max(1,deadlineMs-Math.floor(now()-started));
  try {
    await within(observer.ready,remaining(),'compiler-deadline');
    const terminal=await within(owned.exited,remaining(),'compiler-deadline');
    await within(owned.stdioClosed,remaining(),'compiler-deadline');
    if (terminal.code !== 0 || terminal.signal !== null || receipt.stderrBytes !== 0 || receipt.stderrStreamError || observer.state().check) throw new Error('compiler-control-failed');
    receipt.status='passed';
  } catch(error) {
    receipt.check=['control-closed','control-invalid','control-output-bound','compiler-deadline','compiler-control-failed'].includes(error?.message) ? error.message : 'compiler-control-failed';
  } finally {
    // Freeze observations before disposal, preserving the original failure.
    Object.assign(receipt,observer.state());
    if (!owned.terminal()) {receipt.forcedTerminationRequested=true;try {owned.child.kill();} catch {/* Bounded confirmation below is authoritative. */}}
    try {receipt.terminal=boundedTerminal(await within(owned.exited,cleanupMs,'compiler-terminal'));receipt.ownedTerminalConfirmed=owned.terminal();} catch {receipt.cleanupCheck='compiler-terminal';}
    try {await within(owned.stdioClosed,cleanupMs,'compiler-terminal');receipt.stdioClosedConfirmed=true;} catch {receipt.cleanupCheck='compiler-terminal';}
    const elapsedMs=Math.ceil(now()-started);
    Object.assign(receipt,Number.isSafeInteger(elapsedMs)&&elapsedMs>=0&&elapsedMs<=30_000 ? {elapsedMs} : {timingUnavailable:true});
  }
  return receipt;
}

// The owned fixture IPC is still a serialization boundary. Reject any extra
// fields or accessors rather than putting an arbitrary child object in reports.
export function projectCompilerObservation(value, variant) {
  const invalid = () => { throw new Error('compiler-control-failed'); };
  function data(object, allowed) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) invalid();
    const result = {};
    for (const key of Object.keys(object)) {
      if (!allowed.includes(key)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(object,key);
      if (!descriptor || !Object.hasOwn(descriptor,'value')) invalid();
      result[key] = descriptor.value;
    }
    return result;
  }
  try {
    if (!['implicit','explicit'].includes(variant)) invalid();
    const row=data(value,['status','requestDeadlineMs','ownedTerminalConfirmed','stdioClosedConfirmed',
      'forcedTerminationRequested','stderrBytes','stderrByteCountCapped','stderrStreamError','phases',
      'moduleObservation','check','terminal','cleanupCheck','elapsedMs','timingUnavailable']);
    if (!['passed','failed'].includes(row.status) || row.requestDeadlineMs !== COMPILER_DEADLINE_MS) invalid();
    for (const key of ['ownedTerminalConfirmed','stdioClosedConfirmed','forcedTerminationRequested','stderrByteCountCapped']) {
      if (typeof row[key] !== 'boolean') invalid();
    }
    if (!Number.isSafeInteger(row.stderrBytes) || row.stderrBytes < 0 || row.stderrBytes > 1048577
        || row.stderrByteCountCapped !== (row.stderrBytes > 1048576)) invalid();
    if (row.stderrStreamError !== undefined && row.stderrStreamError !== true) invalid();
    if (row.check !== undefined && !['control-closed','control-invalid','control-output-bound','compiler-deadline','compiler-control-failed'].includes(row.check)) invalid();
    if (row.cleanupCheck !== undefined && row.cleanupCheck !== 'compiler-terminal') invalid();
    const expected=variant==='explicit'?COMPILER_PHASES:COMPILER_PHASES.filter(phase=>!['import-utility','utility-imported'].includes(phase));
    if (!Array.isArray(row.phases) || row.phases.length > expected.length) invalid();
    let last=-1;
    row.phases=Array.from({length:row.phases.length},(_,index)=>{
      const descriptor=Object.getOwnPropertyDescriptor(row.phases,String(index));
      if (!descriptor || !Object.hasOwn(descriptor,'value')) invalid();
      const phase=descriptor.value;
      const clean=data(phase,['phase','elapsedMs','timingUnavailable']);
      if (clean.phase !== expected[index]) invalid();
      if (clean.elapsedMs !== undefined) {
        if (clean.timingUnavailable !== undefined || !Number.isSafeInteger(clean.elapsedMs) || clean.elapsedMs < 0 || clean.elapsedMs < last || clean.elapsedMs > 30000) invalid();
        last=clean.elapsedMs;
      } else if (clean.timingUnavailable !== true) invalid();
      return clean;
    });
    if (row.moduleObservation !== undefined) {
      row.moduleObservation=data(row.moduleObservation,['manifestPresent','expectedPSHome']);
      if (Object.keys(row.moduleObservation).length !== 2 || Object.values(row.moduleObservation).some(value=>typeof value!=='boolean')) invalid();
    }
    if (row.terminal !== undefined) {
      row.terminal=data(row.terminal,['code','signal']);
      if (Object.keys(row.terminal).length !== 2 || (row.terminal.code !== null && (!Number.isSafeInteger(row.terminal.code)||row.terminal.code < 0||row.terminal.code > 0xffffffff))
          || ![null,'SIGTERM','SIGKILL','SIGINT'].includes(row.terminal.signal)) invalid();
    }
    if (row.elapsedMs !== undefined) {
      if (row.timingUnavailable !== undefined || !Number.isSafeInteger(row.elapsedMs) || row.elapsedMs < 0 || row.elapsedMs > 30000) invalid();
    } else if (row.timingUnavailable !== true) invalid();
    if (row.status === 'passed' && (row.check !== undefined || row.cleanupCheck !== undefined || row.stderrBytes !== 0
        || row.stderrStreamError || !row.ownedTerminalConfirmed || !row.stdioClosedConfirmed || row.forcedTerminationRequested
        || row.terminal?.code !== 0 || row.terminal?.signal !== null || row.phases.length !== expected.length
        || row.moduleObservation?.manifestPresent !== true || row.moduleObservation?.expectedPSHome !== true
        || row.timingUnavailable || row.phases.some(phase=>phase.timingUnavailable))) invalid();
    return row;
  } catch { invalid(); }
}
