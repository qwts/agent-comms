import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOwnerReceiptSourceFixtureFrame as frame } from '../lib/platform/owner-receipt-native.mjs';
test('source fixture frame has independently specified BE lengths and exact bytes',()=>{
  assert.equal(frame(Buffer.from('{}'),Buffer.from('xyz')).toString('hex'),'4742525346583031000000027b7d0000000378797a');
  for(const b of [Buffer.alloc(0),Buffer.alloc(4097),Buffer.from('{"v":1}\n'),Buffer.from([0xff])])assert.throws(()=>frame(b,Buffer.from('x')));
  assert.throws(()=>frame(Buffer.from('{}'),Buffer.alloc(0)));assert.throws(()=>frame(Buffer.from('{}'),Buffer.alloc(131073)));
});
