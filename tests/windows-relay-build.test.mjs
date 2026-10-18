import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyWindowsRelay } from '../lib/platform/windows-relay-artifact.mjs';
import { legacyPowerShellEnv } from '../lib/platform/windows-pipe-client.mjs';

test('Windows relay build falls back to Framework and refuses when both fixed compilers are absent', {
  skip: process.platform !== 'win32', timeout: 30000,
}, t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'relay-build-fallback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'native', 'windows'), { recursive: true });
  copyFileSync(new URL('../scripts/build-windows-relay.ps1', import.meta.url), path.join(root, 'scripts', 'build-windows-relay.ps1'));
  copyFileSync(new URL('../native/windows/AgentCommsPipeRelay.cs', import.meta.url), path.join(root, 'native', 'windows', 'AgentCommsPipeRelay.cs'));
  writeFileSync(path.join(root, 'RELEASE_COMMIT'), 'a'.repeat(40));
  // Hide only the fixed compiler paths from the builder's existence probe.
  // The fallback must really compile and pass the runtime artifact verifier.
  const command = String.raw`
$ErrorActionPreference = 'Stop'
function Test-Path {
    param([string]$Path, [string]$PathType)
    $fixed = @('Framework64','Framework') | ForEach-Object { Join-Path $env:WINDIR "Microsoft.NET/$_/v4.0.30319/csc.exe" }
    if ($Path -eq $fixed[0] -or ($env:AGENT_COMMS_TEST_NO_COMPILER -eq '1' -and $Path -eq $fixed[1])) { return $false }
    if ($PathType) { return Microsoft.PowerShell.Management\Test-Path -LiteralPath $Path -PathType $PathType }
    return Microsoft.PowerShell.Management\Test-Path -LiteralPath $Path
}
try {
    & (Join-Path $env:AGENT_COMMS_RELAY_BUILD_TEST_ROOT 'scripts/build-windows-relay.ps1')
    if ($env:AGENT_COMMS_TEST_NO_COMPILER -eq '1') { exit 2 }
} catch {
    if ($env:AGENT_COMMS_TEST_NO_COMPILER -ne '1' -or $_.Exception.Message -ne 'Windows .NET Framework compiler unavailable') {
        # This isolated build contains only public source and a synthetic release stamp.
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 3
    }
}
exit 0`;
  for (const absent of [false, true]) {
    rmSync(path.join(root, 'bin'), { recursive: true, force: true });
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      env: legacyPowerShellEnv({ ...process.env, AGENT_COMMS_RELAY_BUILD_TEST_ROOT: root, AGENT_COMMS_TEST_NO_COMPILER: absent ? '1' : '0' }),
      windowsHide: true, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined, 'build probe spawn failed');
    assert.equal(result.status, 0, `build probe refused (${absent ? 'no compiler' : 'Framework fallback'}): ${result.stderr.slice(0, 2000)}`);
    if (absent) assert.equal(existsSync(path.join(root, 'bin')), false);
    else assert.equal(verifyWindowsRelay(root), path.join(root, 'bin', 'windows', 'agent-comms-pipe-relay.exe'));
  }
});
