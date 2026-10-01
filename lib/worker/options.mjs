// Worker options: what the run is made of, and the refusals that must happen
// before any harness process exists. A tier supplies the defaults for anything
// the caller left unset, so a flag always overrides its tier.

import { statSync } from 'node:fs';

import { fail } from '../errors.mjs';
import { ADAPTERS, adapterFor } from './adapters.mjs';
import { resolveTier } from './tiers.mjs';

// Codex's default sandbox for a worker: the worktree is writable, the machine
// is not, and nothing outside the worktree is reachable without a decision.
export const FULL_ACCESS = 'danger-full-access';
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

export const stderrLog = (...args) => process.stderr.write(`worker ${new Date().toISOString()} ${args.join(' ')}\n`);

function directory(dir, flag) {
  try {
    if (statSync(dir).isDirectory()) return dir;
  } catch {
    // not there at all
  }
  return fail('usage', `${flag} must name a directory: ${dir}`);
}

export function resolveOptions(options = {}) {
  const env = options.env ?? process.env;
  const tier = resolveTier({ config: options.config ?? null, tier: options.tier ?? null, env });
  const pick = (field, value, fallback = null) => (value === undefined || value === null ? tier[field] ?? fallback : value);

  const adapter = adapterFor(options.harness ?? 'codex', options.adapters ?? ADAPTERS);
  const settings = {
    adapter,
    workspace: directory(pick('workspace', options.workspace, process.cwd()), 'workspace'),
    model: pick('model', options.model),
    effort: pick('effort', options.effort),
    sandbox: pick('sandbox', options.sandbox, 'workspace-write'),
    turnTimeoutMs: pick('turnTimeoutMs', options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS),
    metrics: options.metrics ?? null,
    // A turn with no sandbox is a turn that can rewrite the machine, so it is
    // refused unless the operator asked for it by name.
    allowFullAccess: options.allowFullAccess === true,
    join: { name: options.name ?? null, parent: options.parent ?? null, allow: options.allow ?? null },
    env,
    paths: options.paths,
    client: options.client,
    bin: options.bin,
    log: options.log ?? stderrLog,
    now: options.now ?? (() => Date.now()),
    reconnectMs: options.reconnectMs ?? 1_000,
    killAfterMs: options.killAfterMs ?? 5_000,
    transport: options.transport ?? null,
    watch: options.watch ?? null,
    jailRoot: options.jailRoot,
  };

  if (settings.sandbox === FULL_ACCESS && !settings.allowFullAccess) {
    fail('unsafe-sandbox', `${FULL_ACCESS} turns are refused unless the run allows them explicitly`);
  }
  if (!Number.isInteger(settings.turnTimeoutMs) || settings.turnTimeoutMs < 1) {
    fail('usage', 'turnTimeoutMs must be a whole number of milliseconds above zero');
  }
  return settings;
}
