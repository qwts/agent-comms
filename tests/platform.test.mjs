import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createLocalChannel } from '../lib/platform/local-channel.mjs';
import { createSecretStore } from '../lib/platform/secret-store.mjs';
import { createServiceStartup } from '../lib/platform/service-startup.mjs';
import { createAccountIsolation } from '../lib/platform/account-isolation.mjs';
import * as channel from '../lib/broker/server.mjs';
import * as startup from '../lib/broker/launchagent.mjs';

const seams = { 'local-channel': createLocalChannel, 'secret-store': createSecretStore,
  'service-startup': createServiceStartup, 'account-isolation': createAccountIsolation };

// GeniusBar ADR-0046: every seam has a Windows branch, exercised with fake
// runners in tests/platform-win32.test.mjs (secret store, service startup)
// and tests/platform-win32-channel.test.mjs (account isolation, local
// channel). The port check below keeps every macOS operation name on win32.
const implemented = new Set(['secret-store', 'service-startup', 'account-isolation', 'local-channel']);

for (const [name, create] of Object.entries(seams)) {
  test(`${name}: Windows has the same port${implemented.has(name) ? '' : ' and every operation refuses before side effects'}`, () => {
    const mac = create('darwin');
    const windows = create('win32');
    if (implemented.has(name)) {
      for (const key of Object.keys(mac)) assert.equal(typeof windows[key], 'function', `${name} on win32 lacks ${key}`);
      return;
    }
    assert.deepEqual(Object.keys(windows), Object.keys(mac));
    for (const operation of Object.values(windows)) {
      assert.throws(() => operation(), {
        code: 'platform-not-implemented', message: `${name} not implemented on win32`,
      });
    }
  });
}

test('non-seam production source contains no process.platform reference', () => {
  const root = new URL('../', import.meta.url);
  const hits = [];
  for (const dir of ['lib', 'bin']) {
    for (const file of readdirSync(new URL(dir, root), { recursive: true })) {
      if (!file.endsWith('.mjs')) continue;
      if (dir === 'lib' && Object.keys(seams).some((name) => file === path.join('platform', `${name}.mjs`))) continue;
      const source = readFileSync(new URL(`${dir}/${file}`, root), 'utf8');
      if (/process\s*\.\s*platform\b/.test(source)) hits.push(`${dir}/${file}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('macOS secret store preserves security stdin bytes and never puts the secret in argv', () => {
  const calls = [];
  const store = createSecretStore('darwin', { run: (...args) => {
    calls.push(args);
    return { status: 0, stderr: '' };
  } });
  const credential = { principal: 'principal_test', secret: 'private' };
  const host = { credentialName: 'org.example.principal' };
  store.savePrincipalCredential(credential, host, {});
  assert.deepEqual(calls, [['/usr/bin/security', ['-i'], {
    input: `add-generic-password -U -s org.example.principal -a principal -X ${Buffer.from(JSON.stringify(credential)).toString('hex')}\n`,
    encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'],
  }]]);
  store.savePrincipalCredential(credential, host, { AGENT_COMMS_NO_KEYCHAIN: '1' });
  assert.equal(calls.length, 1);
  createSecretStore('linux', { run: () => assert.fail('must skip on Linux') })
    .savePrincipalCredential(credential, host, {});
});

test('macOS secret store preserves failure codes for command and interactive failures', () => {
  for (const result of [{ status: 1, stderr: '' }, { status: 0, stderr: 'failed' }]) {
    const store = createSecretStore('darwin', { run: () => result });
    assert.throws(() => store.savePrincipalCredential({}, { credentialName: 'test' }, {}), {
      code: 'keychain-write-failed',
      message: 'principal saved locally, but could not be saved to the login keychain',
    });
  }
});

test('macOS isolation preserves credential bytes, private modes, and custody errors', () => {
  const isolation = createAccountIsolation('darwin');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-seam-'));
  const paths = { dir, credential: path.join(dir, 'credential.json') };
  try {
    const credential = { account: 'example', secret: 'secret' };
    isolation.saveCredential(paths, credential);
    assert.equal(readFileSync(paths.credential, 'utf8'), `${JSON.stringify(credential, null, 2)}\n`);
    assert.deepEqual(isolation.loadCredential(paths), credential);
    assert.equal(lstatSync(dir).mode & 0o777, 0o700);
    assert.equal(lstatSync(paths.credential).mode & 0o777, 0o600);
    assert.throws(() => isolation.assertOwnedDir(dir, process.getuid() + 1), { code: 'broker-untrusted' });
    assert.throws(() => isolation.assertBindingFile({ isFile: () => true, uid: process.getuid(), mode: 0o644 }, 'binding'), { code: 'binding-untrusted' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compatibility exports retain the channel modes and LaunchAgent bytes', () => {
  const local = createLocalChannel('darwin');
  assert.equal(local.socketModeFor(null), channel.SOCKET_MODE_OWNER);
  assert.equal(local.socketModeFor(123), channel.SOCKET_MODE_GROUP);
  const service = createServiceStartup('darwin');
  const options = { label: 'example', args: ['/node', '/cli', 'broker', 'run'], logDir: '/logs' };
  assert.equal(service.renderPlist(options), startup.renderPlist(options));
  assert.equal(service.installOptions({ mode: 'single-account', uid: 501 }).args[1],
    new URL('../bin/agent-comms.mjs', import.meta.url).pathname);
});
