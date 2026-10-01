// The ENG-0064 skill read commands. One catalog drives list and show, and a
// test keeps it in step with the router's links.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail } from './errors.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL_DIR = path.join(ROOT, 'skills', 'agent-comms');

export const CATALOG = Object.freeze({
  setup: 'Start the broker, pair an account, and join the hub',
  messaging: 'Find peers, send, read, acknowledge, and watch for messages',
  workers: 'Run a headless harness as a worker that answers its inbox',
});

export const router = () => readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

export const list = () => Object.entries(CATALOG).map(([feature, summary]) => ({ feature, summary }));

export function show(feature) {
  if (!Object.hasOwn(CATALOG, feature)) fail('unknown-feature', `no skill feature named ${feature}`);
  return readFileSync(path.join(SKILL_DIR, 'references', `${feature}.md`), 'utf8');
}

export function location() {
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // an installed copy outside git reports no commit
  }
  return { dir: SKILL_DIR, commit };
}
