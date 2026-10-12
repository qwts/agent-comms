import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { encode, decode } from './node-reference.mjs';
const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url)));
test('independent Node implementation agrees with literal golden bytes and rejects malformed vectors', () => {
  for (const v of vectors.golden) {
    assert.equal(encode(v.value).toString('hex'), v.hex, v.name);
    assert.deepEqual(decode(Buffer.from(v.hex, 'hex')), v.value, v.name);
    const bytes = Buffer.from(v.hex, 'hex');
    for (let n = 0; n < bytes.length; n++) assert.throws(() => decode(bytes.subarray(0, n)), v.name);
  }
  for (const v of vectors.negative) assert.throws(() => decode(Buffer.from(v.hex, 'hex')), v.name);
});
test('attaining full bound, all Unicode classes and header boundaries preserve exact UTF-16 units', () => {
  const largest = ['a'.repeat(32), 'a\ud800'.repeat(8192), Array(16).fill('\u0800\ud800'.repeat(128)),
    '\u0800\ud800'.repeat(64), '\u0800\ud800'.repeat(64), 8];
  assert.equal(encode(largest).length, 56284);
  assert.deepEqual(decode(encode(largest)), largest);
  for (const s of ['', '\ufeff', '\ud800', '\udfff', '\udfff\ud800', '\ud800\ud800', '\ud800\udc00', '\ud800x\udc00', 'é', 'e\u0301']) {
    const value = ['a', s, [s], s, s, 0]; assert.deepEqual(decode(encode(value)), value);
  }
  for (const n of [22, 23, 24, 25, 254, 255, 256, 257]) {
    for (const s of ['x'.repeat(n) + '\ud800', '\ud800'.repeat(n), 'a\ud800'.repeat(n)]) {
      const value = ['a', s, [], null, null, 0]; assert.deepEqual(decode(encode(value)), value);
    }
  }
});
test('schema, declared lengths and binary input caps refuse before permissive decoding', () => {
  for (const value of [['a','x'.repeat(32769),[],null,null,0], ['a','',Array(17).fill(''),null,null,0],
    ['a','',['a'.repeat(257)],null,null,0], ['a','',[],'a'.repeat(129),null,0], ['a','',[],null,null,9], ['a\n','',[],null,null,0]]) assert.throws(() => encode(value));
  for (const bytes of [Buffer.alloc(56285), Buffer.from('866161994001', 'hex'), Buffer.from('8661617affffffff', 'hex'), Buffer.from('8661619bffffffffffffffff', 'hex')]) assert.throws(() => decode(bytes));
  assert.throws(() => decode({ length: 0 }));
  assert.throws(() => decode(new Uint16Array(4)));
  assert.throws(() => decode(Buffer.from('8662610a6080f6f600', 'hex')));
});
