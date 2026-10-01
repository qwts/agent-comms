// Named tiers: the model, effort, sandbox, workspace, and turn timeout for a
// class of work, kept in a config file so the command line carries a name
// instead of five flags. A flag always wins over the tier it overrides.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fail } from '../errors.mjs';

// Only these keys reach the worker; anything else in a tier file is ignored
// rather than passed along to a harness.
const FIELDS = ['model', 'effort', 'sandbox', 'workspace', 'turnTimeoutMs'];

export const defaultConfigPath = (env = process.env) => path.join(
  env.XDG_CONFIG_HOME || path.join(env.HOME ?? '', '.config'), 'agent-comms', 'workers.json',
);

function load(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return fail('worker-config-invalid', `cannot read the worker config ${file}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.tiers || typeof parsed.tiers !== 'object') {
    return fail('worker-config-invalid', `${file} must hold { "default": NAME, "tiers": { NAME: { ... } } }`);
  }
  return parsed;
}

export function resolveTier({ config = null, tier = null, env = process.env } = {}) {
  if (!config && !tier) return {};
  const file = config ?? defaultConfigPath(env);
  const { tiers, default: fallback } = load(file);
  const name = tier ?? fallback ?? null;
  if (!name) return {};
  const settings = tiers[name];
  if (!settings || typeof settings !== 'object') {
    return fail('unknown-tier', `no tier named ${name} in ${file}; try one of ${Object.keys(tiers).join(', ') || 'none'}`);
  }
  return Object.fromEntries(FIELDS.filter((field) => settings[field] !== undefined).map((field) => [field, settings[field]]));
}
