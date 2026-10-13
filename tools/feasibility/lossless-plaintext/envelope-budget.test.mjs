// Structural laboratory only: no crypto, network, enrollment or runtime codec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from './node-reference.mjs';

function head(major, value) {
  assert.ok(Number.isSafeInteger(value) && value >= 0);
  if (value < 24) return Buffer.from([(major << 5) | value]);
  const width = value < 256 ? 1 : value < 65536 ? 2 : value < 2 ** 32 ? 4 : 8;
  const result = Buffer.alloc(1 + width); result[0] = (major << 5) | ({1:24,2:25,4:26,8:27})[width];
  if (width === 8) result.writeBigUInt64BE(BigInt(value),1); else result.writeUIntBE(value,1,width);
  return result;
}
function cbor(value) {
  if (Array.isArray(value)) return Buffer.concat([head(4,value.length),...value.map(cbor)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2,value.length),value]);
  if (typeof value === 'string') { const b=Buffer.from(value); return Buffer.concat([head(3,b.length),b]); }
  return head(0,value);
}
const origin='hub_ffffffff-ffff-ffff-ffff-ffffffffffff';
const destination='hub_eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const b32=Buffer.alloc(32),b16=Buffer.alloc(16),max=Number.MAX_SAFE_INTEGER;
const header=plain=>[1,[32,1,1],origin,destination,'a'.repeat(128),'b'.repeat(128),b32,b32,b16,b16,b16,b32,b16,b16,max-2592000000,max,plain];
const envelope=plain=>cbor([header(plain),b32,Buffer.alloc(plain+16),Buffer.alloc(64)]);
const receipt=kind=>[1,kind,kind===1?b32:destination,b32,b16,origin,destination,b32,b16,b16,b32,max,max-1,kind];
const largest=['a'.repeat(32),'a\ud800'.repeat(8192),Array(16).fill('\u0800\ud800'.repeat(128)),
  '\u0800\ud800'.repeat(64),'\u0800\ud800'.repeat(64),8];

test('native origin identities and maximum plaintext produce exact complete structural bytes',()=>{
  assert.equal(Buffer.byteLength(origin),40); assert.equal(Buffer.byteLength(destination),40);
  const plain=encode(largest);assert.equal(plain.length,56284);
  assert.equal(cbor(header(plain.length)).length,559);
  assert.equal(envelope(plain.length).length,56963);
  assert.ok(envelope(plain.length).length<=65536);
  const actualReply=[...largest];actualReply[4]='msg_'+'f'.repeat(36);
  assert.equal(encode(actualReply).length,55876);assert.equal(envelope(55876).length,56555);
});
test('full native body and old plaintext boundary are preserved; limit plus one refuses',()=>{
  const minimal=n=>['message','a'.repeat(n),[],null,null,0];
  assert.equal(encode(minimal(32752)).length,32768);
  assert.equal(encode(minimal(32753)).length,32769);
  assert.equal(encode(minimal(32768)).length,32784);
  assert.throws(()=>encode(minimal(32769)));
  assert.equal(envelope(32784).length,33463);
  assert.throws(()=>encode([...largest.slice(0,2),[...largest[2],'x'],...largest.slice(3)]));
});
test('both receipt purposes encode the complete identity shape and exact byte capacities',()=>{
  assert.equal(cbor(receipt(1)).length,293);assert.equal(cbor(receipt(2)).length,301);
  assert.equal(cbor([receipt(1),Buffer.alloc(64)]).length,360);
  assert.equal(cbor([receipt(2),Buffer.alloc(64)]).length,368);
  assert.equal(Math.floor(33554432/368),91180);
  assert.deepEqual([268435456,33554432,67108864].map(cap=>Math.floor(cap/56963)),[4712,589,1178]);
});
