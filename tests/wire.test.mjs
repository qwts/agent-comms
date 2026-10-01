import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { test } from 'node:test';

import { lineReader, MAX_LINE_BYTES } from '../lib/wire.mjs';

class FakeSocket extends EventEmitter {
  setEncoding(encoding) {
    this.encoding = encoding;
    this.decoder = new StringDecoder(encoding);
    return this;
  }

  send(chunk) {
    this.emit('data', typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
  }
}

function setup() {
  const socket = new FakeSocket();
  const lines = [];
  const errors = [];
  lineReader(socket, (line) => lines.push(line), (error) => errors.push(error));
  assert.equal(socket.encoding, 'utf8');
  return { socket, lines, errors };
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
  const { socket, lines, errors } = setup();
  const encoded = Buffer.from('{"text":"☃"}\n');
  const snowmanStart = encoded.indexOf(Buffer.from('☃'));
  socket.send(encoded.subarray(0, snowmanStart + 1));
  socket.send(encoded.subarray(snowmanStart + 1));
  assert.deepEqual(lines, [{ text: '☃' }]);
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
