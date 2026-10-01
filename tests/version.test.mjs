import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/agent-comms.mjs', import.meta.url));
const PKG = new URL('../package.json', import.meta.url);
const LOCK = new URL('../package-lock.json', import.meta.url);
const SKILL = new URL('../skills/agent-comms/SKILL.md', import.meta.url);
const FORMULA = new URL('../Formula/agent-comms.rb', import.meta.url);

const pkgVersion = () => JSON.parse(readFileSync(PKG, 'utf8')).version;
const cliVersion = () => execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' }).trim().split(/\s+/).at(-1);
const validated = () => readFileSync(SKILL, 'utf8').match(/qwts-validated: "(\S+)"/)[1];
const formula = () => readFileSync(FORMULA, 'utf8');
const lock = () => JSON.parse(readFileSync(LOCK, 'utf8'));

test('package.json version matches --version output and qwts-validated', () => {
  assert.equal(cliVersion(), pkgVersion());
  assert.equal(validated(), pkgVersion());
});

test('package-lock.json carries the package version', () => {
  assert.equal(lock().version, pkgVersion());
  assert.equal(lock().packages[''].version, pkgVersion());
});

test('the formula pins the release tag and version of package.json', () => {
  assert.equal(formula().match(/^\s*tag:\s*"v(\S+)"/m)?.[1], pkgVersion());
  assert.equal(formula().match(/^\s*version "(\S+)"/m)?.[1], pkgVersion());
});
