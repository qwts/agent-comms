// A JSON Schema (draft 2020-12) validator for the keyword subset that the
// vendored soul-contracts schemas use. It compiles each schema once and
// refuses, at compile time, any keyword it does not implement, so a schema
// update that needs more of the specification fails loudly instead of being
// half-checked (ADR-0300).

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description']);
const KEYWORDS = new Set([...ANNOTATIONS, 'type', 'properties', 'required', 'additionalProperties',
  'pattern', 'enum', 'const', 'if', 'then', 'minimum', 'maximum', 'items', 'uniqueItems',
  'minLength', 'maxLength', 'format']);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function typeOf(value, type) {
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    default: return value === null;
  }
}

// RFC 3339 date-time, as JSON Schema's format assertion reads it: a full
// date, a time with seconds, and a required offset. Leap seconds are refused.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;
export function isDateTime(value) {
  const m = DATE_TIME.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return false;
  return m[9] === undefined || (Number(m[9]) <= 23 && Number(m[10]) <= 59);
}
const FORMATS = { 'date-time': isDateTime };

function compile(schema, at) {
  if (!isObject(schema)) throw new Error(`${at}: a schema must be an object`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) throw new Error(`${at}: unsupported schema keyword ${key}`);
  }
  if (schema.type !== undefined && !TYPES.has(schema.type)) throw new Error(`${at}: unsupported type ${schema.type}`);
  if (schema.format !== undefined && !FORMATS[schema.format]) throw new Error(`${at}: unsupported format ${schema.format}`);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error(`${at}: only additionalProperties false is supported`);
  }
  if (schema.then !== undefined && schema.if === undefined) throw new Error(`${at}: then without if`);
  const node = { ...schema };
  if (schema.pattern !== undefined) node.regex = new RegExp(schema.pattern, 'u');
  if (schema.properties) {
    node.properties = Object.fromEntries(Object.entries(schema.properties)
      .map(([k, v]) => [k, compile(v, `${at}/properties/${k}`)]));
  }
  if (schema.items) node.items = compile(schema.items, `${at}/items`);
  if (schema.if) node.if = compile(schema.if, `${at}/if`);
  if (schema.then) node.then = compile(schema.then, `${at}/then`);
  return node;
}

function check(node, value, path, errors) {
  const fault = (keyword) => errors.push({ path: path || '/', keyword });
  if (node.type !== undefined && !typeOf(value, node.type)) { fault('type'); return errors; }
  if (node.const !== undefined && !deepEqual(node.const, value)) fault('const');
  if (node.enum && !node.enum.some((x) => deepEqual(x, value))) fault('enum');
  if (typeof value === 'string') {
    const length = [...value].length;
    if (node.minLength !== undefined && length < node.minLength) fault('minLength');
    if (node.maxLength !== undefined && length > node.maxLength) fault('maxLength');
    if (node.regex && !node.regex.test(value)) fault('pattern');
    if (node.format && !FORMATS[node.format](value)) fault('format');
  }
  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) fault('minimum');
    if (node.maximum !== undefined && value > node.maximum) fault('maximum');
  }
  if (Array.isArray(value)) {
    if (node.uniqueItems && value.some((x, i) => value.findIndex((y) => deepEqual(x, y)) !== i)) fault('uniqueItems');
    if (node.items) value.forEach((x, i) => check(node.items, x, `${path}/${i}`, errors));
  }
  if (isObject(value)) {
    for (const key of node.required ?? []) if (!Object.hasOwn(value, key)) errors.push({ path: `${path}/${key}`, keyword: 'required' });
    for (const [key, child] of Object.entries(value)) {
      const sub = node.properties?.[key];
      if (sub) check(sub, child, `${path}/${key}`, errors);
      else if (node.additionalProperties === false) errors.push({ path: `${path}/${key}`, keyword: 'additionalProperties' });
    }
  }
  if (node.if && check(node.if, value, path, []).length === 0 && node.then) check(node.then, value, path, errors);
  return errors;
}

// Returns a function that lists every violation as { path, keyword }; an
// empty list means the value is valid.
export function compileSchema(schema, name = '#') {
  const root = compile(schema, name);
  return (value) => check(root, value, '', []);
}
