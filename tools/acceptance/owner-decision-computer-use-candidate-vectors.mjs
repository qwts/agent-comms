// Proposed-only #250 candidate vectors. This checks static candidate bytes and
// bounded-storage arithmetic; it does not import production parsers, journal,
// presence verifier, authority, or filesystem adapters.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const fixturePath = new URL('../../tests/fixtures/owner-decisions/computer-use-candidate-v1.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath));
const legacyPaths = [
  ['tests/fixtures/owner-decisions/v1.json', '70706e7327b90f8649b0b1f8baa7b59d2e4e8f6f1f33b674dc8472cb7eb951ac'],
  ['tests/fixtures/owner-decisions/issuer-v1.json', 'da8d10b7994edd275c18042a5c418eb634c1bccabc8c47a0f80d9a58bcdb7028'],
  ['tests/fixtures/owner-decisions/effect-evidence-v1.json', '4363adad57e232231d2893c4e20b37b4b28048d307893d6ebf97fb01042de4b4'],
  ['tests/fixtures/owner-decisions/effect-evidence-v2.json', 'ff7385f661bb0b0bbc2b36f94634ba1fd1ebcc359dce130149db8a21257e2410'],
  ['tests/fixtures/owner-decisions/journal-budget-v1.json', 'ea2d8f4c52c49d89dd2d7f8919b978d74ebc518b951e428911125a643b1eb932'],
];
const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root));
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  : JSON.stringify(value);
const bytes = value => Buffer.from(canonical(value), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
const digest = value => assert.match(value, /^[a-f0-9]{64}$/);
const uuid = value => assert.match(value, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const operation = 'soul.computer-use.set';
const behavior = {
  activeCalls: 'continue-authorized-or-running',
  disabled: 'deny-later-computer-use-tool-calls',
  permissionCheck: 'each-call-and-after-approval-wait',
  stop: 'none',
  turn: 'continue-current-turn',
};
const summaries = {
  false: 'enabled=false; deny future computer-use calls while off; current turn and authorized/running tool calls continue',
  true: 'enabled=true; current turn continues',
};
let rejectionCases=0;
function rejects(fn) { assert.throws(fn); rejectionCases++; }
function validateCandidateAction(a) {
  exact(a, ['v','requestId','principal','account','soul','operation','parameters']);
  assert.equal(a.v,1); uuid(a.requestId); assert.match(a.principal,/^principal_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.match(a.soul,/^agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.match(a.account,/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/);
  assert.equal(a.operation,operation); exact(a.parameters,['enabled']); assert.equal(typeof a.parameters.enabled,'boolean');
}
function validateCandidateBindings(a,p,c,text) {
  validateCandidateAction(a);
  assert.equal(p.payloadDigest,sha(bytes(a)));
  const expectedText=`Owner decision ${operation} for ${a.account}/${a.soul}: ${summaries[String(a.parameters.enabled)]}; request ${a.requestId}; payload sha256:${p.payloadDigest}`;
  assert.equal(text,expectedText); assert.equal(p.actionDigest,sha(Buffer.from(expectedText)));
  const plan={v:1,requestId:a.requestId,principal:a.principal,account:a.account,soul:a.soul,operation,
    payloadDigest:p.payloadDigest,actionDigest:p.actionDigest,expected:p.expected,desiredEnabled:a.parameters.enabled,behavior};
  assert.deepEqual(p,plan); assert.equal(c.effectPlanDigest,sha(bytes(plan)));
  for(const k of ['requestId','principal','account','soul','operation']) assert.equal(c[k],a[k]);
  assert.equal(c.payloadDigest,p.payloadDigest); assert.equal(Buffer.from(c.action,'base64url').toString(),bytes(a).toString());
}
function decodeCandidateCanonical(source) {
  const bytesIn=source instanceof Uint8Array ? Buffer.from(source) : Buffer.from(source);
  assert(bytesIn.length>0 && bytesIn.length<=32768);
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytesIn);
  const value=JSON.parse(text); assert.equal(canonical(value),text); return value;
}
function validateCandidateD1(d1, c) {
  exact(d1,['v','aud','brokerKey','requestId','principal','account','soul','operation','payloadDigest','nonce','presenceKey','presenceDigest','iat','exp']);
  assert.equal(d1.requestId,c.requestId); assert.equal(d1.principal,c.principal); assert.equal(d1.account,c.account);
  assert.equal(d1.soul,c.soul); assert.equal(d1.operation,c.operation); assert.equal(d1.payloadDigest,c.payloadDigest); assert.equal(d1.nonce,c.nonce);
}
function validateEffectRecord(r, phase, context, entered=null) {
  exact(r,['v','kind','requestId','payloadDigest','preparationDigest','receiptDigest','effectId','phase','at','detail']);
  assert.equal(r.v,1); assert.equal(r.kind,'effect'); assert.equal(r.phase,phase); assert(Number.isSafeInteger(r.at) && r.at>=0);
  for(const k of ['requestId','payloadDigest','preparationDigest','receiptDigest','effectId']) assert.equal(r[k],context[k]);
  if(phase==='refused') { exact(r.detail,['code']); assert(['expired','expected-state-changed','proposal-not-pending','stage-invalid','target-unavailable','validation-failed','storage-unavailable','trust-unavailable'].includes(r.detail.code)); }
  else {
    exact(r.detail,['kind','beforeEnabled','afterEnabled']); assert.equal(r.detail.kind,'computer-use');
    assert.equal(typeof r.detail.beforeEnabled,'boolean'); assert.equal(typeof r.detail.afterEnabled,'boolean');
    if(phase==='completed') { assert(entered); assert.equal(entered.phase,'entered'); assert.equal(r.detail.beforeEnabled,entered.detail.beforeEnabled); assert.equal(r.detail.afterEnabled,entered.detail.afterEnabled); }
  }
}
function validateReconciliationPair(pair,{finding,preparation,receiptDigest,desiredEnabled,completed=null,refused=null,entered=null}) {
  exact(pair,['v','preimage','record']); assert.equal(pair.v,1);
  const rec=pair.record; exact(rec,['v','kind','requestId','payloadDigest','effectId','auditId','originalDaemonKey','originalDaemonEpoch','reportingDaemonKey','reportingDaemonEpoch','at','finding','basisDigest','observedDigest']);
  const ctx={requestId:preparation.requestId,payloadDigest:preparation.payloadDigest,preparationDigest:sha(bytes(preparation)),receiptDigest,effectId:preparation.effectId};
  assert.equal(rec.v,1); assert.equal(rec.kind,'reconciliation'); assert.equal(rec.finding,finding);
  assert.equal(rec.requestId,ctx.requestId); assert.equal(rec.payloadDigest,ctx.payloadDigest); assert.equal(rec.effectId,ctx.effectId);
  assert.equal(rec.originalDaemonKey,preparation.daemonKey); assert.equal(rec.originalDaemonEpoch,preparation.daemonEpoch);
  assert.equal(rec.observedDigest,sha(bytes(pair.preimage)));
  exact(pair.preimage,['v','kind','enabled']); assert.equal(pair.preimage.v,1); assert.equal(pair.preimage.kind,'computer-use'); assert.equal(typeof pair.preimage.enabled,'boolean');
  if(finding==='indeterminate') { assert.equal(rec.basisDigest,null); assert.equal(completed,null); assert.equal(refused,null); }
  if(finding==='applied') {
    assert(completed); validateEffectRecord(entered,'entered',ctx); validateEffectRecord(completed,'completed',ctx,entered);
    assert.equal(entered.detail.beforeEnabled,preparation.expected.enabled); assert.equal(entered.detail.afterEnabled,desiredEnabled);
    assert.equal(completed.detail.beforeEnabled,preparation.expected.enabled); assert.equal(completed.detail.afterEnabled,desiredEnabled);
    assert.equal(rec.basisDigest,sha(bytes(completed))); assert.equal(pair.preimage.enabled,completed.detail.afterEnabled);
  }
  if(finding==='refused') {
    assert(refused); assert.equal(entered,null); validateEffectRecord(refused,'refused',ctx);
    assert.equal(rec.basisDigest,sha(bytes(refused)));
  }
}
function validateRetainedBytes(node, path='vector') {
  if (!node || typeof node!=='object') return;
  const retained=Array.isArray(node)?null:(node.object??(node.record&&(Object.hasOwn(node,'effectDigest')||Object.hasOwn(node,'canonicalUtf8'))?node.record:null));
  if (retained) {
    assert.equal(typeof node.canonicalUtf8,'string',`${path}.canonicalUtf8 must be retained`);
    const raw=Buffer.from(node.canonicalUtf8,'utf8');
    assert.equal(canonical(retained),node.canonicalUtf8,`${path}.canonicalUtf8`);
    if (Object.hasOwn(node,'bytes')) { assert(Number.isSafeInteger(node.bytes),`${path}.bytes must be an integer`); assert.equal(node.bytes,raw.length,`${path}.bytes`); }
    for (const key of ['digest','challengeDigest','preparationDigest','effectPlanDigest','effectDigest']) {
      if (Object.hasOwn(node,key)) { assert.equal(typeof node[key],'string',`${path}.${key} must be retained`); assert.equal(node[key],sha(raw),`${path}.${key}`); }
    }
    if (Object.hasOwn(node,'payloadDigest')) { assert.equal(typeof node.payloadDigest,'string',`${path}.payloadDigest must be retained`); assert.equal(node.payloadDigest,sha(raw),`${path}.payloadDigest`); }
  }
  if (Array.isArray(node)) node.forEach((child,i)=>validateRetainedBytes(child,`${path}[${i}]`));
  else for (const [key,child] of Object.entries(node)) validateRetainedBytes(child,`${path}.${key}`);
}

function validateCandidateChallenge(c) {
  exact(c,['requestId','principal','account','soul','operation','payloadDigest','action','nonce','acceptedAt','preparedAt','exp','daemonKey','daemonEpoch','watchId','effectPlanDigest']);
  assert.equal(c.operation,operation); digest(c.payloadDigest); digest(c.effectPlanDigest);
  assert.match(c.action,/^[A-Za-z0-9_-]+$/); assert.match(c.nonce,/^[A-Za-z0-9_-]{43}$/);
}
function verifyVector(v) {
  validateRetainedBytes(v,`vectors.${v.id}`);
  const a = v.action.object; exact(a, ['v', 'requestId', 'principal', 'account', 'soul', 'operation', 'parameters']);
  assert.equal(a.operation, operation); exact(a.parameters, ['enabled']); assert.equal(typeof a.parameters.enabled, 'boolean');
  assert.equal(canonical(a), v.action.canonicalUtf8); assert.equal(sha(bytes(a)), v.action.payloadDigest);
  assert.equal(v.action.actionText, `Owner decision ${operation} for ${a.account}/${a.soul}: ${summaries[String(a.parameters.enabled)]}; request ${a.requestId}; payload sha256:${v.action.payloadDigest}`);
  assert.equal(sha(Buffer.from(v.action.actionText)), v.action.actionDigest);
  assert.equal(v.action.displaySummary, summaries[String(a.parameters.enabled)]);
  assert(v.action.actionTextScalars <= 400 && v.action.actionTextUtf8Bytes <= 500);
  const p = v.plan.object; exact(p, ['v','requestId','principal','account','soul','operation','payloadDigest','actionDigest','expected','desiredEnabled','behavior']);
  exact(p.expected, ['enabled','kind']); assert.equal(typeof p.expected.enabled, 'boolean'); assert.equal(p.expected.kind, 'computer-use');
  assert.equal(p.desiredEnabled, a.parameters.enabled); assert.deepEqual(p.behavior, behavior);
  assert.equal(p.payloadDigest, v.action.payloadDigest); assert.equal(p.actionDigest, v.action.actionDigest);
  assert.equal(canonical(p), v.plan.canonicalUtf8); assert.equal(sha(bytes(p)), v.plan.effectPlanDigest);
  const c = v.challenge.object; exact(c, ['requestId','principal','account','soul','operation','payloadDigest','action','nonce','acceptedAt','preparedAt','exp','daemonKey','daemonEpoch','watchId','effectPlanDigest']);
  for (const k of ['requestId','principal','account','soul','operation','payloadDigest']) assert.equal(c[k], a[k] ?? (k === 'payloadDigest' ? v.action.payloadDigest : undefined));
  assert.equal(Buffer.from(c.action,'base64url').toString(), v.action.canonicalUtf8);
  assert.equal(c.nonce, v.d1Payload.object.nonce); assert.equal(c.effectPlanDigest, v.plan.effectPlanDigest);
  assert.equal(canonical(c), v.challenge.canonicalUtf8); assert.equal(sha(bytes(c)), v.challenge.challengeDigest);
  validateCandidateBindings(a,p,c,v.action.actionText);
  const wrapper = v.preparedWrapper.object; exact(wrapper, ['v','challenge','stage']);
  assert.deepEqual(wrapper.challenge,c); assert.equal(wrapper.challenge.effectPlanDigest, v.plan.effectPlanDigest); assert.equal(wrapper.stage, null);
  assert.equal(canonical(wrapper), v.preparedWrapper.canonicalUtf8);
  const d1 = v.d1Payload.object; exact(d1, ['v','aud','brokerKey','requestId','principal','account','soul','operation','payloadDigest','nonce','presenceKey','presenceDigest','iat','exp']);
  assert.equal(d1.nonce, c.nonce); assert.equal(d1.payloadDigest, v.action.payloadDigest); assert.equal(Object.hasOwn(d1,'effectPlanDigest'),false); validateCandidateD1(d1,c);
  const prep = v.preparation.object; exact(prep, ['v','kind','requestId','principal','account','soul','operation','payloadDigest','effectId','actionDigest','nonce','acceptedAt','preparedAt','exp','daemonKey','daemonEpoch','watchId','stage','expected','trustVersion']);
  assert.equal(Object.hasOwn(prep,'effectPlanDigest'),false); assert.deepEqual(prep.expected,p.expected);
  for(const k of ['requestId','principal','account','soul','operation','payloadDigest','nonce','acceptedAt','preparedAt','exp','daemonKey','daemonEpoch','watchId']) assert.equal(prep[k],c[k]);
  assert.equal(prep.actionDigest,v.action.actionDigest);
  assert.equal(prep.actionDigest,v.action.actionDigest); assert.equal(sha(bytes(prep)),v.preparation.preparationDigest);
  assert.equal(v.preparation.bytes,bytes(prep).length);
  const effectContext={requestId:prep.requestId,payloadDigest:prep.payloadDigest,preparationDigest:v.preparation.preparationDigest,receiptDigest:v.entered.object.receiptDigest,effectId:prep.effectId};
  for (const phase of ['entered','completed']) {
    const item=v[phase], r=item.object; validateEffectRecord(r,phase,effectContext,phase==='completed'?v.entered.object:null);
    assert.equal(r.preparationDigest,v.preparation.preparationDigest); assert.deepEqual(r.detail,{kind:'computer-use',beforeEnabled:p.expected.enabled,afterEnabled:p.desiredEnabled});
    assert.equal(sha(bytes(r)),item.digest); assert.equal(item.bytes,bytes(r).length);
  }
  assert.equal(v.completed.effectDigest,v.completed.digest);
  for (const item of v.refusals) { const r=item.record; validateEffectRecord(r,'refused',effectContext); assert.equal(r.preparationDigest,v.preparation.preparationDigest); assert.equal(sha(bytes(r)),item.effectDigest); assert(bytes(r).length <= 4096); }
  const refusalForBasis=v.refusals.find(item=>item.domain==='stale-expected-state').record;
  for (const [name,finding,proof] of [['indeterminatePair','indeterminate',null],['appliedPairWithRetainedCompletion','applied',v.completed.object],['refusedPairWithRetainedRefusal','refused',refusalForBasis]]) {
    const pair=v.reconciliation[name].object;
    validateReconciliationPair(pair,{finding,preparation:prep,receiptDigest:effectContext.receiptDigest,desiredEnabled:p.desiredEnabled,completed:finding==='applied'?proof:null,refused:finding==='refused'?proof:null,entered:finding==='applied'?v.entered.object:null});
    assert.equal(bytes(pair).length,v.reconciliation[name].bytes);
  }
  assert.equal(v.p1Binding.action,v.action.actionDigest); assert.equal(v.p1Binding.nonce,c.nonce); assert.equal(v.p1Binding.signatureGenerated,false);
}
assert.equal(fixture.schemaVersion,1);
assert.match(fixture.status,/Proposed candidate vectors only/);
for(const [path, expected] of legacyPaths) {
  const actual=sha(read(path));
  assert.equal(actual,expected,`${path} legacy bytes changed`);
}
for(const v of fixture.vectors) verifyVector(v);
const validAction=fixture.vectors[0].action.object;
for(const mutate of [
  a=>{delete a.parameters;},
  a=>{delete a.parameters.enabled;},
  a=>{a.parameters.enabled=null;},
  a=>{a.parameters.enabled='false';},
  a=>{a.parameters.enabled=0;},
  a=>{a.parameters.extra=false;},
  a=>{a.operation='cold-wake.set';},
  a=>{a.soul='agent_00000000-0000-4000-8000-000000000002';a.payloadDigest='0'.repeat(64);},
  a=>{a.principal='principal_0000000-0000-4000-8000-000000000002';},
  a=>{a.requestId='00000000-0000-1000-8000-000000000001';},
  a=>{a.soul='agent_00000000-0000-9000-8000-000000000002';},
]) { const bad=JSON.parse(JSON.stringify(validAction)); mutate(bad); rejects(()=>validateCandidateAction(bad)); }
const validChallenge=fixture.vectors[0].challenge.object;
for(const mutate of [
  c=>{delete c.effectPlanDigest;},
  c=>{c.effectPlanDigest='F'.repeat(64);},
  c=>{c.extra='reject';},
  c=>{c.operation='cold-wake.set';},
]) { const bad=JSON.parse(JSON.stringify(validChallenge)); mutate(bad); rejects(()=>validateCandidateChallenge(bad)); }
const first=fixture.vectors[0];
const changedTarget=JSON.parse(JSON.stringify(first.action.object)); changedTarget.soul='agent_00000000-0000-4000-8000-000000000009';
rejects(()=>validateCandidateBindings(changedTarget,first.plan.object,first.challenge.object,first.action.actionText));
const badPayloadChallenge={...first.challenge.object,payloadDigest:'g'.repeat(64)}; rejects(()=>validateCandidateChallenge(badPayloadChallenge));
const badActionText=first.action.actionText.replace('enabled=false','enabled=true'); rejects(()=>validateCandidateBindings(first.action.object,first.plan.object,first.challenge.object,badActionText));
rejects(()=>decodeCandidateCanonical(Buffer.from('{"a":1,"a":1}')));
rejects(()=>decodeCandidateCanonical(Buffer.from('{ "a":1}')));
rejects(()=>decodeCandidateCanonical(Uint8Array.from([0xff,0xfe])));
rejects(()=>decodeCandidateCanonical(Buffer.alloc(32769,0x20)));
const duplicateWrapper=JSON.parse(JSON.stringify(fixture.vectors[0].preparedWrapper.object)); duplicateWrapper.effectPlanDigest=validChallenge.effectPlanDigest;
rejects(()=>exact(duplicateWrapper,['v','challenge','stage']));
const tamperedD1={...fixture.vectors[0].d1Payload.object,nonce:'B'.repeat(43)};
rejects(()=>validateCandidateD1(tamperedD1,validChallenge));
const tamperedPlan={...fixture.vectors[0].plan.object,expected:{enabled:false,kind:'computer-use'}};
assert.notEqual(sha(bytes(tamperedPlan)),fixture.vectors[0].challenge.object.effectPlanDigest);
const currentBooleanOnly=JSON.parse(JSON.stringify(fixture.vectors[0].reconciliation.indeterminatePair.object));
currentBooleanOnly.record.finding='applied'; currentBooleanOnly.record.basisDigest=null;
rejects(()=>validateReconciliationPair(currentBooleanOnly,{finding:'applied',preparation:fixture.vectors[0].preparation.object,receiptDigest:fixture.vectors[0].entered.object.receiptDigest,desiredEnabled:false,completed:null}));
const appliedSample=fixture.vectors[0].reconciliation.appliedPairWithRetainedCompletion.object;
const validCompleted=fixture.vectors[0].completed.object, validEntered=fixture.vectors[0].entered.object, validPreparation=fixture.vectors[0].preparation.object;
const validRecContext={finding:'applied',preparation:validPreparation,receiptDigest:validEntered.receiptDigest,desiredEnabled:false,completed:validCompleted,entered:validEntered};
validateReconciliationPair(appliedSample,validRecContext);
for(const [field,value] of [['requestId','00000000-0000-4000-8000-000000000999'],['preparationDigest','0'.repeat(64)],['receiptDigest','0'.repeat(64)],['effectId','00000000-0000-4000-8000-000000000999'],['phase','entered']]) {
  const foreignProof={...validCompleted,[field]:value}; const tamperedPair=JSON.parse(JSON.stringify(appliedSample)); tamperedPair.record.basisDigest=sha(bytes(foreignProof));
  rejects(()=>validateReconciliationPair(tamperedPair,{...validRecContext,completed:foreignProof}));
}
for (const [name,item] of [['d1',fixture.vectors[0].d1Payload],['preparation',fixture.vectors[0].preparation],['entered',fixture.vectors[0].entered],['completed',fixture.vectors[0].completed],['reconciliation',fixture.vectors[0].reconciliation.appliedPairWithRetainedCompletion]]) {
  const bad=JSON.parse(JSON.stringify(item)); bad.canonicalUtf8='not canonical bytes';
  rejects(()=>validateRetainedBytes({[name]:bad},name));
  for (const value of [null,undefined]) {
    const missing=JSON.parse(JSON.stringify(item));
    if (value===undefined) delete missing.canonicalUtf8; else missing.canonicalUtf8=value;
    rejects(()=>validateRetainedBytes({[name]:missing},name));
  }
}
const wrongStateEntered={...validEntered,detail:{...validEntered.detail,beforeEnabled:false}};
const wrongStateCompleted={...validCompleted,detail:{...validCompleted.detail,beforeEnabled:false}};
const wrongStatePair=JSON.parse(JSON.stringify(appliedSample)); wrongStatePair.record.basisDigest=sha(bytes(wrongStateCompleted));
rejects(()=>validateReconciliationPair(wrongStatePair,{...validRecContext,entered:wrongStateEntered,completed:wrongStateCompleted}));

const budget=JSON.parse(read('tests/fixtures/owner-decisions/journal-budget-v1.json'));
const caps=Object.fromEntries(budget.stores.daemon.slots.map(s=>[s.name,s.payloadCap]));
const maxBytes={ action:0, challenge:0, preparedWrapper:0, preparation:0, refused:0, entered:0, completed:0, reconciliationRecord:0, reconciliationPreimage:0, reconciliationPair:0, displayTextBytes:0, displayTextScalars:0, challengeWithoutPlanDigest:0 };
const MAX=Number.MAX_SAFE_INTEGER, D='f'.repeat(64), U='ffffffff-ffff-4fff-bfff-ffffffffffff', account='A'.repeat(64), soul='agent_ffffffff-ffff-4fff-bfff-ffffffffffff', principal='principal_ffffffff-ffff-ffff-ffff-ffffffffffff';
const refusalCodes=['expired','expected-state-changed','proposal-not-pending','stage-invalid','target-unavailable','validation-failed','storage-unavailable','trust-unavailable'];
const findings=['indeterminate','applied','refused']; let booleanCombinations=0, refusalCases=0, reconciliationCases=0;
for(const desiredEnabled of [false,true]) for(const expectedEnabled of [false,true]) {
  const action={v:1,requestId:U,principal,account,soul,operation,parameters:{enabled:desiredEnabled}}; const actionBytes=bytes(action); const pd=sha(actionBytes);
  const actionText=`Owner decision ${operation} for ${account}/${soul}: ${summaries[String(desiredEnabled)]}; request ${U}; payload sha256:${pd}`; const ad=sha(Buffer.from(actionText));
  const plan={v:1,requestId:U,principal,account,soul,operation,payloadDigest:pd,actionDigest:ad,expected:{enabled:expectedEnabled,kind:'computer-use'},desiredEnabled,behavior}; const epd=sha(bytes(plan));
  const c={requestId:U,principal,account,soul,operation,payloadDigest:pd,action:actionBytes.toString('base64url'),nonce:'A'.repeat(43),acceptedAt:MAX-180,preparedAt:MAX-180,exp:MAX,daemonKey:D,daemonEpoch:MAX,watchId:U,effectPlanDigest:epd};
  const {effectPlanDigest:ignored,...legacyChallenge}=c;
  const wrapper={v:1,challenge:c,stage:null};
  const preparation={v:2,kind:'preparation',requestId:U,principal,account,soul,operation,payloadDigest:pd,effectId:U,actionDigest:ad,nonce:c.nonce,acceptedAt:c.acceptedAt,preparedAt:c.preparedAt,exp:MAX,daemonKey:D,daemonEpoch:MAX,watchId:U,stage:null,expected:{enabled:expectedEnabled,kind:'computer-use'},trustVersion:1023};
  const prepDigest=sha(bytes(preparation));
  const entered={v:1,kind:'effect',requestId:U,payloadDigest:pd,preparationDigest:prepDigest,receiptDigest:D,effectId:U,phase:'entered',at:MAX,detail:{kind:'computer-use',beforeEnabled:expectedEnabled,afterEnabled:desiredEnabled}};
  const completed={...entered,phase:'completed'}; const completedDigest=sha(bytes(completed));
  const refusalRecords=refusalCodes.map(code=>({v:1,kind:'effect',requestId:U,payloadDigest:pd,preparationDigest:prepDigest,receiptDigest:D,effectId:U,phase:'refused',at:MAX,detail:{code}}));
  const refusedDigests=Object.fromEntries(refusalRecords.map(r=>[r.detail.code,sha(bytes(r))]));
  const sizes={action:actionBytes.length,challenge:bytes(c).length,challengeWithoutPlanDigest:bytes(legacyChallenge).length,preparedWrapper:bytes(wrapper).length,preparation:bytes(preparation).length,
    entered:bytes(entered).length,completed:bytes(completed).length,displayTextBytes:Buffer.byteLength(actionText),displayTextScalars:[...actionText].length};
  for(const r of refusalRecords) { sizes.refused=Math.max(sizes.refused??0,bytes(r).length); assert.equal(sha(bytes(r)),refusedDigests[r.detail.code]); refusalCases++; }
  for(const observedEnabled of [false,true]) for(const finding of findings) {
    let basisDigest=null;
    if(finding==='applied') basisDigest=completedDigest;
    else if(finding==='refused') basisDigest=refusedDigests['expected-state-changed'];
    const observation={v:1,kind:'computer-use',enabled:observedEnabled}; const observedDigest=sha(bytes(observation));
    const record={v:1,kind:'reconciliation',requestId:U,payloadDigest:pd,effectId:U,auditId:U,originalDaemonKey:D,originalDaemonEpoch:MAX,reportingDaemonKey:D,reportingDaemonEpoch:MAX,at:MAX,finding,basisDigest,observedDigest};
    const pair={v:1,preimage:observation,record};
    sizes.reconciliationRecord=Math.max(sizes.reconciliationRecord??0,bytes(record).length);
    sizes.reconciliationPreimage=Math.max(sizes.reconciliationPreimage??0,bytes(observation).length);
    sizes.reconciliationPair=Math.max(sizes.reconciliationPair??0,bytes(pair).length);
    assert.equal(record.observedDigest,sha(bytes(pair.preimage)));
    if(finding==='applied') assert.equal(record.basisDigest,completedDigest);
    if(finding==='refused') assert.equal(record.basisDigest,refusedDigests['expected-state-changed']);
    if(finding==='indeterminate') assert.equal(record.basisDigest,null);
    reconciliationCases++;
  }
  assert.equal(pd,sha(actionBytes)); assert.equal(ad,sha(Buffer.from(actionText))); assert.equal(epd,sha(bytes(plan)));
  assert.equal(preparation.expected.enabled,expectedEnabled); assert.equal(prepDigest,sha(bytes(preparation)));
  for(const [key,size] of Object.entries(sizes)) maxBytes[key]=Math.max(maxBytes[key]??0,size);
  booleanCombinations++;
}
assert.deepEqual({booleanCombinations,refusalCases,reconciliationCases},{booleanCombinations:4,refusalCases:32,reconciliationCases:24});
assert.deepEqual(fixture.limits.maximumWidthCoverage,{booleanCombinations,refusalRecords:refusalCases,reconciliationPairs:reconciliationCases,refusalCodes,findings});
const brokerBefore=budget.stores.broker.expected.requiredBytes, daemonBefore=budget.stores.daemon.expected.requiredBytes;
const computed={...maxBytes};
assert.deepEqual(fixture.limits.maximumWidth,computed);
const brokerCaps=Object.fromEntries(budget.stores.broker.slots.map(s=>[s.name,s.payloadCap]));
const daemonCaps=Object.fromEntries(budget.stores.daemon.slots.map(s=>[s.name,s.payloadCap]));
assert(maxBytes.action<=brokerCaps['original-action'] && maxBytes.action<=daemonCaps['original-action']);
assert(maxBytes.challenge<=daemonCaps['prepared-challenge']); assert(maxBytes.preparedWrapper<=brokerCaps['prepared-challenge']);
assert(maxBytes.preparation<=daemonCaps.preparation); assert(maxBytes.refused<=daemonCaps['pre-effect-refused']);
assert(maxBytes.entered<=daemonCaps.entered); assert(maxBytes.completed<=daemonCaps.completed);
assert(maxBytes.reconciliationRecord<=2048 && maxBytes.reconciliationPreimage<=2048);
assert(maxBytes.reconciliationPair<=daemonCaps['observation-pair'] && maxBytes.reconciliationPair<=daemonCaps['terminal-pair']);
assert(maxBytes.displayTextScalars<=400 && maxBytes.displayTextBytes<=500);
function calculateReservation(store) {
  const l=budget.limits, payloadBytes=store.slots.reduce((n,s)=>n+s.payloadCap,0), slotFramingBytes=store.slots.length*l.framingBytes;
  const scratchBytes=l.scratchPayloadBytes+l.framingBytes, metadataBytes=(l.namedFileEntries+l.namedDirectories)*l.entryCharge;
  const requiredBytes=payloadBytes+slotFramingBytes+scratchBytes+metadataBytes;
  const globalRequiredBytes=l.globalPayloadBytes+l.globalNamedFileEntries*l.framingBytes+(l.globalNamedFileEntries+l.globalNamedDirectories)*l.entryCharge;
  const installationRequestBytes=l.acceptedIds*store.reservationBytes;
  return {payloadBytes,slotFramingBytes,scratchBytes,metadataBytes,requiredBytes,installationRequestBytes,globalRequiredBytes,installationReservedBytes:installationRequestBytes+l.globalReservationBytes};
}
for(const name of ['broker','daemon']) {
  const store=budget.stores[name], calculated=calculateReservation(store);
  assert.deepEqual(calculated,store.expected); assert(calculated.requiredBytes<=store.reservationBytes);
  assert(calculated.globalRequiredBytes<=budget.limits.globalReservationBytes);
}
assert.deepEqual(fixture.limits.reservationDeltas,{newSlots:0,brokerRequiredBytes:calculateReservation(budget.stores.broker).requiredBytes,brokerReservedBytes:budget.stores.broker.reservationBytes,brokerDeltaBytes:0,daemonRequiredBytes:calculateReservation(budget.stores.daemon).requiredBytes,daemonReservedBytes:budget.stores.daemon.reservationBytes,daemonDeltaBytes:0,basis:fixture.limits.reservationDeltas.basis});
const result={proposedOnly:true,staticVectors:fixture.vectors.length,negativeCasesExercised:rejectionCases,maxWidthCombinations:booleanCombinations,refusalCasesEnumerated:refusalCases,reconciliationCasesEnumerated:reconciliationCases,legacyFixtureSha256:Object.fromEntries(legacyPaths.map(([path])=>[path,sha(read(path))])),maxBytes:computed,slotCaps:{broker:brokerCaps,daemon:daemonCaps},existingBudget:{brokerRequiredBytes:brokerBefore,brokerReservationBytes:budget.stores.broker.reservationBytes,daemonRequiredBytes:daemonBefore,daemonReservationBytes:budget.stores.daemon.reservationBytes,additionalSlots:0,reservationDeltaBytes:0},productionCodecConformance:'not established by this static checker'};
console.log(JSON.stringify(result,null,2));
