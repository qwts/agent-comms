import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { hasOwnerDecisionOperation, MAX_OWNER_FRAME_BYTES } from '../lib/owner-decision-frame-classifier.mjs';
import { OWNER_DECISION_WIRE_OPERATIONS, ownerDecisionWireOperation } from '../lib/owner-decision-wire-operations.mjs';
import { lineReader, MAX_LINE_BYTES, receivedFrameBytes } from '../lib/wire.mjs';

const classify = text => hasOwnerDecisionOperation(Buffer.from(text));
const escaped = (value, upper = false) => `"${[...value].map(c => {
  const hex = c.charCodeAt(0).toString(16).padStart(4, '0');
  return `\\u${upper ? hex.toUpperCase() : hex}`;
}).join('')}"`;
function read(bytes, { ownerRequests = true, chunkSize = bytes.length, decoded = false } = {}) {
  const socket = new EventEmitter(), lines = [], frames = [], errors = [], parses = [];
  lineReader(socket, (value, frame) => { lines.push(value); frames.push(frame); }, error => errors.push(error), { ownerRequests });
  const parse = JSON.parse;
  JSON.parse = function (text, ...args) { parses.push(Buffer.byteLength(text)); return parse(text, ...args); };
  try {
    for (let start = 0; start < bytes.length; start += chunkSize) {
      const chunk = bytes.subarray(start, start + chunkSize);
      socket.emit('data', decoded ? chunk.toString('utf8') : chunk);
    }
  } finally { JSON.parse = parse; }
  return { lines, frames, errors, parses };
}
const pad = (json, length, end = '\n') => Buffer.from(`${json}${' '.repeat(length - Buffer.byteLength(json + end))}${end}`);

test('all seven shared ingress schemas classify literal and escaped root keys and operation values', () => {
  assert.equal(OWNER_DECISION_WIRE_OPERATIONS.length, 7);
  for (const op of OWNER_DECISION_WIRE_OPERATIONS) {
    assert.ok(ownerDecisionWireOperation(op));
    for (const key of ['"op"', escaped('op'), escaped('op', true), '"o\\u0070"']) {
      for (const value of [JSON.stringify(op), escaped(op), escaped(op, true)]) {
        const raw = `{${key}:${value}}`;
        assert.equal(JSON.parse(raw).op, op);
        assert.equal(classify(raw), true, raw);
      }
    }
  }
  assert.equal(ownerDecisionWireOperation('health'), undefined);
});

test('only root property values count; nesting, punctuation, primitive values and quoted decoys cannot select owner policy', () => {
  const owner = 'owner-decision-prepare';
  for (const value of [{ op: 'health', nested: { op: owner } },
    { text: `\\\"}{\"op\":\"${owner}\"`, array: [{ op: owner }] },
    { op: [owner, { op: owner }] }, { op: { op: owner } },
    { op: false, other: owner }, { op: null }, { op: 3 },
    [{ op: owner }], owner, null, true, 3]) assert.equal(classify(JSON.stringify(value)), false);
  for (const value of [{ nested: { a: [false, null, { text: '\\"}][{,' }] }, op: owner },
    { op: owner, nested: { op: 'health' } }]) assert.equal(classify(JSON.stringify(value)), true);
  for (const op of ['OWNER-DECISION', 'owner-decision-extra', 'owner-decision\n', '\\u006fwner-decision',
    '\u006fwner-decision☃', 'x'.repeat(1000)]) assert.equal(classify(JSON.stringify({ op })), false);
});

test('any duplicate top-level owner operation imposes the strict bound regardless of last-wins JSON semantics', () => {
  for (const raw of ['{"op":"owner-decision","op":"health"}',
    '{"op":"health","op":"owner-decision"}',
    '{"op":{"op":"health"},"\\u006f\\u0070":"owner-decision"}']) {
    assert.equal(classify(raw), true);
    const result = read(pad(raw, MAX_OWNER_FRAME_BYTES + 1));
    assert.deepEqual(result.parses, []);
    assert.deepEqual(result.lines, []);
    assert.equal(result.errors.length, 1);
  }
});

test('owner exact boundary includes whitespace and CR LF, while oversized op-last payload is never JSON parsed', () => {
  for (const op of OWNER_DECISION_WIRE_OPERATIONS) {
    for (const end of ['\n', '\r\n']) {
      const json = ` {"payload":"☃","nested":{"op":"health"},${escaped('op')}:${escaped(op)}}`;
      const exact = pad(json, MAX_OWNER_FRAME_BYTES, end);
      const accepted = read(exact, { chunkSize: 113 });
      assert.equal(accepted.lines[0].op, op);
      assert.deepEqual(accepted.errors, []);
      assert.deepEqual(accepted.parses, [exact.length - 1]);
      assert.equal(receivedFrameBytes(accepted.frames[0]), MAX_OWNER_FRAME_BYTES);
      const tooLong = Buffer.concat([Buffer.from(' '), exact, Buffer.from('{"op":"health"}\n')]);
      const refused = read(tooLong, { chunkSize: 127 });
      assert.deepEqual(refused.parses, []);
      assert.deepEqual(refused.lines, []);
      assert.equal(refused.errors.length, 1);
      assert.equal(refused.errors[0].message, 'the owner-decision frame is invalid');
    }
  }
  const opLast = Buffer.from(`{"large":"${'x'.repeat(40000)}","op":"owner-decision"}\n`);
  assert.deepEqual(read(opLast).parses, []);
});

test('invalid raw UTF8 and decoded owner chunks refuse before JSON.parse and stop later lines', () => {
  const split = read(Buffer.from('{"payload":"☃","op":"owner-decision-status"}\n'), { chunkSize: 1 });
  assert.deepEqual(split.lines, [{ payload: '☃', op: 'owner-decision-status' }]);
  assert.deepEqual(split.errors, []);
  const owner = Buffer.concat([Buffer.from('{"payload":"'), Buffer.from([255]),
    Buffer.from('","op":"owner-decision-status"}\n{"op":"health"}\n')]);
  for (const chunkSize of [1, 17, owner.length]) {
    const result = read(owner, { chunkSize });
    assert.deepEqual(result.parses, []);
    assert.deepEqual(result.lines, []);
    assert.equal(result.errors.length, 1);
  }
  const decoded = read(Buffer.from('{"op":"owner-decision"}\n'), { decoded: true });
  assert.deepEqual(decoded.parses, []);
  assert.equal(decoded.errors.length, 1);
});

test('generic broker frames retain 128KiB parsing and replacement behavior, and default readers remain generic', () => {
  const generic = pad('{"op":"health","nested":{"op":"owner-decision"}}', MAX_LINE_BYTES + 1);
  const accepted = read(generic, { chunkSize: 4096 });
  assert.equal(accepted.lines[0].op, 'health');
  assert.deepEqual(accepted.parses, [MAX_LINE_BYTES]);
  assert.deepEqual(accepted.errors, []);
  const invalid = Buffer.concat([Buffer.from('{"op":"health","s":"'), Buffer.from([255]), Buffer.from('"}\n')]);
  assert.equal(read(invalid).lines[0].s, '\ufffd');
  const defaultReader = read(pad('{"op":"owner-decision"}', 40000), { ownerRequests: false });
  assert.equal(defaultReader.lines[0].op, 'owner-decision');
  assert.deepEqual(defaultReader.errors, []);
  assert.equal(read(Buffer.alloc(MAX_LINE_BYTES + 1, 32)).errors.length, 1);
});

test('malformed JSON stays a generic parser refusal; classifier never delivers a malformed or incomplete envelope', () => {
  for (const raw of ['{"op":"owner-decision",}', '{"op":"owner-decision\\q"}',
    '{"op":"owner-decision\\u00G0"}', '{"op":"owner-decision',
    '{"op":', '{"nested":[}', '[{"op":"owner-decision"}',
    '{"op":"owner-decision"} trailing']) {
    const result = read(Buffer.from(`${raw}\n`));
    assert.deepEqual(result.lines, []);
    assert.equal(result.errors.length, 1, raw);
    assert.equal(result.errors[0].message, 'line is not JSON');
  }
});

test('deterministic generated valid envelopes agree across ordering, escapes, whitespace and arbitrary chunk boundaries', () => {
  let seed = 0x774051;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let example = 0; example < 210; example++) {
    const owner = OWNER_DECISION_WIRE_OPERATIONS[example % 7], expected = example % 3 !== 0;
    const op = expected ? owner : 'health';
    const quote = value => random(2) ? escaped(value, Boolean(random(2))) : JSON.stringify(value);
    const fields = [`${quote('op')}:${quote(op)}`,
      `"nested":${JSON.stringify({ array: [{ op: owner, text: '\\"{,]}☃' }, null, 3] })}`,
      `"body":${JSON.stringify('x'.repeat(random(400)) + '☃\\"[,{}')}`];
    for (let i = fields.length - 1; i > 0; i--) { const j = random(i + 1); [fields[i], fields[j]] = [fields[j], fields[i]]; }
    const raw = ` \t{ ${fields.join(random(2) ? ' ,\t' : ', ')} }\r`;
    assert.equal(JSON.parse(raw).op, op);
    assert.equal(classify(raw), expected);
    const bytes = Buffer.from(`${raw}\n`), actual = read(bytes, { chunkSize: 1 + random(31) });
    assert.deepEqual(actual.lines, [JSON.parse(raw)]);
    assert.deepEqual(actual.errors, []);
    const oversized = read(pad(raw, MAX_OWNER_FRAME_BYTES + 1), { chunkSize: 509 });
    assert.equal(oversized.parses.length, expected ? 0 : 1);
    assert.equal(oversized.lines.length, expected ? 0 : 1);
    assert.equal(oversized.errors.length, expected ? 1 : 0);
  }
});
