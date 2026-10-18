// Retained public source for historical compiler/argv diagnostics only.
// Its exact digest is checked by deriveCompilerPrefix; current relay has no compiler.
import { readFileSync } from 'node:fs';
import { deriveCompilerPrefix } from '../../tools/acceptance/windows-capacity-compiler.mjs';

export function legacyCompilerArgs() {
  const worker = readFileSync(new URL('../fixtures/windows-legacy-compiler-worker.ps1', import.meta.url), 'utf8');
  const encoded = Buffer.from(worker, 'utf16le').toString('base64');
  const command = `$ProgressPreference = 'SilentlyContinue'; & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))`;
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', command];
}

export const legacyCompilerPrefix = () => deriveCompilerPrefix('powershell.exe', legacyCompilerArgs());
