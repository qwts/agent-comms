import { spawnSync } from 'node:child_process';
import { fail } from '../errors.mjs';

// macOS implementation. POSIX test runners retain the existing Unix behaviour.
// Select before invoking an operation so win32 never reaches a Unix API.
export function createSecretStore(platform = process.platform, { run = spawnSync } = {}) {
  if (platform === 'win32') {
    const unavailable = () => fail('platform-not-implemented', 'secret-store not implemented on win32');
    return Object.freeze(Object.fromEntries(['savePrincipalCredential'].map((name) => [name, unavailable])));
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

  return Object.freeze({ savePrincipalCredential });
}

export const { savePrincipalCredential } = createSecretStore();
