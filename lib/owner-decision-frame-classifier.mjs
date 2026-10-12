import { OWNER_DECISION_WIRE_OPERATIONS, isOwnerDecisionOperation } from './owner-decision-wire-operations.mjs';

export const MAX_OWNER_FRAME_BYTES = 32768;
const maxOperation = Math.max(...OWNER_DECISION_WIRE_OPERATIONS.map(op => op.length));
const whitespace = byte => byte === 32 || byte === 9 || byte === 13 || byte === 10;
const hex = byte => byte >= 48 && byte <= 57 ? byte - 48
  : byte >= 65 && byte <= 70 ? byte - 55 : byte >= 97 && byte <= 102 ? byte - 87 : -1;

// Only ASCII candidate keys/values are decoded. Each ASCII code point needs
// at most six raw bytes (\uXXXX); a longer token cannot be one of our names.
// No JSON.parse, payload object, recursion, or unbounded decoded string.
function asciiToken(bytes, start, end, limit) {
  if (end - start > 2 + 6 * limit) return null;
  let result = '';
  for (let i = start + 1; i < end - 1; i++) {
    let byte = bytes[i];
    if (byte === 92) {
      if (bytes[++i] !== 117 || i + 4 >= end - 1) return null;
      byte = 0;
      for (let digit = 0; digit < 4; digit++) {
        const value = hex(bytes[++i]);
        if (value < 0) return null;
        byte = byte * 16 + value;
      }
    }
    if (byte < 32 || byte > 127 || result.length === limit) return null;
    result += String.fromCharCode(byte);
  }
  return result;
}

// One pass over a complete, generically bounded raw JSON line. The full JSON
// grammar is still the parser's responsibility. For valid root objects, any
// top-level owner op (including duplicates) invokes the stricter bound. Nested
// fields and quoted decoys do not. This is not an authorization/typed decoder.
export function hasOwnerDecisionOperation(bytes) {
  let i = 0;
  while (whitespace(bytes[i])) i++;
  if (bytes[i++] !== 123) return false;
  let depth = 1, phase = 'key', opKey = false;
  for (; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 34) {
      const start = i;
      for (i++; i < bytes.length && bytes[i] !== 34; i++) {
        if (bytes[i] === 92) i++;
      }
      if (i >= bytes.length) return false;
      if (depth === 1) {
        if (phase === 'key') {
          opKey = asciiToken(bytes, start, i + 1, 2) === 'op';
          phase = 'colon';
        } else if (phase === 'value') {
          if (opKey && isOwnerDecisionOperation(asciiToken(bytes, start, i + 1, maxOperation))) return true;
          phase = 'after';
        }
      }
    } else if (byte === 123 || byte === 91) {
      if (depth === 1) phase = 'after';
      depth++;
    } else if (byte === 125 || byte === 93) {
      if (--depth === 0) return false;
    } else if (depth === 1) {
      if (byte === 44) { phase = 'key'; opKey = false; }
      else if (byte === 58 && phase === 'colon') phase = 'value';
      else if (!whitespace(byte) && phase === 'value') phase = 'after';
    }
  }
  return false;
}
