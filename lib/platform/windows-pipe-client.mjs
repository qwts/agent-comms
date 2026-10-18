import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { windowsPowershellEnvironment } from './windows-environment.mjs';
import { preserveWindowsPipeStage } from './windows-pipe-stage.mjs';

const PIPE_PREFIX = '\\\\.\\pipe\\';
const CONNECTED = 'CONNECTED\n';
const REFUSED = 'REFUSED\n';

// Windows PowerShell 5.1 can inherit a PowerShell 7 module path that loads
// incompatible modules. Give only the child a normalized environment.
export const legacyPowerShellEnv = windowsPowershellEnvironment;

const worker = String.raw`$ErrorActionPreference = 'Stop'
$pipe = $null
try {
    $pipe = [IO.Pipes.NamedPipeClientStream]::new(
        '.', $env:AGENT_COMMS_PIPE_NAME, [IO.Pipes.PipeDirection]::InOut,
        [IO.Pipes.PipeOptions]::Asynchronous,
        [Security.Principal.TokenImpersonationLevel]::Identification)
    $pipe.Connect(10000)
} catch {
    [Console]::Error.Write('REFUSED' + [char]10)
    [Console]::Error.Flush()
    if ($null -ne $pipe) { $pipe.Dispose() }
    return
}
[Console]::Error.Write('CONNECTED' + [char]10)
[Console]::Error.Flush()
try {
    # These .NET tasks run without PowerShell script delegates or a compiler.
    # Console streams and byte-mode named pipes write directly; no text codec.
    $inputCopy = [Console]::OpenStandardInput().CopyToAsync($pipe, 8192)
    $outputCopy = $pipe.CopyToAsync([Console]::OpenStandardOutput(), 8192)
    [void][Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($inputCopy, $outputCopy))
    if ($inputCopy.IsCompleted) { $null = $inputCopy.Exception }
    if ($outputCopy.IsCompleted) { $null = $outputCopy.Exception }
} catch {
} finally {
    # Either EOF ends this owned relay, matching the former background pump.
    # Do not wait for a second read that may still be blocked on the other end.
    $pipe.Dispose()
}
`;

function refusal(stage = null) {
  const error = Object.assign(new Error('named pipe connection failed'), { code: 'ECONNREFUSED' });
  return preserveWindowsPipeStage(error, { windowsPipeStage: stage });
}

// Node/libuv opens named pipes without SECURITY_SQOS_PRESENT. This connector
// delegates only the pipe handle to .NET, whose client constructor applies an
// explicit Identification ceiling before the hello can be written.
export function connectWindowsPipe(pipe, { spawnProcess = spawn, env = process.env } = {}) {
  if (typeof pipe !== 'string' || !pipe.startsWith(PIPE_PREFIX) || pipe.length === PIPE_PREFIX.length) {
    throw new TypeError('invalid Windows named pipe');
  }
  const name = pipe.slice(PIPE_PREFIX.length);
  const encoded = Buffer.from(worker, 'utf16le').toString('base64');
  const childEnv = legacyPowerShellEnv(env);
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === 'agent_comms_pipe_name') delete childEnv[key];
  }
  childEnv.AGENT_COMMS_PIPE_NAME = name;
  // Avoid -EncodedCommand's redirected CLIXML host output before readiness.
  // This fixed expression decodes only our public script; stdin stays binary.
  const command = `$ProgressPreference = 'SilentlyContinue'; & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))`;
  // PowerShell exits before executing the worker under DETACHED_PROCESS.
  // Keep the owned relay hidden with redirected handles, but never detached.
  const child = spawnProcess('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', command,
  ], { windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });

  let ready = false;
  let outputEnded = false;
  let status = '';
  let closed = false;
  let connectTimer;
  const raw = new Duplex({
    allowHalfOpen: false,
    read() { child.stdout.resume(); },
    write(chunk, encoding, callback) {
      if (child.stdin.destroyed || !child.stdin.writable) {
        callback(refusal());
        return;
      }
      child.stdin.write(chunk, encoding, callback);
    },
    final(callback) {
      child.stdin.end(callback);
    },
    destroy(error, callback) {
      closed = true;
      clearTimeout(connectTimer);
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        if (!stream.destroyed) stream.destroy();
      }
      if (child.exitCode === null && child.signalCode === null) child.kill();
      callback(error);
    },
  });

  child.stdout.on('data', (chunk) => {
    if (!raw.push(chunk)) child.stdout.pause();
  });
  child.stdout.on('end', () => {
    outputEnded = true;
    // stdout and stderr drain independently. Keep the bridge alive until the
    // readiness marker can drain, or child close/startup timeout refuses it.
    // Publishing EOF early auto-destroys the Duplex and hides that refusal.
    if (ready && !closed) raw.push(null);
  });
  child.stderr.on('data', (chunk) => {
    if (ready || closed) return;
    status += chunk.toString('utf8');
    if (status.length > 32) {
      raw.destroy(refusal(status.startsWith('#< CLIXML') ? 'host-clixml' : 'host-stderr'));
      return;
    }
    if (status === CONNECTED) {
      ready = true;
      clearTimeout(connectTimer);
      raw.emit('connect');
      if (outputEnded && !closed) raw.push(null);
    } else if (status === REFUSED) {
      raw.destroy(refusal('pipe-refused'));
    } else if (!CONNECTED.startsWith(status) && !REFUSED.startsWith(status)) {
      raw.destroy(refusal(status.startsWith('#< CLIXML') ? 'host-clixml' : 'host-stderr'));
    }
  });
  child.once('error', () => {
    if (!closed) raw.destroy(refusal('process-error'));
  });
  child.once('close', () => {
    if (!closed && !ready) raw.destroy(refusal('premature-close'));
  });
  child.stdout.on('error', () => {
    if (!closed) raw.destroy(refusal());
  });
  child.stderr.on('error', () => {
    if (!closed && !ready) raw.destroy(refusal());
  });
  child.stdin.on('error', () => {
    if (!closed) raw.destroy(refusal());
  });
  connectTimer = setTimeout(() => raw.destroy(refusal('startup-timeout')), 10_000);
  connectTimer.unref();
  raw.once('close', () => clearTimeout(connectTimer));
  return raw;
}
