import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeNativeObservationV2, decodeFixtureObservationV1 } from '../lib/platform/owner-observer-wire.mjs';
import { bytes } from './helpers/owner-decision-lifecycle.mjs';
const supported={skip:typeof process.getuid !== 'function' || process.getuid() <= 0};
const hash=b=>createHash('sha256').update(b).digest('hex');
function vector(change=()=>{}){
  const key=n=>{const raw=Buffer.alloc(32,n);return {alg:'ed25519',keyId:hash(Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw])),publicKey:raw.toString('base64url')};};
  const installation={v:2,kind:'geniusbar-native-installation',namespaceDigest:'c'.repeat(64),publicSocket:'/fixed/broker.sock',brokerUid:process.getuid(),brokerAccountGuid:'02020202-0202-2202-8202-020202020202',ownerUid:process.getuid()+1,ownerAccountGuid:'01010101-0101-1101-8101-010101010101',helperProtocol:1,helperService:'app.geniusbar.owner-admin',helperIdentifier:'app.geniusbar.owner-admin',brokerLocalRevision:1,brokerEnrollmentHeadDigest:'d'.repeat(64)};
  const pins={v:2,kind:'geniusbar-native-enrollment-pins',namespaceDigest:installation.namespaceDigest,brokerLocalRevision:1,brokerEnrollmentHeadDigest:installation.brokerEnrollmentHeadDigest,receiptKey:key(1),presenceKey:key(2),service:{platform:'darwin',brokerUid:process.getuid()}};
  change(installation,pins);
  const projection=bytes({installation:bytes(installation).toString(),kind:'geniusbar-native-cutover-inspection',pins:bytes(pins).toString(),v:1});
  return {custodyFingerprint:'e'.repeat(64),kind:'owner-enrollment-observation',observationDigest:hash(projection),projection:projection.toString('base64url'),v:2};
}
test('v2 and explicit fixture v1 codecs refuse cross-kind promotion and malformed envelopes',supported,()=>{
  const v=vector();assert.equal(decodeNativeObservationV2(bytes(v)).v,2);assert.throws(()=>decodeFixtureObservationV1(bytes(v)));
  const fixture={...v,v:1,kind:'owner-enrollment-observation-fixture'};assert.equal(decodeFixtureObservationV1(bytes(fixture)).v,1);assert.throws(()=>decodeNativeObservationV2(bytes(fixture)));
  for(const change of [v=>({...v,extra:1}),v=>({...v,v:1}),v=>({...v,custodyFingerprint:v.custodyFingerprint+'\n'}),v=>({...v,projection:v.projection+'='}),v=>({...v,observationDigest:'0'.repeat(64)})]) assert.throws(()=>decodeNativeObservationV2(bytes(change(v))));
  assert.throws(()=>decodeNativeObservationV2(Buffer.alloc(24577)));assert.throws(()=>decodeNativeObservationV2(Buffer.from([0xff])));
});
test('strict projection fields types canonical bytes and actual public-key/service pins are required',supported,()=>{
  for(const mutate of [(i,p)=>{i.extra=1;},(i,p)=>{delete p.receiptKey;},(i,p)=>{p.service.brokerUid++;},(i,p)=>{p.receiptKey=p.presenceKey;},(i,p)=>{p.receiptKey.keyId='0'.repeat(64);},(i,p)=>{i.ownerUid=i.brokerUid;},(i,p)=>{i.brokerAccountGuid+='\n';},(i,p)=>{i.publicSocket='/fixed/\ud800/broker.sock';},(i,p)=>{i.brokerLocalRevision=1024;p.brokerLocalRevision=1024;}]) assert.throws(()=>decodeNativeObservationV2(bytes(vector(mutate))));
  const v=vector(),projection=Buffer.from(v.projection,'base64url');projection[projection.indexOf('/fixed')+1]=0xff;
  assert.throws(()=>decodeNativeObservationV2(bytes({...v,projection:projection.toString('base64url'),observationDigest:hash(projection)})));
});
