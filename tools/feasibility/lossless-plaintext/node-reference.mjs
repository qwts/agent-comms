// Independent Node laboratory implementation of CONTRACT.md. Not runtime code.
const MAX_BYTES = 56284;
const MAX_NODES = 20759;
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const arrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
const copyBytes = Uint8Array.prototype.set;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fail = () => { throw new Error('invalid-lossless-plaintext'); };
const high = value => value >= 0xd800 && value <= 0xdbff;
const low = value => value >= 0xdc00 && value <= 0xdfff;
function stringCheck(value, units, bytes = Infinity) {
  if (typeof value !== 'string' || value.length > units || Buffer.byteLength(value) > bytes) fail();
}
function header(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65536) return Buffer.from([(major << 5) | 25, length >>> 8, length & 255]);
  fail();
}
function text(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([header(3, bytes.length), bytes]);
}
function lossless(value) {
  const parts = []; let start = 0; let hasSurrogate = false;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (high(unit) && low(value.charCodeAt(i + 1))) { i++; continue; }
    if (!high(unit) && !low(unit)) continue;
    hasSurrogate = true;
    if (start < i) parts.push(text(value.slice(start, i)));
    parts.push(header(0, unit)); start = i + 1;
  }
  if (!hasSurrogate) return text(value);
  if (start < value.length) parts.push(text(value.slice(start)));
  return Buffer.concat([header(4, parts.length), ...parts]);
}
export function encode(value) {
  if (!Array.isArray(value) || value.length !== 6) fail();
  const [kind, body, refs, correlation, replyTo, depth] = value;
  if (typeof kind !== 'string' || (/^[a-z][a-z0-9-]{0,31}$/.exec(kind)?.[0] !== kind)) fail();
  stringCheck(body, 32768, 32768);
  if (!Array.isArray(refs) || refs.length > 16) fail();
  for (const ref of refs) stringCheck(ref, 256);
  for (const item of [correlation, replyTo]) if (item !== null) stringCheck(item, 128);
  if (!Number.isInteger(depth) || depth < 0 || depth > 8) fail();
  const bytes = Buffer.concat([header(4, 6), text(kind), lossless(body), header(4, refs.length),
    ...refs.map(lossless), correlation === null ? Buffer.from([0xf6]) : lossless(correlation),
    replyTo === null ? Buffer.from([0xf6]) : lossless(replyTo), header(0, depth)]);
  if (bytes.length > MAX_BYTES) fail();
  return bytes;
}
export function decode(input) {
  let length;
  try { if (arrayTag.call(input) !== 'Uint8Array') fail(); length = byteLength.call(input); } catch { fail(); }
  if (length > MAX_BYTES) fail();
  const bytes = new Uint8Array(length);
  try { copyBytes.call(bytes, input); } catch { fail(); }
  let position = 0, nodes = 0;
  function head() {
    if (++nodes > MAX_NODES || position >= bytes.length) fail();
    const first = bytes[position++], major = first >>> 5, ai = first & 31;
    if (major === 7 && ai === 22) return { major, value: null };
    if (![0, 3, 4].includes(major) || ai >= 27) fail();
    let value = ai;
    if (ai >= 24) {
      const count = 2 ** (ai - 24);
      if (position + count > bytes.length) fail();
      value = 0;
      for (let i = 0; i < count; i++) value = value * 256 + bytes[position++];
      if (value < (ai === 24 ? 24 : ai === 25 ? 256 : 65536)) fail();
    }
    return { major, value };
  }
  function readText(h, maxBytes) {
    if (h.major !== 3 || h.value > maxBytes || h.value > bytes.length - position) fail();
    let value;
    try { value = utf8.decode(bytes.subarray(position, position + h.value)); } catch { fail(); }
    position += h.value;
    return value;
  }
  function readString(units, byteCap = Infinity, nullable = false, runCap = units) {
    const h = head();
    if (nullable && h.major === 7 && h.value === null) return null;
    if (h.major === 3) {
      const value = readText(h, Math.min(byteCap, units * 3));
      stringCheck(value, units, byteCap); return value;
    }
    if (h.major !== 4 || h.value < 1 || h.value > runCap) fail();
    const pieces = []; let unitCount = 0, byteCount = 0, surrogateSeen = false, previousText = false, previousHigh = false;
    for (let i = 0; i < h.value; i++) {
      const part = head(); let value;
      if (part.major === 3) {
        if (previousText) fail();
        value = readText(part, Math.min(byteCap - byteCount, (units - unitCount) * 3));
        if (!value.length) fail();
        byteCount += part.value; previousText = true; previousHigh = false;
      } else {
        if (part.major !== 0 || (!high(part.value) && !low(part.value)) || (previousHigh && low(part.value))) fail();
        value = String.fromCharCode(part.value); byteCount += 3;
        surrogateSeen = true; previousText = false; previousHigh = high(part.value);
      }
      unitCount += value.length;
      if (unitCount > units || byteCount > byteCap) fail();
      pieces.push(value);
    }
    if (!surrogateSeen) fail();
    return pieces.join('');
  }
  const root = head(); if (root.major !== 4 || root.value !== 6) fail();
  const kind = readText(head(), 32);
  if ((/^[a-z][a-z0-9-]{0,31}$/.exec(kind)?.[0] !== kind)) fail();
  const body = readString(32768, 32768, false, 16384);
  const refsHeader = head(); if (refsHeader.major !== 4 || refsHeader.value > 16) fail();
  const refs = [];
  for (let i = 0; i < refsHeader.value; i++) refs.push(readString(256));
  const correlation = readString(128, Infinity, true), replyTo = readString(128, Infinity, true);
  const depth = head(); if (depth.major !== 0 || depth.value > 8 || position !== bytes.length) fail();
  return [kind, body, refs, correlation, replyTo, depth.value];
}
