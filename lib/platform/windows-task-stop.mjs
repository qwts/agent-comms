import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createAccountIsolation } from './account-isolation.mjs';
import { windowsPowershellEnvironment } from './windows-environment.mjs';
import { fail } from '../errors.mjs';

const literal = value => `'${String(value).replaceAll("'", "''")}'`;

// Accept Windows argv quoting used by renderTask, without interpreting shell text.
export const BROKER_COMMAND_PATTERN = String.raw`(?:^|\s)(?:"[^"\r\n]*[\\/]agent-comms\.mjs"|[^\s"\r\n]*[\\/]agent-comms\.mjs)\s+(?:"broker"|broker)\s+(?:"run"|run)(?=\s|$)`;
export const isBrokerCommandLine = text => new RegExp(BROKER_COMMAND_PATTERN).test(text);

// Retain a process handle before stopping the task. HasExited then refers to
// that process instance even if Windows reuses its PID during the wait.
export function windowsTaskStopScript(label, oldPid, timeoutMs) {
  if (/[\r\n\0]/.test(label)) fail('usage', 'invalid scheduled task label');
  return `$ErrorActionPreference='Stop'
$deadline=[DateTime]::UtcNow.AddMilliseconds(${timeoutMs})
$s=New-Object -ComObject Schedule.Service
$s.Connect()
$ownerSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Read-Task {
  try {
    $task=$s.GetFolder('\\').GetTask(${literal(label)})
    $user=$task.Definition.Principal.UserId
    $taskSid=if ($user -match '^S-1-') { $user } else { (New-Object System.Security.Principal.NTAccount($user)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
    if ($taskSid -ne $ownerSid) { throw 'scheduled broker task belongs to another account' }
    return $task
  }
  catch { if ($_.Exception.HResult -eq -2147024894) { return $null }; throw }
}
$t=Read-Task
$p=$null
try {
  if (${oldPid === null ? '$false' : '$true'}) {
    try { $p=[System.Diagnostics.Process]::GetProcessById(${oldPid ?? 0}); $null=$p.Handle; $started=$p.StartTime }
    catch [System.ArgumentException] { $p=$null }
    if ($p -and !$p.HasExited) {
      $image=$p.MainModule.FileName
      $row=Get-CimInstance Win32_Process -Filter "ProcessId=${oldPid ?? 0}"
      if (!$row -or [System.IO.Path]::GetFileName($image) -ine 'node.exe' -or $row.CommandLine -notmatch ${literal(BROKER_COMMAND_PATTERN)}) { throw 'previous broker process identity could not be verified' }
      $processOwner=Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid
      if ($processOwner.ReturnValue -ne 0 -or $processOwner.Sid -ne $ownerSid) { throw 'previous broker process belongs to another account' }
      if ([Math]::Abs(($row.CreationDate.ToUniversalTime() - $started.ToUniversalTime()).TotalMilliseconds) -gt 1) { throw 'previous broker PID was reused' }
      if ($p.StartTime -ne $started) { throw 'previous broker process identity changed' }
    }
  }
  if ($t -and [int]$t.State -eq 4 -and (!$p -or $p.HasExited)) { throw 'running broker task has no verifiable broker lock process' }
  if ($t -and [int]$t.State -eq 4) { $t.Stop(0) }
  while ($true) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'scheduled broker stop timed out' }
    $t=Read-Task
    $state=if ($t) { [int]$t.State } else { -1 }
    if ($state -lt -1 -or $state -gt 4 -or $state -eq 0) { throw 'scheduled broker task state is unknown' }
    if (($state -eq -1 -or $state -eq 1 -or $state -eq 3) -and (!$p -or $p.HasExited)) { break }
    Start-Sleep -Milliseconds 100
  }
  [Console]::Out.WriteLine('stopped')
} finally { if ($p) { $p.Dispose() } }
`;
}

export function stopWindowsBrokerTask({ label, state, env = process.env, timeoutMs = 30000,
  exec = execFileSync, isolation, run = spawnSync, now = Date.now }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('usage', 'invalid scheduled broker stop deadline');
  const deadline = now() + timeoutMs;
  const remaining = () => {
    const value = deadline - now();
    if (value <= 0) fail('launchagent-unload-failed', 'scheduled broker stop deadline expired');
    return value;
  };
  // Custody uses the existing SID/real-object checks, with this operation's
  // deadline applied to every whoami/Get-Acl child before the stop helper.
  isolation ??= createAccountIsolation('win32', { env, run: (command, args, options) => run(command, args, { ...options, timeout: remaining() }) });
  const lock = path.join(state, 'broker.lock');
  let oldPid = null;
  if (existsSync(state)) isolation.assertOwnedDir(state, isolation.currentUid(), { code: 'state-dir-untrusted' });
  if (existsSync(lock)) {
    isolation.assertLogFile(lock, isolation.currentUid());
    const info = lstatSync(lock);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32) fail('state-dir-untrusted', 'broker lock is not a regular file');
    const text = readFileSync(lock, 'utf8');
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) fail('state-dir-untrusted', 'broker lock has an invalid process ID');
    oldPid = Number(text);
  }
  const helperMs = remaining();
  const script = windowsTaskStopScript(label, oldPid, helperMs);
  let output;
  try {
    output = exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: windowsPowershellEnvironment(env), timeout: remaining(),
    });
  } catch { fail('launchagent-unload-failed', 'could not prove scheduled broker termination; task and process queries must succeed before replacement'); }
  remaining();
  if (String(output).trim() !== 'stopped') fail('launchagent-unload-failed', 'scheduled broker termination returned an invalid result');
}
