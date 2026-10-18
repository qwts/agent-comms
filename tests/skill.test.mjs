import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CATALOG, list, location, router, show, sourceCommit } from '../lib/skill.mjs';

const BIN = fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url));
const run = (...args) => execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('the router links exactly the catalog features (ENG-0064 decision 4)', () => {
  const linked = [...router().matchAll(/\(references\/([a-z0-9-]+)\.md\)/g)].map((match) => match[1]).sort();
  assert.deepEqual(linked, Object.keys(CATALOG).sort());
  for (const { feature } of list()) assert.ok(show(feature).length > 0);
});

test('skill and skill show print the packaged files byte for byte', () => {
  assert.equal(run('skill'), router());
  assert.equal(run('skill', 'show', 'messaging'), show('messaging'));
});

test('an unknown feature fails with a stable code and no fallback', () => {
  let failure;
  try {
    run('skill', 'show', 'nope');
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(JSON.parse(failure.stdout).error.code, 'unknown-feature');
});

test('--version lies inside the skill range', () => {
  const version = run('--version').trim().split(/\s+/).at(-1);
  const range = router().match(/qwts-versions: ">=(\S+) <(\S+)"/);
  const validated = router().match(/qwts-validated: "(\S+)"/)[1];
  const parse = (v) => v.split('.').map(Number);
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i += 1) if (parse(a)[i] !== parse(b)[i]) return parse(a)[i] - parse(b)[i];
    return 0;
  };
  for (const v of [version, validated]) {
    assert.ok(cmp(v, range[1]) >= 0 && cmp(v, range[2]) < 0, `${v} outside ${range[0]}`);
  }
});

 test('the prose compatibility range agrees with skill metadata', () => {
  const metadata = router().match(/qwts-versions: "([^"]+)"/)[1];
  const prose = router().match(/This skill covers `([^`]+)`/)[1];
  assert.equal(prose, metadata);
});

test('skill path reports the source checkout commit', () => {
  const actual = JSON.parse(run('skill', 'path'));
  assert.equal(actual.commit, execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(path.dirname(BIN), '..'), encoding: 'utf8',
  }).trim());
  assert.equal(actual.dir, location().dir);
});

test('packaged source provenance uses its stamp, never an enclosing repository', t => {
  const parent = mkdtempSync(path.join(tmpdir(), 'comms-provenance-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', parent]);
  execFileSync('git', ['-C', parent, '-c', 'user.name=Parent fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'Fixture']);
  const root = path.join(parent, 'installed');
  mkdirSync(root);
  assert.equal(sourceCommit(root), null);
  const commit = 'a'.repeat(40);
  writeFileSync(path.join(root, 'RELEASE_COMMIT'), `${commit}\n`);
  assert.equal(sourceCommit(root), commit);
  const sha256 = 'b'.repeat(64);
  writeFileSync(path.join(root, 'RELEASE_COMMIT'), `${sha256}\n`);
  assert.equal(sourceCommit(root), sha256);
  for (const invalid of ['$Format:%H$', 'short-sha', 'A'.repeat(40), 'c'.repeat(41), 'd'.repeat(63), 'e'.repeat(65)]) {
    writeFileSync(path.join(root, 'RELEASE_COMMIT'), invalid);
    assert.equal(sourceCommit(root), null);
  }
});

test('git archives expand the release provenance stamp', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'comms-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args]);
  git('init', '--quiet');
  for (const file of ['.gitattributes', 'RELEASE_COMMIT']) {
    writeFileSync(path.join(root, file), readFileSync(new URL(`../${file}`, import.meta.url)));
  }
  git('add', '.');
  git('-c', 'user.name=Archive fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture');
  const commit = git('rev-parse', 'HEAD').toString().trim();
  const archive = git('archive', '--format=tar', 'HEAD', 'RELEASE_COMMIT');
  assert.ok(archive.includes(Buffer.from(`${commit}\n`)));
  assert.ok(!archive.includes(Buffer.from('$Format:%H$')));
});


test('source provenance supports a SHA-256 checkout', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'comms-sha256-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args]);
  git('init', '--quiet', '--object-format=sha256');
  git('-c', 'user.name=SHA256 fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'Fixture');
  const commit = git('rev-parse', 'HEAD').toString().trim();
  assert.equal(commit.length, 64);
  assert.equal(sourceCommit(root), commit);
});
