import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CORRECTED_STARTUP_SOURCE, verifyCorrectedStartupSource, classifyFixtureFailure } from '../tools/acceptance/windows-corrected-startup.mjs';
import { createCapacityController } from '../tools/acceptance/windows-capacity-control.mjs';
import { retainCapacityFailure } from '../tools/acceptance/windows-capacity-lifecycle.mjs';

test('corrected startup requires both the reviewed tree and Windows archive digest, independent of caller checkout', () => {
  const { tree, archiveSha256 } = CORRECTED_STARTUP_SOURCE;
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

for (const [code, probe] of [['broker-probe-failed', undefined], ['CANARY-private-code', undefined], ['storage-failed', 'storage']]) {
  test(`actual fixture IPC reports ${probe === 'storage' ? 'storage failure' : code === 'broker-probe-failed' ? 'known refusal' : 'unknown failure'} and still performs owned cleanup`, async () => {
    // Harness regression only: the manual acceptance mode always verifies and
    // imports the pinned production archive. This stub makes failure deterministic.
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'comms-candidate-ipc-'));
    const cleaned = path.join(scratch, 'cleaned');
    mkdirSync(path.join(scratch, 'lib'));
    writeFileSync(path.join(scratch, 'lib/broker.mjs'), `import {writeFileSync} from 'node:fs';export class Broker{async start(){throw Object.assign(new Error('CANARY-body-source-secret'),{code:${JSON.stringify(code)},cause:new Error('CANARY-cause')})}maintain(){throw Object.assign(new Error('CANARY-storage-secret'),{code:${JSON.stringify(code)}})}async stop(){writeFileSync(${JSON.stringify(cleaned)},'stopped')}}`);
    writeFileSync(path.join(scratch, 'lib/client.mjs'), 'export const unused = true;');
    writeFileSync(path.join(scratch, 'lib/paths.mjs'), 'export function brokerPaths(){return {}};export function clientPaths(){return {}};');
    writeFileSync(path.join(scratch, 'lib/state.mjs'), 'export class EventLog{constructor(){this.file="private"}replay(){return {seq:0}}}');
    writeFileSync(path.join(scratch, 'lib/retention.mjs'), 'export function nextExpiry(){return Infinity}');
    mkdirSync(path.join(scratch, 'lib/platform'));
    writeFileSync(path.join(scratch, 'lib/platform/account-isolation.mjs'), 'export function assertLogFile(){}');
    writeFileSync(path.join(scratch, 'lib/platform/local-channel.mjs'), 'export function prepare(){return "private"}');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../tools/acceptance/windows-connector-capacity.mjs', import.meta.url)), '--fixture', scratch], { stdio: ['ignore','pipe','pipe','ipc'] });
    let stdout = '', stderr = '', failure;
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const terminal = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
    child.on('message', record => { if (record.id === 1) failure = record; });
    const control = createCapacityController({ child, exited: terminal, terminal: () => child.exitCode !== null }, { ipc: true,
      classifyFailure: record => classifyFixtureFailure(record, new Set(['operation-failed'])) });
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      assert.equal((await control.startup).paused, true);
      await assert.rejects(control.request('start', probe ? { probe } : {}), error => {
        assert.equal(error.message, 'operation-failed');
        assert.equal(error.brokerCode, code !== 'CANARY-private-code' ? code : undefined);
        assert.equal(JSON.stringify(error).includes('CANARY'), false);
        return true;
      });
      assert.deepEqual(await terminal, { exitCode: 1, signal: null });
      assert.equal(readFileSync(cleaned, 'utf8'), 'stopped');
      assert.deepEqual(failure, { id: 1, ok: false, failure: { stage: 'fixture-startup', check: 'operation-failed',
        ...(code !== 'CANARY-private-code' ? { brokerCode: code } : {}) } });
      assert.equal(control.state().phase, probe === 'storage' ? 'storage-maintain' : 'fixture-broker-start');
      assert.equal(stdout, ''); assert.equal(stderr, ''); assert.equal(JSON.stringify(failure).includes('CANARY'), false);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); rmSync(scratch, { recursive: true, force: true }); }
  });
}
