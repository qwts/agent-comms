import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CATALOG, list, router, show } from '../lib/skill.mjs';

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
