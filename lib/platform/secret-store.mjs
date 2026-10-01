import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadCredential } from './account-isolation.mjs';
import { fail } from '../errors.mjs';

// macOS implementation. POSIX test runners retain the existing Unix behaviour.
// Select before invoking an operation so win32 never reaches a Unix API.
export function createSecretStore(platform = process.platform, { run = spawnSync } = {}) {
  if (platform === 'win32') {
    const unavailable = () => fail('platform-not-implemented', 'secret-store not implemented on win32');
    return Object.freeze(Object.fromEntries(['savePrincipalCredential', 'readPrincipalCredential'].map((name) => [name, unavailable])));
  }
  // A principal client reads the principal from the login keychain under this service and
  // account. The command goes to `security -i` on stdin, hex-encoded, because
  // argv is visible to every local user through ps.
  function saveToKeychain(credential, host) {
    const hex = Buffer.from(JSON.stringify(credential)).toString('hex');
    const result = run('/usr/bin/security', ['-i'], {
      input: `add-generic-password -U -s ${host.credentialName} -a principal -X ${hex}\n`,
      encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'],
    });
    // security -i exits 0 even when a command fails, so stderr is the signal.
    if (result.status !== 0 || result.stderr.trim()) {
      fail('keychain-write-failed', 'principal saved locally, but could not be saved to the login keychain');
    }
  }

  function savePrincipalCredential(credential, host, env = process.env) {
    if (platform === 'darwin' && env.AGENT_COMMS_NO_KEYCHAIN !== '1') saveToKeychain(credential, host);
  }

  function readPrincipalCredential(client, host, env = process.env) {
    if (platform !== 'darwin' || env.AGENT_COMMS_NO_KEYCHAIN === '1') {
      return loadCredential({ ...client, credential: path.join(client.dir, 'principal.json') });
    }
    const result = run('/usr/bin/security', ['find-generic-password', '-s', host.credentialName, '-a', 'principal', '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) fail('keychain-read-failed', 'cannot read the principal from the login keychain');
    try { return JSON.parse(result.stdout.trim()); }
    catch { fail('credential-invalid', 'the saved principal credential is invalid'); }
  }

  return Object.freeze({ savePrincipalCredential, readPrincipalCredential });
}

export const { savePrincipalCredential, readPrincipalCredential } = createSecretStore();
