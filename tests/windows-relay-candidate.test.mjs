import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RELAY_STARTUP_SOURCE, verifyRelayStartupSource, verifiedRelayContract, relayBuildArguments, relayBuildFailure } from '../tools/acceptance/windows-relay-candidate.mjs';
import { CORRECTED_STARTUP_SOURCE, verifyCorrectedStartupSource, verifyCandidateComponent } from '../tools/acceptance/windows-corrected-startup.mjs';

test('archive build explicitly selects the bootstrap process policy and refuses a different source stamp', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'relay-build-arguments-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => relayBuildArguments(root));
  writeFileSync(path.join(root, 'RELEASE_COMMIT'), RELAY_STARTUP_SOURCE.pin);
  const args = relayBuildArguments(root);
  assert.deepEqual(args.slice(args.indexOf('-ExecutionPolicy'), -2), ['-ExecutionPolicy', 'Bypass']);
  assert.deepEqual(args.slice(-2), ['-File', path.join(root, 'scripts/build-windows-relay.ps1')]);
  writeFileSync(path.join(root, 'RELEASE_COMMIT'), 'a'.repeat(40));
  assert.throws(() => relayBuildArguments(root));
});

test('build failure receipt distinguishes timeout from exit without retaining raw diagnostics', () => {
  assert.deepEqual(relayBuildFailure({ killed: true, signal: 'SIGTERM', stderr: 'private output' }),
    { check: 'relay-build-timeout', exitCode: null, signal: 'SIGTERM', reason: 'unclassified', compilerErrors: [] });
  assert.deepEqual(relayBuildFailure({ code: 1, stderr: 'private output' }),
    { check: 'relay-build-failed', exitCode: 1, signal: null, reason: 'unclassified', compilerErrors: [] });
  assert.deepEqual(relayBuildFailure({ code: 'ENOENT', signal: 'untrusted' }),
    { check: 'relay-build-failed', exitCode: null, signal: null, reason: 'unclassified', compilerErrors: [] });
  const refusal = relayBuildFailure({ code: 1, stderr: 'private path CouldNotAutoloadMatchingModule', stdout: 'private path error CS2001 CS2001' });
  assert.equal(refusal.reason, 'module-load');
  assert.deepEqual(refusal.compilerErrors, ['CS2001']);
  assert.equal(JSON.stringify(refusal).includes('private'), false);
});

test('relay candidate component approval uses pinned bytes, not a mutable CRLF checkout', () => {
  const text = readFileSync(new URL('../lib/platform/windows-pipe-stage.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const digest = value => createHash('sha256').update(value).digest('hex');
  const canonical = digest(text), checkout = digest(text.replace(/\n/g, '\r\n'));
  assert.equal(canonical, RELAY_STARTUP_SOURCE.pipeStageSha256);
  assert.notEqual(canonical, checkout);
  assert.throws(() => verifyCandidateComponent(canonical, checkout), /candidate-source-mismatch/);
  verifyCandidateComponent(canonical, RELAY_STARTUP_SOURCE.pipeStageSha256);
  assert.throws(() => verifyCandidateComponent(checkout, RELAY_STARTUP_SOURCE.pipeStageSha256), /candidate-source-mismatch/);
});

test('prebuilt-relay candidate has an independent fixed source approval; legacy inputs cannot substitute', () => {
  const { tree, archiveSha256 } = RELAY_STARTUP_SOURCE;
  assert.equal(RELAY_STARTUP_SOURCE.pin, 'ba75753e8e99e7c475baff9bfa139721276b5b06');
  assert.deepEqual(verifyRelayStartupSource(tree, archiveSha256), RELAY_STARTUP_SOURCE);
  assert.throws(() => verifyCorrectedStartupSource(tree, archiveSha256), /candidate-source-mismatch/);
  assert.throws(() => verifyRelayStartupSource(CORRECTED_STARTUP_SOURCE.tree, CORRECTED_STARTUP_SOURCE.archiveSha256), /candidate-source-mismatch/);
  for (const pair of [['0'.repeat(40), archiveSha256], [tree, '0'.repeat(64)], [tree, `${archiveSha256}\n`]]) {
    assert.throws(() => verifyRelayStartupSource(...pair), /candidate-source-mismatch/);
  }
});

test('actual candidate connector contract requires a verified fixed artifact even with inert spawn capture', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'relay-candidate-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'lib', 'platform'), { recursive: true });
  mkdirSync(path.join(root, 'bin', 'windows'), { recursive: true });
  mkdirSync(path.join(root, 'native', 'windows'), { recursive: true });
  for (const name of ['windows-pipe-client.mjs', 'windows-pipe-stage.mjs', 'windows-environment.mjs', 'windows-relay-artifact.mjs']) {
    copyFileSync(new URL(`../lib/platform/${name}`, import.meta.url), path.join(root, 'lib', 'platform', name));
  }
  const source = 'inert public C# fixture';
  writeFileSync(path.join(root, 'native', 'windows', 'AgentCommsPipeRelay.cs'), source);
  writeFileSync(path.join(root, 'RELEASE_COMMIT'), RELAY_STARTUP_SOURCE.pin);
  const binary = Buffer.alloc(256);
  binary.write('MZ'); binary.writeUInt32LE(64, 0x3c); binary.write('PE\0\0', 64);
  binary.writeUInt16LE(0x10b, 88); binary.writeUInt16LE(2, 156);
  const file = path.join(root, 'bin', 'windows', 'agent-comms-pipe-relay.exe');
  writeFileSync(file, binary);
  const digest = value => createHash('sha256').update(value).digest('hex');
  const artifact = { sourceCommit: RELAY_STARTUP_SOURCE.pin, sourceSha256: digest(source), binarySha256: digest(binary), subsystem: 'windows' };
  const manifest = path.join(root, 'bin', 'windows', 'relay-build.json');
  writeFileSync(manifest, JSON.stringify({ format: 1, ...artifact }));
  const result = await verifiedRelayContract(root);
  assert.equal(result.shellExecutable, realpathSync(file));
  assert.deepEqual(result.relayArgs, []);
  assert.deepEqual(result.artifact, artifact);
  assert.equal(result.diagnosticArgs[0], '--input-type=module');
  writeFileSync(file, 'tampered');
  await assert.rejects(verifiedRelayContract(root), { message: 'candidate-source-mismatch' });
  writeFileSync(file, binary);
  writeFileSync(manifest, JSON.stringify({ format: 1, ...artifact, sourceCommit: 'a'.repeat(40) }));
  await assert.rejects(verifiedRelayContract(root), { message: 'candidate-source-mismatch' });
});
