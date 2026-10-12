import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { lineReader, MAX_LINE_BYTES, receivedFrameBytes, receivedFrameUtf8Valid } from '../lib/wire.mjs';

class FakeSocket extends EventEmitter {
  send(chunk) {
    this.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
}

function setup() {
  const socket = new FakeSocket();
  const lines = [];
  const frames = [];
  const errors = [];
  lineReader(socket, (line, metadata) => { lines.push(line); frames.push(metadata); }, (error) => errors.push(error));
  return { socket, lines, frames, errors };
}

test('reads a line split across chunks', () => {
  const { socket, lines, errors } = setup();
  socket.send('{"type":');
  socket.send('"split"}\n');
  assert.deepEqual(lines, [{ type: 'split' }]);
  assert.deepEqual(errors, []);
});

test('reads multiple lines in one chunk and skips blank lines', () => {
  const { socket, lines, errors } = setup();
  socket.send('\n{"n":1}\n\n{"n":2}\n');
  assert.deepEqual(lines, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(errors, []);
});

test('decodes a multibyte UTF-8 character split across chunks', () => {
  const { socket, lines, frames, errors } = setup();
  const encoded = Buffer.from('{"text":"☃"}\n');
  const snowmanStart = encoded.indexOf(Buffer.from('☃'));
  socket.send(encoded.subarray(0, snowmanStart + 1));
  socket.send(encoded.subarray(snowmanStart + 1));
  assert.deepEqual(lines, [{ text: '☃' }]);
  assert.equal(receivedFrameBytes(frames[0]), encoded.length);
  assert.equal(receivedFrameUtf8Valid(frames[0]), true);
  assert.deepEqual(errors, []);
});

test('ordinary generic line retains the existing 128KiB limit excluding its newline', () => {
  const { socket, lines, frames, errors } = setup();
  const json = '{"generic":true}';
  socket.send(`${json}${' '.repeat(MAX_LINE_BYTES - Buffer.byteLength(json))}\n`);
  assert.deepEqual(lines, [{ generic: true }]);
  assert.equal(receivedFrameBytes(frames[0]), MAX_LINE_BYTES + 1);
  assert.deepEqual(errors, []);
});

test('stops on an oversized line terminated by a newline', () => {
  const { socket, lines, errors } = setup();
  socket.send(`${'x'.repeat(MAX_LINE_BYTES + 1)}\n{"after":true}\n`);
  assert.deepEqual(lines, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /protocol limit/);
});

test('stops on an oversized partial line without a newline', () => {
  const { socket, lines, errors } = setup();
  socket.send('x'.repeat(MAX_LINE_BYTES + 1));
  assert.deepEqual(lines, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /protocol limit/);
});

test('non-JSON stops the reader and later lines are ignored', () => {
  const { socket, lines, errors } = setup();
  socket.send('{"before":true}\nnot json\n{"sameChunk":true}\n');
  socket.send('{"laterChunk":true}\n');
  assert.deepEqual(lines, [{ before: true }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /not JSON/);
});

test('transport metadata counts original Buffer bytes including CR LF and invalid UTF8 without reconstruction', () => {
  const socket = new FakeSocket(), seen = [];
  lineReader(socket, (value, metadata) => seen.push({ value, metadata }), assert.fail);
  const first = Buffer.from(' {"n":"\\u0061"}\r\n');
  const second = Buffer.concat([Buffer.from('{"s":"'), Buffer.from([255]), Buffer.from('"}\n')]);
  socket.send(first.subarray(0, 5)); socket.send(Buffer.concat([first.subarray(5), second]));
  assert.equal(receivedFrameBytes(seen[0].metadata), first.length);
  assert.equal(receivedFrameBytes(seen[1].metadata), second.length);
  assert.equal(receivedFrameUtf8Valid(seen[0].metadata), true);
  assert.equal(receivedFrameUtf8Valid(seen[1].metadata), false);
  assert.equal(seen[1].value.s, '\ufffd');
  assert.equal(Object.isFrozen(seen[0].metadata), true);
  assert.equal(receivedFrameBytes({ frameBytes: first.length }), null);
  assert.equal(receivedFrameUtf8Valid({ frameBytes: first.length, utf8Valid: true }), false);
  assert.equal(receivedFrameBytes(undefined), null);
});

test('decoded compatibility chunks parse but cannot attest original Buffer frame size', () => {
  const socket = new FakeSocket(); let metadata;
  lineReader(socket, (_value, frame) => { metadata = frame; }, assert.fail);
  socket.emit('data', '{"n":1}\n');
  assert.equal(receivedFrameBytes(metadata), null);
  assert.equal(receivedFrameUtf8Valid(metadata), false);
});
