import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeOwnerDecisionCanonical as decode, snapshotOwnerDecisionBytes } from '../lib/owner-decision-canonical.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions/v1.json', import.meta.url)));
const bytes = text => Buffer.from(text, 'utf8');
const refuses = input => assert.throws(() => decode(input), { message: 'invalid-owner-decision-encoding' });

test('canonical decoder consumes shared signed action, receipt and scalar bytes', () => {
  for (const fixture of fixtures.positive) {
    assert.deepEqual(decode(bytes(fixture.actionJson)), JSON.parse(fixture.actionJson));
    assert.deepEqual(decode(Buffer.from(fixture.receiptToken.split('.')[1], 'base64url')), fixture.receiptPayload);
  }
  for (const fixture of fixtures.serialization) {
    assert.deepEqual(decode(Buffer.from(fixture.utf8Hex, 'hex')), fixture.value);
  }
});

test('alternate representations, invalid UTF-8 and scalar values refuse', () => {
  for (const fixture of fixtures.negativeActionBytes) {
    // An unknown ASCII field is canonically encoded but fails the action schema.
    if (fixture.id !== 'unknown-key') refuses(Buffer.from(fixture.bytesBase64url, 'base64url'));
  }
  for (const text of [
    '{"a":1,"a":1}', '{"b":1,"a":2}', '{ "a":1}', '{"a":1}\n',
    '{"a":-0}', '{"a":1.0}', '{"a":1e0}', '{"a":9007199254740992}',
    '{"a":"\\u0061"}', '{"a":"\\/"}', '{"a":"\\u001F"}',
    '{"a":"\\ud800"}', '{"a":"\\udfff"}', '{"é":1}', '\ufeff{"a":1}',
    '{"a":NaN}', '{"a":Infinity}', '{"a":01}', '{"a":+1}',
  ]) refuses(bytes(text));
  for (const hex of ['c0af', 'eda080', 'f4908080', 'ff', '22c322']) refuses(Buffer.from(hex, 'hex'));
});

test('byte and preparse nesting bounds hold at equality, including escaped quotes', () => {
  const exact = bytes('"' + 'a'.repeat(32766) + '"');
  assert.equal(exact.byteLength, 32768);
  assert.equal(decode(exact).length, 32766);
  refuses(bytes('"' + 'a'.repeat(32767) + '"'));
  assert.deepEqual(decode(bytes('['.repeat(8) + '0' + ']'.repeat(8))), [[[[[[[[0]]]]]]]]);
  refuses(bytes('['.repeat(9) + '0' + ']'.repeat(9)));
  refuses(bytes('['.repeat(16000) + ']'.repeat(16000)));
  assert.equal(decode(bytes(JSON.stringify('[[["\\]]]'))), '[[["\\]]]');
});

test('decoder does not confuse grammar with schema or expose parser contents', () => {
  assert.deepEqual(decode(bytes('{"unexpected":true}')), { unexpected: true });
  const value = decode(bytes('{"__proto__":{"polluted":true}}'));
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.equal({}.polluted, undefined);
  refuses(bytes('{"secret-canary":INVALID}'));
  refuses('valid strings still require bytes');
  refuses(new Uint8Array());
});

test('subclass byte-length accessors cannot bypass bounds or leak thrown values', () => {
  class LyingBytes extends Uint8Array { get byteLength() { return 1; } }
  class ThrowingBytes extends Uint8Array { get byteLength() { throw new Error('length-secret-canary'); } }
  refuses(new LyingBytes(bytes('"' + 'x'.repeat(32768) + '"')));
  assert.equal(decode(new ThrowingBytes(bytes('true'))), true);
  refuses(new Proxy(bytes('true'), {}));
});

test('bounded snapshots are private even for shared storage and hostile subclass accessors', () => {
  const source = new Uint8Array(new SharedArrayBuffer(4));
  source.set(bytes('true'));
  const snapshot = snapshotOwnerDecisionBytes(source);
  source.set(bytes('null'));
  assert.equal(decode(snapshot), true);
  assert.equal(decode(source), null);
  assert.notEqual(snapshot.buffer, source.buffer);
  class HostileBytes extends Uint8Array {
    get buffer() { throw new Error('buffer-canary'); }
    get byteOffset() { throw new Error('offset-canary'); }
    get length() { throw new Error('length-canary'); }
    [Symbol.iterator]() { throw new Error('iterator-canary'); }
  }
  assert.equal(decode(new HostileBytes(bytes('true'))), true);
});
