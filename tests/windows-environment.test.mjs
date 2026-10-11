import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { windowsPowershellEnvironment } from '../lib/platform/windows-environment.mjs';
import { createAccountIsolation } from '../lib/platform/account-isolation.mjs';
import { createSecretStore } from '../lib/platform/secret-store.mjs';
import { readHostConfig } from '../lib/host-config.mjs';
import { clientPaths } from '../lib/paths.mjs';

test('native custody and DPAPI normalize only their PowerShell child environment', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'comms-env-'));
  const env = { PSModulePath: 'PS7-modules', pSmOdUlEpAtH: 'another-PS7-path', Path: 'kept-path',
    sentinel: 'kept', AGENT_COMMS_CLIENT_STATE_DIR: root };
  const original = { ...env };
  const expected = { Path: 'kept-path', sentinel: 'kept', AGENT_COMMS_CLIENT_STATE_DIR: root };
  const sid = 'S-1-5-21-111-222-333-1001';
  const calls = [];
  try {
    const isolation = createAccountIsolation('win32', { env, run: (file, args, options) => {
      calls.push({ file, options });
      return { status: 0, stdout: `${sid}|directory|real\n`, stderr: '' };
    } });
    assert.equal(isolation.assertOwnedDir(root, sid).owner, sid);
    const credential = { principal: 'test', secret: 'inert-fixture' };
    const encoded = Buffer.from(JSON.stringify(credential));
    const store = createSecretStore('win32', { env, run: (file, args, options) => {
      calls.push({ file, options });
      return { status: 0, stdout: options.input.includes('::Protect(') ? encoded.toString('base64') : encoded.toString('hex'), stderr: '' };
    } });
    const host = readHostConfig(env);
    store.savePrincipalCredential(credential, host, env);
    assert.deepEqual(store.readPrincipalCredential(clientPaths(env, host), host, env), credential);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.file, 'powershell.exe');
      assert.deepEqual(call.options.env, expected);
    }
    assert.deepEqual(windowsPowershellEnvironment(env), expected);
    assert.deepEqual(env, original, 'caller settings remain unchanged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
