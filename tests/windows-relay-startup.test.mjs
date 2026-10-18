import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { legacyPowerShellEnv } from '../lib/platform/windows-pipe-client.mjs';

const marker = 'RELAY_STARTUP_OK\n';
const scripts = {
  command: '[Console]::Error.Write("RELAY_STARTUP_OK`n"); [Console]::Error.Flush()',
  compiled: String.raw`$source = @'
using System;
public static class RelayStartupProbe {
    public static void Run() { Console.Error.Write("RELAY_STARTUP_OK\n"); Console.Error.Flush(); }
}
'@
[void](Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @('System.dll', 'System.Core.dll'))
[RelayStartupProbe]::Run()`,
};

test('Windows PowerShell starts hidden and rejects DETACHED_PROCESS before executing the relay wrapper', {
  skip: process.platform !== 'win32', timeout: 60000,
}, async t => {
  for (const [stage, script] of Object.entries(scripts)) {
    for (const detached of [false, true]) {
      await t.test(`${stage}/${detached ? 'detached' : 'hidden'}`, async () => {
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const command = `$ProgressPreference = 'SilentlyContinue'; & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))`;
        const child = spawn('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', command,
        ], { windowsHide: true, detached, stdio: ['pipe', 'pipe', 'pipe'], env: legacyPowerShellEnv(process.env) });
        let stdoutBytes = 0, stderr = '', timedOut = false, spawnFailed = false;
        child.stdout?.on('data', chunk => { stdoutBytes += chunk.length; });
        child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(0, 256); });
        child.once('error', () => { spawnFailed = true; });
        let closeTimer;
        const timer = setTimeout(() => { timedOut = true; if (child.pid) child.kill(); }, 12000);
        let result;
        try {
          result = await Promise.race([
            new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))),
            new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('startup-close-unconfirmed')), 17000); }),
          ]);
        } finally {
          clearTimeout(timer);
          clearTimeout(closeTimer);
          for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
          if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
        }
        assert.equal(timedOut, false, 'startup deadline');
        assert.equal(spawnFailed, false, 'spawn refused');
        assert.equal(result.code, 0, 'PowerShell exit code');
        assert.equal(result.signal, null, 'PowerShell termination');
        assert.equal(stdoutBytes, 0, 'unexpected stdout');
        if (detached) {
          assert.equal(stderr.length, 0, 'unsupported detached host must match the silent exit regression');
        } else {
          assert.equal(stderr === marker, true, 'startup marker absent or unexpected stderr');
        }
      });
    }
  }
});
