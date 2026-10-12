import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { preserveWindowsPipeStage, projectWindowsPipeStage } from '../lib/platform/windows-pipe-stage.mjs';

const driver = fileURLToPath(new URL('./fixtures/windows-client-stage-driver.mjs', import.meta.url));
function run(scenario) {
  const result = spawnSync(process.execPath, [driver, scenario], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /CANARY|windowsPipeStage/);
  return JSON.parse(result.stdout);
}

test('one closed local stage projector accepts own primitive data without getters, coercion or exception serialization', () => {
  for (const stage of ['host-clixml','host-stderr','pipe-refused','process-error','premature-close','startup-timeout']) {
    const error = new Error('CANARY-private');
    assert.equal(preserveWindowsPipeStage(error, { windowsPipeStage: stage }), error);
    assert.equal(projectWindowsPipeStage(error), stage);
    assert.deepEqual(Object.keys(error), []);
    assert.equal(JSON.stringify(error), '{}');
  }
  let reads = 0;
  const getter = Object.defineProperty({}, 'windowsPipeStage', { get() { reads += 1; throw new Error('CANARY-getter'); } });
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('CANARY-proxy'); } });
  for (const source of [getter, hostile, Object.create({ windowsPipeStage: 'pipe-refused' }),
    { windowsPipeStage: 'CANARY-secret' }, { windowsPipeStage: { toString() { assert.fail('coercion'); } } }, null, 'pipe-refused']) {
    assert.equal(projectWindowsPipeStage(source), undefined);
    assert.equal(projectWindowsPipeStage(preserveWindowsPipeStage(new Error(), source)), undefined);
  }
  assert.equal(reads, 0);
  assert.doesNotThrow(() => preserveWindowsPipeStage(Object.freeze(new Error()), { windowsPipeStage: 'pipe-refused' }));
});

for (const scenario of ['pipe-refused','host-stderr','host-clixml','process-error','premature-close','startup-timeout']) {
  test(`real connector → handshake → client wrapper preserves only fixed ${scenario}`, () => {
    const result = run(scenario);
    assert.equal(result.code, 'broker-unreachable'); assert.equal(result.stage, scenario);
    assert.equal(result.kills, 1);
    if (scenario === 'startup-timeout') assert.deepEqual(result.deadlines, [10_000, 10_000]);
    assert.equal(result.public.code, 'broker-unreachable'); assert.equal(result.public.windowsPipeStage, undefined);
  });
}
test('actual client keeps typed proof refusal and ignores stage injection in a remote response', () => {
  const typed = run('typed-refusal');
  assert.equal(typed.code, 'broker-untrusted'); assert.equal(typed.stage, undefined); assert.equal(typed.kills, 1);
  const remote = run('remote-injection');
  assert.equal(remote.code, 'permission-denied'); assert.equal(remote.stage, undefined);
  assert.deepEqual(run('success').result, { ok: true, value: 'actual-response' });
});
test('actual client preserves first typed/generic/success outcome despite throwing disposal and duplicate late events', () => {
  const typed = run('cleanup-typed');
  assert.equal(typed.code, 'broker-untrusted'); assert.equal(typed.stage, undefined); assert.equal(typed.destroys, 1);
  const generic = run('cleanup-generic');
  assert.equal(generic.code, 'broker-unreachable'); assert.equal(generic.stage, 'pipe-refused'); assert.equal(generic.destroys, 1);
  const success = run('cleanup-success');
  assert.deepEqual(success.result, { ok: true, value: 'actual-response' }); assert.equal(success.destroys, 1);
  // Disposal was attempted; this harness deliberately does not prove cleanup.
});

test('actual generic wrapper discards unknown and accessor stages without evaluating them', () => {
  for (const scenario of ['cleanup-getter','cleanup-unknown']) {
    const result = run(scenario);
    assert.equal(result.code, 'broker-unreachable'); assert.equal(result.stage, undefined);
    assert.equal(result.stageReads, 0); assert.equal(result.destroys, 1);
  }
});
