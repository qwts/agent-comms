import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

test('native Get-Acl and DPAPI work through a Node intermediary with inherited PS7 modules', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, () => {
  const pwshHome = execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write($PSHOME)'], { encoding: 'utf8' }).trim();
  const modules = path.join(pwshHome, 'Modules');
  assert.ok(existsSync(modules), 'the regression must carry actual PowerShell 7 modules');
  const script = `
    import assert from 'node:assert/strict';
    import { mkdtempSync, rmSync } from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { createAccountIsolation } from './lib/platform/account-isolation.mjs';
    import { createSecretStore } from './lib/platform/secret-store.mjs';
    import { readHostConfig } from './lib/host-config.mjs';
    import { clientPaths } from './lib/paths.mjs';
    const inherited = process.env.PSModulePath;
    const root = mkdtempSync(path.join(os.tmpdir(), 'comms-native-env-'));
    try {
      const isolation = createAccountIsolation();
      const [entry] = isolation.inspect([root], 'native-inspection');
      assert.ok(entry, 'Get-Acl must return a native inspection');
      assert.match(entry.owner, /^S-1-\\d+(?:-\\d+)+$/);
      assert.equal(entry.kind, 'directory');
      assert.equal(entry.link, false);
      assert.throws(() => isolation.assertOwnedDir(root, 'S-1-0-0'), { code: 'broker-untrusted' });
      const env = { ...process.env, AGENT_COMMS_CLIENT_STATE_DIR: root };
      const host = readHostConfig(env);
      const store = createSecretStore();
      const credential = { principal: 'native-test', secret: 'inert-native-roundtrip' };
      store.savePrincipalCredential(credential, host, env);
      assert.deepEqual(store.readPrincipalCredential(clientPaths(env, host), host, env), credential);
      assert.equal(process.env.PSModulePath, inherited);
      process.stdout.write('native-custody-dpapi-passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, PSModulePath: modules }, encoding: 'utf8', timeout: 25_000,
  });
  assert.equal(output, 'native-custody-dpapi-passed');
});
