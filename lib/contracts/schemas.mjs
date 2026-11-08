// The soul-contracts schemas agent-comms implements, vendored at the pinned
// revision in lib/vendor/soul-contracts/source.json (ADR-0300). Tests check
// the vendored bytes against that revision; nothing here fetches.

import { readFileSync } from 'node:fs';
import { CommsError } from '../errors.mjs';
import { compileSchema } from './json-schema.mjs';

const ROOT = new URL('../vendor/soul-contracts/schemas/', import.meta.url);

export const CONTRACT_SCHEMAS = Object.freeze([
  'wire/v1/wire-frame.schema.json',
  'wire/v1/directive-or-query.schema.json',
  'task/v1/task-record.schema.json',
  'task/v1/task-commitment.schema.json',
  'task/v1/action-record.schema.json',
]);

const validators = new Map(CONTRACT_SCHEMAS.map((path) => [path,
  compileSchema(JSON.parse(readFileSync(new URL(path, ROOT), 'utf8')), path)]));

export const violations = (path, value) => {
  const validate = validators.get(path);
  if (!validate) throw new Error(`no vendored contract schema ${path}`);
  return validate(value);
};

const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

// Validates `value` against one contract schema and returns a deep-frozen
// copy, unchanged. A violation throws `bad-request` (the contract names no
// code for a malformed record), or `overrides[keyword]` when the contract
// ties that keyword's failure to a registered error code.
export function admit(path, value, overrides = {}) {
  const found = violations(path, value);
  if (found.length) {
    const key = found.map((v) => `${v.path}:${v.keyword}`).find((k) => Object.hasOwn(overrides, k));
    const first = found[0];
    throw new CommsError(key ? overrides[key] : 'bad-request', `${path}: ${first.keyword} at ${first.path}`);
  }
  return freeze(structuredClone(value));
}
