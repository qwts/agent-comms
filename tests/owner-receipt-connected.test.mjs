// Explicit cross-repository compiled fixture acceptance, never runtime selection.
// Build true-line's debug owner-receipt-fixture bin first; provide its exact path
// only to this test process. No compiler fallback or installed custody inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { createOwnerReceiptNativeFixtureInvoker } from '../lib/platform/owner-receipt-native.mjs';
import { SyntheticOwnerReceiptCapability } from '../lib/broker/owner-receipt-fixture.mjs';
import { fixture } from './helpers/owner-coordinator.mjs';
import { f } from './helpers/owner-decision-lifecycle.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const binary = process.env.COMMS_OWNER_RECEIPT_FIXTURE_BINARY;
const qualified = { skip: process.platform !== 'darwin' || !binary, timeout: 120000 };
const brokerPrivateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), Buffer.alloc(32,0x77)]),format:'der',type:'pkcs8' });
const brokerPublicKey = createPublicKey(brokerPrivateKey);
const presencePublicKey = createPublicKey({ key: Buffer.from(f.keys.presenceSpkiBase64,'base64'),format:'der',type:'spki' });
class NativeFixtureCapability extends SyntheticOwnerReceiptCapability {
  #invoker; #calls=0; #terminal=Promise.resolve({terminalConfirmed:true,safeClose:true});
  constructor(enrollment) {
    super(enrollment,{syntheticFixture:true});
    this.#invoker=createOwnerReceiptNativeFixtureInvoker({binary,binarySha256:hash(fs.readFileSync(binary)),syntheticFixture:true});
  }
  observe() {return Object.freeze({...super.observe(),brokerEnrollmentHeadDigest:'d'.repeat(64),observationDigest:'e'.repeat(64)});}
  startDecisionReceipt(command,options) {this.#calls++;const owned=this.#invoker.startDecisionReceipt(command,options);this.#terminal=owned.terminal;return owned;}
  get calls(){return this.#calls;}
  terminal(){return this.#terminal;}
}
test('compiled native cryptographic worker authorizes all eleven operations through actual pairing watch and journal',qualified,async t=>{
  for(const vector of f.positive){
    const x=fixture(t,vector,{}, {fixtureKeys:{broker:{privateKey:brokerPrivateKey,publicKey:brokerPublicKey},presence:{publicKey:presencePublicKey},namespaceDigest:'c'.repeat(64)},
      makeSigningCapability:enrollment=>new NativeFixtureCapability(enrollment)});
    t.after(async()=>{x.core.close();assert.deepEqual(await x.options.signingCapability.terminal(),{terminalConfirmed:true,safeClose:true});});
    x.prepare();x.core.prepared({...x.preparedRequest(),nonce:vector.receiptPayload.nonce});
    x.socket.beforeWrite=event=>{if(event.event==='owner-decision')assert.equal(x.journal.read(x.action.requestId).state,'authorized');};
    const request={...x.principal('owner-decision'),payloadDigest:x.binding().payloadDigest,presence:vector.presenceToken};
    const result=await x.core.confirm(request);assert.equal(result.state,'authorized');
    const row=x.journal.read(x.action.requestId),token=row.slots.get('receipt').toString(),parts=token.split('.');
    assert.equal(verify(null,Buffer.from(parts[1]),brokerPublicKey,Buffer.from(parts[2],'base64url')),true);
    assert.equal(JSON.parse(Buffer.from(parts[1],'base64url')).presenceDigest,hash(vector.presenceToken));
    assert.equal(x.socket.events.filter(e=>e.event==='owner-decision').length,1);
    assert.equal((await x.core.confirm(request)).state,'authorized');
    assert.equal(x.journal.read(x.action.requestId).slots.get('receipt').toString(),token);
    assert.equal(x.options.signingCapability.calls,1);
    assert.equal(x.socket.events.filter(e=>e.event==='owner-decision').length,1);
    assert.equal(x.check().mayApply,true);assert.equal(x.check().mayApply,false);
    // Reopening does not regenerate a signature or restore a positive release.
    const reopened=x.open();assert.equal(reopened.read(x.action.requestId).state,'released');
  }
});

test('actual native child cancellation close and revocation cannot release private candidate or obtain retry',qualified,async t=>{
  for(const boundary of ['cancel','close','revocation']){
    const vector=f.positive[0];
    const x=fixture(t,vector,{}, {fixtureKeys:{broker:{privateKey:brokerPrivateKey,publicKey:brokerPublicKey},presence:{publicKey:presencePublicKey},namespaceDigest:'c'.repeat(64)},
      makeSigningCapability:enrollment=>new NativeFixtureCapability(enrollment)});
    t.after(async()=>{x.core.close();assert.deepEqual(await x.options.signingCapability.terminal(),{terminalConfirmed:true,safeClose:true});});
    x.prepare();x.core.prepared({...x.preparedRequest(),nonce:vector.receiptPayload.nonce});
    const request={...x.principal('owner-decision'),payloadDigest:x.binding().payloadDigest,presence:vector.presenceToken};
    const pending=x.core.confirm(request);const refusal=assert.rejects(pending,e=>typeof e.code==='string');
    await new Promise(resolve=>setTimeout(resolve,30));
    if(boundary==='cancel')x.core.cancel(x.principal('owner-decision-cancel'));
    if(boundary==='close')x.core.close();
    if(boundary==='revocation')x.pairing.handleAdmin({op:'principal-owner-grants',principal:x.action.principal,grants:[]});
    await refusal;assert.equal(x.options.signingCapability.calls,1);
    const row=x.journal.read(x.action.requestId);assert.equal(row.slots.has('authorization'),false);assert.equal(row.slots.has('receipt'),false);
    assert.equal(x.socket.events.filter(e=>e.event==='owner-decision').length,0);
    try{await x.core.confirm(request);}catch{}assert.equal(x.options.signingCapability.calls,1);
  }
});
