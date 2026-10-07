import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadCredential } from './account-isolation.mjs';
import { fail } from '../errors.mjs';
import { principalFileName } from '../host-config.mjs';
import { clientPaths } from '../paths.mjs';

// macOS implementation. POSIX test runners retain the existing Unix behaviour.
// Select before invoking an operation so win32 never reaches a Unix API.
export function createSecretStore(platform = process.platform, { run = spawnSync } = {}) {
  if (platform === 'win32') return createDpapiStore({ run });
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
      return loadCredential({ ...client, credential: path.join(client.dir, principalFileName(host)) });
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

// Windows (docs/windows.md, the host's ADR-0046 decision 3): the principal is a DPAPI-protected
// file, `principal.<credentialName>.dpapi` in the client state directory, in
// the CurrentUser scope, so only this account on this machine decrypts it.
// Credential Manager is not used because generic credentials roam with a
// Microsoft account and a principal must not leave the machine. The script
// goes to PowerShell on stdin with the secret hex-encoded inside it, for the
// reason the macOS branch feeds `security -i`: argv is visible to every local
// process. Hex also keeps the bytes clear of the console code page both ways.
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'];

export const dpapiFileName = (host) => `principal.${host.credentialName}.dpapi`;

function createDpapiStore({ run }) {
  // One statement per line and a blank line at the end: `-Command -` reads
  // stdin as typed input, so a statement split over lines would not parse
  // and a last line without a newline after it would not run.
  const protectScript = (hex) => [
    '$ErrorActionPreference = \'Stop\'',
    'Add-Type -AssemblyName System.Security',
    `$hex = '${hex}'`,
    '$bytes = [byte[]]::new($hex.Length / 2)',
    'for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }',
    '$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, \'CurrentUser\')',
    '[Console]::Out.Write([Convert]::ToBase64String($protected))',
    '',
    '',
  ].join('\n');

  const unprotectScript = (base64) => [
    '$ErrorActionPreference = \'Stop\'',
    'Add-Type -AssemblyName System.Security',
    `$protected = [Convert]::FromBase64String('${base64}')`,
    '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, \'CurrentUser\')',
    '[Console]::Out.Write([BitConverter]::ToString($bytes).Replace(\'-\', \'\'))',
    '',
    '',
  ].join('\n');

  const powershell = (script) => run('powershell.exe', POWERSHELL_ARGS, {
    input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });

  function savePrincipalCredential(credential, host, env = process.env) {
    if (env.AGENT_COMMS_NO_KEYCHAIN === '1') return;
    const hex = Buffer.from(JSON.stringify(credential)).toString('hex');
    const result = powershell(protectScript(hex));
    // A stopped script exits non-zero; an empty stdout means it wrote nothing
    // worth keeping, and a file holding nothing would read as a bad credential.
    const base64 = result.status === 0 ? String(result.stdout ?? '').trim() : '';
    if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) {
      fail('keychain-write-failed', 'principal saved locally, but could not be saved to the Windows credential store');
    }
    // The profile's own access list is the custody here, so the directory
    // needs no mode: %LOCALAPPDATA% already names only this user.
    const dir = clientPaths(env, host).dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, dpapiFileName(host)), `${base64}\n`);
  }

  function readPrincipalCredential(client, host, env = process.env) {
    if (env.AGENT_COMMS_NO_KEYCHAIN === '1') {
      return loadCredential({ ...client, credential: path.join(client.dir, principalFileName(host)) });
    }
    let base64;
    try {
      base64 = readFileSync(path.join(client.dir, dpapiFileName(host)), 'utf8').trim();
    } catch {
      fail('keychain-read-failed', 'cannot read the principal from the Windows credential store');
    }
    // The file's bytes go inside a quoted string in the script, so anything
    // but base64 is refused before it reaches PowerShell.
    if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) fail('credential-invalid', 'the saved principal credential is invalid');
    const result = powershell(unprotectScript(base64));
    if (result.status !== 0) fail('keychain-read-failed', 'cannot read the principal from the Windows credential store');
    try { return JSON.parse(Buffer.from(String(result.stdout ?? '').trim(), 'hex').toString('utf8')); }
    catch { fail('credential-invalid', 'the saved principal credential is invalid'); }
  }

  return Object.freeze({ savePrincipalCredential, readPrincipalCredential });
}

export const { savePrincipalCredential, readPrincipalCredential } = createSecretStore();
