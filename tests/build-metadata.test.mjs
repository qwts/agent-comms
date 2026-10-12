import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNNING_BUILD } from '../lib/build-metadata.mjs';
import { projectDiagnosticRecord } from '../lib/diagnostic-profile.mjs';

test('running build metadata is bounded, cached and independent of diagnostic sinks', async t => {
  for (const [version, expected] of [['1.2.3-test.4', { buildVersion: '1.2.3-test.4', buildSource: 'running' }],
    ['CANARY-private-version/path', { buildVersion: null, buildSource: 'unknown' }],
    [undefined, { buildVersion: null, buildSource: 'unknown' }]]) {
    const root = mkdtempSync(path.join(tmpdir(), 'ac-build-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, 'lib'));
    for (const file of ['build-metadata.mjs', 'diagnostic-profile.mjs']) copyFileSync(new URL(`../lib/${file}`, import.meta.url), path.join(root, 'lib', file));
    if (version !== undefined) writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
    const moduleUrl = pathToFileURL(path.join(root, 'lib', 'build-metadata.mjs'));
    const { RUNNING_BUILD: build } = await import(moduleUrl);
    assert.deepEqual(build, expected); assert.equal(Object.isFrozen(build), true);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    assert.equal((await import(moduleUrl)).RUNNING_BUILD, build, 'health/diagnostic requests do not reread metadata');
    assert.deepEqual(build, expected);
  }
});

test('private diagnostic projector refuses health metadata and arbitrary health fields', () => {
  const health = { ok: true, ...RUNNING_BUILD, uptimeMs: 1, eventLogBytes: 2, pairings: { accounts: 1, principals: 1 }, watches: 0,
    capabilities: { v: 1, diagnosticRecordVersion: 1, diagnosticExportVersion: 1 } };
  assert.equal(projectDiagnosticRecord(health), null);
  const record = { v: 1, component: 'agent-comms-broker', ...RUNNING_BUILD, event: 'broker.started',
    eventId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222',
    operation: 'broker.lifecycle', stage: 'startup', code: 'ready', outcome: 'succeeded', observedAtUnixMs: 1 };
  assert.deepEqual(projectDiagnosticRecord(record), record);
  assert.equal(projectDiagnosticRecord({ ...record, capabilities: health.capabilities }), null);
  assert.equal(projectDiagnosticRecord({ ...record, health }), null);
});
