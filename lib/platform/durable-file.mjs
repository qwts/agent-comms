// Replace a fully written, fsynced, closed sibling file. The caller keeps one
// writer and treats any failure as uncertain until recovery reopens the path.
import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { windowsPowershellEnvironment } from './windows-environment.mjs';
import { verifyWindowsRelay } from './windows-relay-artifact.mjs';

const WINDOWS_REPLACE = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CommsDurableMove {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool MoveFileExW(string source, string destination, uint flags);
}
'@
  if (-not [CommsDurableMove]::MoveFileExW($env:AGENT_COMMS_REPLACE_SOURCE, $env:AGENT_COMMS_REPLACE_DESTINATION, 9)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "durable replacement failed (Windows error $code)"
  }
  [Console]::Out.Write('replaced')
} catch {
  [Console]::Error.Write('durable replacement failed')
  exit 1
}
`;

export function durableReplace(source, destination, {
  platform = process.platform, io = fs, run = spawnSync, fault = () => {},
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path;
  if (typeof source !== 'string' || typeof destination !== 'string'
      || source.includes('\0') || destination.includes('\0')
      || !paths.isAbsolute(source) || !paths.isAbsolute(destination)
      || paths.resolve(source) === paths.resolve(destination)
      || paths.dirname(paths.resolve(source)) !== paths.dirname(paths.resolve(destination))) {
    throw new Error('durable replacement requires distinct absolute sibling paths');
  }
  if (platform === 'win32') {
    // MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH, without COPY_ALLOWED.
    // Paths are child environment data, never interpolated PowerShell source.
    // https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw
    const native = run === spawnSync;
    const result = run(native ? verifyWindowsRelay() : 'powershell.exe', native ? ['--replace'] : [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(WINDOWS_REPLACE, 'utf16le').toString('base64'),
    ], {
      env: { ...windowsPowershellEnvironment(), AGENT_COMMS_REPLACE_SOURCE: paths.toNamespacedPath(source),
        AGENT_COMMS_REPLACE_DESTINATION: paths.toNamespacedPath(destination) },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      timeout: 30_000, maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0 || result.stdout?.trim() !== 'replaced') {
      // A timeout may follow a successful move. Never retry or report success;
      // the log owner poisons its writer and recovers from the authoritative path.
      throw new Error('durable Windows file replacement failed; restart and recover before writing');
    }
    fault('after-replace');
    return;
  }
  io.renameSync(source, destination);
  fault('after-replace');
  fault('before-directory-fsync');
  const directory = io.openSync(paths.dirname(destination), 'r');
  try { io.fsyncSync(directory); } finally { io.closeSync(directory); }
  fault('after-directory-fsync');
}
