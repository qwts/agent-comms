import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CORRECTED_STARTUP_SOURCE, canonicalCandidateArchiveArgs, verifyCandidateComponent, verifyCorrectedStartupSource, classifyFixtureFailure } from '../tools/acceptance/windows-corrected-startup.mjs';
import { createCapacityController } from '../tools/acceptance/windows-capacity-control.mjs';
import { retainCapacityFailure } from '../tools/acceptance/windows-capacity-lifecycle.mjs';
import { projectWindowsPipeStage } from '../lib/platform/windows-pipe-stage.mjs';

test('corrected startup requires both the reviewed tree and Windows archive digest, independent of caller checkout', () => {
  const { tree, archiveSha256 } = CORRECTED_STARTUP_SOURCE;
  assert.equal(CORRECTED_STARTUP_SOURCE.pin, 'cb50469ca0b6757c4ab860de582b9b140fc525a0');
  assert.throws(() => verifyCorrectedStartupSource('9c1719821d656e17eb04dc477cc9415e4697f12f',
    'd3465c40e5e11561f22f3aa720f74146aa70b2091dcd09c34c1c4046daea6853'), { message: 'candidate-source-mismatch' });
  const receipt = verifyCorrectedStartupSource(tree, archiveSha256);
  assert.deepEqual(receipt, CORRECTED_STARTUP_SOURCE);
  receipt.pin = 'unreviewed';
  assert.notEqual(CORRECTED_STARTUP_SOURCE.pin, receipt.pin);
  for (const [observedTree, observedHash] of [[`0${tree.slice(1)}`, archiveSha256],
    [tree, `0${archiveSha256.slice(1)}`], [tree, `${archiveSha256}\n`], ['CANARY-private-path', archiveSha256]]) {
    assert.throws(() => verifyCorrectedStartupSource(observedTree, observedHash), { message: 'candidate-source-mismatch' });
  }
});

test('candidate failure receipt retains the scoped revision and known code while dropping arbitrary peer data', () => {
  const report = retainCapacityFailure({ stage: 'production-startup', check: 'operation-failed', brokerCode: 'broker-probe-failed',
    message: 'CANARY-secret', cause: new Error('CANARY-source') }, { revision: 'candidate', preflight: 'candidate-startup' }, {});
  assert.equal(report.revision, 'candidate'); assert.equal(report.preflight, 'candidate-startup');
  assert.equal(report.brokerCode, 'broker-probe-failed'); assert.equal(JSON.stringify(report).includes('CANARY'), false);
  assert.equal(retainCapacityFailure({ stage: 'production-startup', check: 'operation-failed', brokerCode: 'CANARY-private-code' }, {}, {}).brokerCode, undefined);
});

for (const [code, probe, stage] of [['broker-probe-failed', undefined], ['CANARY-private-code', undefined], ['broker-timeout', undefined], ['storage-failed', 'storage'], ['broker-probe-failed', 'channel'],
  ['broker-unreachable', undefined, 'startup-timeout'], ['broker-unreachable', undefined, 'CANARY-stage'], ['broker-unreachable', undefined, 'getter']]) {
  test(`actual fixture IPC reports ${stage ? `${stage} stage` : probe === 'channel' ? 'channel refusal' : probe === 'storage' ? 'storage failure' : code === 'broker-timeout' ? 'known timeout' : code === 'broker-probe-failed' ? 'known refusal' : 'unknown failure'} and still performs owned cleanup`, async () => {
    // Harness regression only: the manual acceptance mode always verifies and
    // imports the pinned production archive. This stub makes failure deterministic.
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'comms-candidate-ipc-'));
    const cleaned = path.join(scratch, 'cleaned');
    const stageSetup = stage === 'getter'
      ? "Object.defineProperty(error,'windowsPipeStage',{get(){throw new Error('CANARY-stage-getter')}});"
      : stage === undefined ? '' : `Object.defineProperty(error,'windowsPipeStage',{value:${JSON.stringify(stage)}});`;
    const expectedStage = stage === 'startup-timeout' ? stage : undefined;
    mkdirSync(path.join(scratch, 'lib'));
    writeFileSync(path.join(scratch, 'lib/broker.mjs'), `import {writeFileSync} from 'node:fs';export class Broker{async start(){const error=Object.assign(new Error('CANARY-body-source-secret'),{code:${JSON.stringify(code)},cause:new Error('CANARY-cause')});${stageSetup}throw error}maintain(){throw Object.assign(new Error('CANARY-storage-secret'),{code:${JSON.stringify(code)}})}async stop(){writeFileSync(${JSON.stringify(cleaned)},'stopped')}}`);
    writeFileSync(path.join(scratch, 'lib/client.mjs'), 'export const unused = true;');
    writeFileSync(path.join(scratch, 'lib/paths.mjs'), 'export function brokerPaths(){return {}};export function clientPaths(){return {}};');
    writeFileSync(path.join(scratch, 'lib/state.mjs'), 'export class EventLog{constructor(){this.file="private"}replay(){return {seq:0}}}');
    writeFileSync(path.join(scratch, 'lib/retention.mjs'), 'export function nextExpiry(){return Infinity}');
    mkdirSync(path.join(scratch, 'lib/platform'));
    writeFileSync(path.join(scratch, 'lib/platform/account-isolation.mjs'), 'export function assertLogFile(){}');
    writeFileSync(path.join(scratch, 'lib/platform/local-channel.mjs'), `import {writeFileSync} from 'node:fs';export function prepare(){return 'private'}export async function removeStaleSocket(){throw Object.assign(new Error('CANARY-channel-secret'),{code:${JSON.stringify(code)}})}export function stop(){writeFileSync(${JSON.stringify(cleaned)},'stopped')}`);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../tools/acceptance/windows-connector-capacity.mjs', import.meta.url)), '--fixture', scratch, ...(probe === 'channel' ? ['--candidate-channel-timing'] : probe === undefined ? ['--candidate-startup-timing'] : [])], { stdio: ['ignore','pipe','pipe','ipc'] });
    let stdout = '', stderr = '', failure;
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const terminal = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
    child.on('message', record => { if (record.id === 1) failure = record; });
    const control = createCapacityController({ child, exited: terminal, terminal: () => child.exitCode !== null }, { ipc: true, capturePhaseTimings: true, timingMode: probe === 'channel' ? 'candidate-channel' : probe === undefined ? 'candidate-startup' : 'default',
      classifyFailure: record => classifyFixtureFailure(record, new Set(['operation-failed'])) });
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      assert.equal((await control.startup).paused, true);
      await assert.rejects(control.request('start', { ...(probe ? { probe } : {}), phaseTimings: true, timingCapMs: 999_999 }), error => {
        assert.equal(error.message, 'operation-failed');
        assert.equal(error.brokerCode, code !== 'CANARY-private-code' ? code : undefined);
        assert.equal(projectWindowsPipeStage(error), expectedStage);
        const retained = retainCapacityFailure(error, { revision: 'candidate', preflight: 'candidate-startup' }, {});
        assert.equal(retained.windowsPipeStage, expectedStage);
        assert.equal(JSON.stringify(error).includes('CANARY'), false);
        return true;
      });
      assert.deepEqual(await terminal, { exitCode: 1, signal: null });
      assert.equal(readFileSync(cleaned, 'utf8'), 'stopped');
      assert.deepEqual(failure, { id: 1, ok: false, failure: { stage: 'fixture-startup', check: 'operation-failed',
        ...(code !== 'CANARY-private-code' ? { brokerCode: code } : {}),
        ...(expectedStage === undefined ? {} : { windowsPipeStage: expectedStage }) } });
      assert.equal(control.state().phase, probe === 'channel' ? 'channel-stale-main-returned' : probe === 'storage' ? 'storage-maintain' : 'fixture-broker-start');
      const timeline = control.state().phaseTimings;
      assert.ok(timeline.length >= 2); assert.equal(timeline.at(-1).phase, control.state().phase);
      assert.ok(timeline.every((row, index) => Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= (timeline[index - 1]?.elapsedMs ?? 0)));
      assert.equal(stdout, ''); assert.equal(stderr, ''); assert.equal(JSON.stringify(failure).includes('CANARY'), false);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); rmSync(scratch, { recursive: true, force: true }); }
  });
}

// Uses the actual Git archive and tar extraction boundary on every CI platform.
// HEAD and these paths are fixed by this checkout; no revision comes from input.
test('canonical candidate archive defeats ambient CRLF conversion and retains strict component refusal', () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'comms-archive-bytes-'));
  const components = ['lib/platform/windows-pipe-client.mjs', 'lib/platform/windows-pipe-stage.mjs'];
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const git = args => {
    const result = spawnSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 10_000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0);
    return result.stdout;
  };
  const ambient = ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf'];
  try {
    const originals = components.map(name => git(['show', `HEAD:${name}`]));
    for (const [label, args] of [
      ['original', ['archive', '--format=tar', 'HEAD']],
      ['canonical', canonicalCandidateArchiveArgs('HEAD')],
    ]) {
      const archive = path.join(scratch, `${label}.tar`), extracted = path.join(scratch, label);
      writeFileSync(archive, git([...ambient, ...args, ...components])); mkdirSync(extracted);
      const extraction = spawnSync('tar', ['-xf', archive, '-C', extracted], { timeout: 10_000, maxBuffer: 64 * 1024 });
      assert.equal(extraction.error, undefined); assert.equal(extraction.status, 0);
      components.forEach((name, index) => {
        const bytes = readFileSync(path.join(extracted, name));
        if (label === 'original') {
          assert.ok(bytes.includes(Buffer.from('\r\n')));
          assert.throws(() => verifyCandidateComponent(digest(bytes), digest(originals[index])), { message: 'candidate-source-mismatch' });
        } else {
          assert.deepEqual(bytes, originals[index]);
          verifyCandidateComponent(digest(bytes), digest(originals[index]));
          const tampered = Buffer.from(bytes); tampered[0] ^= 1;
          assert.throws(() => verifyCandidateComponent(digest(tampered), digest(originals[index])), { message: 'candidate-source-mismatch' });
        }
      });
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
