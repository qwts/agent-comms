// Synthetic native-validator witness and structural size calculator only.
// This is deliberately not a production serializer or a crypto implementation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createMessageAdmission,PAGE_BUDGET} from '../../lib/broker/message-admission.mjs';
import {LIMITS} from '../../lib/broker/shared.mjs';
const headerBytes=n=>n<24?1:n<256?2:n<65536?3:n<2**32?5:9;
function cborSize(value){
 if(value===null)return 1;
 if(typeof value==='number'){assert.ok(Number.isSafeInteger(value)&&value>=0);return headerBytes(value);}
 if(typeof value==='string'){assert.ok(value.isWellFormed(),'CBOR text witness must be well formed');const n=Buffer.byteLength(value);return headerBytes(n)+n;}
 if(Buffer.isBuffer(value))return headerBytes(value.length)+value.length;
 assert.ok(Array.isArray(value));return headerBytes(value.length)+value.reduce((n,item)=>n+cborSize(item),0);
}
const admission=createMessageAdmission({limits:LIMITS,state:{seq:0},now:()=>1});
const reply='msg_00000000-0000-0000-0000-000000000000';
const from={account:'audit',agentId:'agent_00000000-0000-0000-0000-000000000000',verification:'claimed'};
const to={...from,agentId:'agent_00000000-0000-0000-0000-000000000001'};
const witnesses=[];
for(const [name,body,ref,correlation] of [
 ['well-formed','a'.repeat(32768),'\u0800'.repeat(256),'\u0800'.repeat(128)],
 ['lone-surrogate','a\ud800'.repeat(8192),'\ud800'.repeat(256),'\ud800'.repeat(128)],
]){
 const payload=admission.payload({key:'synthetic-audit',kind:'a'.repeat(32),body,refs:Array(16).fill(ref),correlation,replyTo:reply});
 const message=admission.message(from,to,payload,{depth:8});
 const escapedBytes=Buffer.byteLength(JSON.stringify({...message,wake:'waiting'}));
 assert.equal(Buffer.byteLength(body),32768);assert.ok(escapedBytes<=PAGE_BUDGET);
 witnesses.push({name,bodyBytes:Buffer.byteLength(body),wellFormed:body.isWellFormed(),escapedBytes,payloadAndMessageValidatorsPassed:true});
}
const b32=Buffer.alloc(32),b16=Buffer.alloc(16),max=Number.MAX_SAFE_INTEGER;
const header=[1,[32,1,1],b32,b32,'a'.repeat(128),'a'.repeat(128),b32,b32,b16,b16,b16,b32,b16,b16,max-1,max,32768];
assert.equal(cborSize(header),543);
const payload=['a'.repeat(32),'a'.repeat(32768),Array(16).fill('\u0800'.repeat(256)),'\u0800'.repeat(128),'\u0800'.repeat(128),8];
assert.equal(cborSize(payload),45918);
const bounds=[];
for(const lossless of [false,true])for(const actualReply of [false,true]){
 const shape=structuredClone(payload);
 // Proposed canonical run-array structural witness, not an encoder.
 if(lossless)shape[1]=Array.from({length:16384},(_,i)=>i%2===0?'a':0xd800);
 if(actualReply)shape[4]=reply;
 const plain=cborSize(shape),h=[...header];h[16]=plain;
 const wire=cborSize([h,b32,Buffer.alloc(plain+16),Buffer.alloc(64)]);
 assert.ok(wire<=65536);
 bounds.push({losslessRunArrayCandidate:lossless,globalMaximumProven:false,actualReplyIdShape:actualReply,plain,wire,
  relayBodySlots:Math.floor(256*1024*1024/wire),routeSlots:Math.floor(32*1024*1024/wire),localRelaySlots:Math.floor(64*1024*1024/wire)});
}
assert.deepEqual(bounds.map(({plain,wire})=>[plain,wire]),[[45918,46581],[45573,46236],[54110,54773],[53765,54428]]);
const sourceHashes={};for(const name of ['../../lib/broker/message-admission.mjs','../../lib/broker/shared.mjs','../../lib/wire.mjs','../../lib/retention.mjs','federation-native-budget.mjs'])sourceHashes[name]=createHash('sha256').update(await readFile(new URL(name,import.meta.url))).digest('hex');
console.log(JSON.stringify({scope:'synthetic-validator-and-structural-size-only',fullAuthenticatedSendOrPersistenceTested:false,cryptoOrSerializerImplemented:false,pageBudget:PAGE_BUDGET,witnesses,bounds,sourceHashes}));
