// Pure, internal draft codec. No broker route imports this module. Successful
// decoding establishes byte canonicality, not a schema, signature or authority.
const MAX_BYTES = 32 * 1024;
const MAX_DEPTH = 8;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const copyBytes = Uint8Array.prototype.set;

function invalid() { throw new Error('invalid-owner-decision-encoding'); }

function scalarString(value) {
  for (const scalar of value) {
    const code = scalar.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) invalid();
  }
  return JSON.stringify(value);
}

function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return scalarString(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid();
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  for (const key of keys) if (!/^[\x00-\x7f]*$/.test(key)) invalid();
  return `{${keys.map(key => `${scalarString(key)}:${canonical(value[key])}`).join(',')}}`;
}

// Count containers before JSON.parse so an adversarial deeply nested document
// cannot reach recursive canonicalization. Quotes and escapes are handled here;
// JSON.parse remains responsible for the actual JSON grammar.
function boundedDepth(text) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (++depth > MAX_DEPTH) invalid();
    } else if (char === '}' || char === ']') {
      if (--depth < 0) invalid();
    }
  }
  if (depth !== 0 || quoted) invalid();
}

export function snapshotOwnerDecisionBytes(bytes) {
  // A byte-only API cannot silently repair invalid UTF-8 via a string conversion.
  try {
    if (!(bytes instanceof Uint8Array)) invalid();
    // Do not invoke caller-overridden accessors on a typed-array subclass.
    const length = byteLength.call(bytes);
    if (length === 0 || length > MAX_BYTES) invalid();
    const snapshot = new Uint8Array(length);
    copyBytes.call(snapshot, bytes);
    return snapshot;
  } catch { invalid(); }
}

export function decodeOwnerDecisionCanonical(bytes) {
  try {
    const text = utf8.decode(snapshotOwnerDecisionBytes(bytes));
    boundedDepth(text);
    const value = JSON.parse(text);
    // This also rejects duplicate keys, alternate escapes/number spellings,
    // whitespace, BOM and noncanonical key ordering. Schema validation follows.
    if (canonical(value) !== text) invalid();
    return value;
  } catch {
    // Never leak source bytes or parser error text into diagnostics.
    invalid();
  }
}
