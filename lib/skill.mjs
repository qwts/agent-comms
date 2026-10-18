// The ENG-0064 skill read commands. One catalog drives list and show, and a
// test keeps it in step with the router's links.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail } from './errors.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL_DIR = path.join(ROOT, 'skills', 'agent-comms');

export const CATALOG = Object.freeze({
  setup: 'Start the broker, pair an account, and join the hub',
  messaging: 'Find peers, send, read, acknowledge, and watch for messages',
  subagents: 'Spawn a soul, join with your parent, and leave when done',
  workers: 'Run a headless harness as a worker that answers its inbox',
});

export const router = () => readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

export const list = () => Object.entries(CATALOG).map(([feature, summary]) => ({ feature, summary }));

export function show(feature) {
  if (!Object.hasOwn(CATALOG, feature)) fail('unknown-feature', `no skill feature named ${feature}`);
  return readFileSync(path.join(SKILL_DIR, 'references', `${feature}.md`), 'utf8');
}

export function sourceCommit(root = ROOT) {
  // Do not inherit an enclosing checkout's HEAD from an installed copy.
  if (existsSync(path.join(root, '.git'))) {
    try {
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return commit;
    } catch {
      // A release stamp can still identify a packaged tree without Git.
    }
  }
  try {
    const commit = readFileSync(path.join(root, 'RELEASE_COMMIT'), 'utf8').trim();
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return commit;
  } catch {
    // Preserve the existing null shape when source provenance is unavailable.
  }
  return null;
}

export const location = () => ({ dir: SKILL_DIR, commit: sourceCommit() });
