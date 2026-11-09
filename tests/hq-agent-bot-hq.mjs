// A checkout of agent-bot-hq at the commit the vendored SDK came from
// (lib/vendor/agent-bot-sdk/source.json, ADR-0306). Tests compare the
// vendored bytes against it and run the real HQ from it. It is cached under
// node_modules/.cache; with no cache and no network the tests fail, never
// skip.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VENDOR = fileURLToPath(new URL('../lib/vendor/agent-bot-sdk/', import.meta.url));
export const SOURCE = JSON.parse(readFileSync(join(VENDOR, 'source.json'), 'utf8'));

export function agentBotHq() {
  const parent = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url));
  const cache = join(parent, `agent-bot-hq-${SOURCE.commit}`);
  if (existsSync(join(cache, 'sdk'))) return cache;
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, 'agent-bot-hq-fetch-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', work, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    git('init', '-q');
    git('fetch', '-q', '--depth', '1', SOURCE.repository, SOURCE.commit);
    git('checkout', '-q', 'FETCH_HEAD');
    const head = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(head, SOURCE.commit, 'fetched agent-bot-hq revision');
    rmSync(join(work, '.git'), { recursive: true, force: true });
    // Test files run in parallel and may fetch at once. The first rename
    // wins; a later one keeps the winner's tree, which another file may
    // already be running HQ from, and discards its own.
    try {
      renameSync(work, cache);
    } catch (error) {
      if (!existsSync(join(cache, 'sdk'))) throw error;
      rmSync(work, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`cannot fetch agent-bot-hq ${SOURCE.commit}: ${error.stderr?.toString().trim() || error.message}`);
  }
  return cache;
}
