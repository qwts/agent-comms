// Strict JSON parsing for contract frames. Draft 0.4 section 6 requires
// implementations to reject duplicate object keys before processing a
// payload; JSON.parse keeps the last duplicate silently. This scanner walks
// the text once, refuses a repeated key in any object, and then hands the
// same text to JSON.parse, which already refuses NaN, Infinity and every
// other non-JSON token.

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

export function parseStrict(text) {
  if (typeof text !== 'string') throw new SyntaxError('strict JSON input must be a string');
  let i = 0;
  const skip = () => { while (i < text.length && WS.has(text.charCodeAt(i))) i += 1; };
  const string = () => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) throw new SyntaxError('unterminated string');
    i += 1;
    return JSON.parse(text.slice(start, i));
  };
  const value = () => {
    skip();
    const c = text[i];
    if (c === '{') {
      i += 1;
      const keys = new Set();
      skip();
      if (text[i] === '}') { i += 1; return; }
      for (;;) {
        skip();
        if (text[i] !== '"') throw new SyntaxError('expected an object key');
        const key = string();
        if (keys.has(key)) throw new SyntaxError(`duplicate key ${JSON.stringify(key)}`);
        keys.add(key);
        skip();
        if (text[i] !== ':') throw new SyntaxError('expected a colon');
        i += 1;
        value();
        skip();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return; }
        throw new SyntaxError('expected a comma or closing brace');
      }
    }
    if (c === '[') {
      i += 1;
      skip();
      if (text[i] === ']') { i += 1; return; }
      for (;;) {
        value();
        skip();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return; }
        throw new SyntaxError('expected a comma or closing bracket');
      }
    }
    if (c === '"') { string(); return; }
    // Scalars: consume the token and let JSON.parse judge it below.
    while (i < text.length && !WS.has(text.charCodeAt(i)) && !',]}'.includes(text[i])) i += 1;
  };
  value();
  return JSON.parse(text);
}
