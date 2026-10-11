// Explicit, offline acceptance: archive pinned source objects into disposable space.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestFile = path.join(here, 'state-format-manifest.json');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('usage: node tools/acceptance/state-format.mjs [--output NEW_EMPTY_DIRECTORY]');
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('this acceptance harness requires a POSIX host; it does not establish Windows acceptance');
function run(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${executable} failed: ${result.error?.message ?? result.stderr?.toString().trim() ?? result.status}`);
  return result.stdout;
}
const repo = run('git', ['-C', here, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
// A missing object is a precondition failure, never an implicit network fetch.
for (const [name, ref] of Object.entries(manifest.sources)) {
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error(`invalid pinned source ${name}`);
  try { run('git', ['-C', repo, 'cat-file', '-e', `${ref}^{commit}`]); }
  catch { throw new Error(`missing pinned ${name} commit ${ref}; fetch it explicitly as described in tools/acceptance/README.md`); }
}
const output = args.length ? path.resolve(args[1]) : mkdtempSync(path.join(os.tmpdir(), 'agent-comms-format-'));
if (existsSync(output) && readdirSync(output).length) throw new Error('output must be a new or empty directory; authoritative state is never an acceptance input');
mkdirSync(output, { recursive: true, mode: 0o700 });
for (const [name, ref] of Object.entries(manifest.sources)) {
  const destination = path.join(output, name);
  mkdirSync(destination, { mode: 0o700 });
  const archive = run('git', ['-C', repo, 'archive', '--format=tar', ref]);
  run('tar', ['-xf', '-', '-C', destination], { input: archive });
}
copyFileSync(manifestFile, path.join(output, 'manifest.json'));
copyFileSync(path.join(here, 'state-format.test.mjs'), path.join(output, 'cross-version.test.mjs'));
writeFileSync(path.join(output, 'versions.json'), `${JSON.stringify(manifest.sources, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Disposable acceptance output: ${output}\n`);
const result = spawnSync(process.execPath, ['--test', '--test-timeout=30000', path.join(output, 'cross-version.test.mjs')], {
  cwd: output, timeout: 50_000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
});
const log = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}\n` : ''}`;
writeFileSync(path.join(output, 'test.log'), log, { mode: 0o600 });
process.stdout.write(log);
process.exitCode = result.error ? 1 : result.status ?? 1;
