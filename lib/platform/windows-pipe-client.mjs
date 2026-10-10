import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

const PIPE_PREFIX = '\\\\.\\pipe\\';
const CONNECTED = 'CONNECTED\n';
const REFUSED = 'REFUSED\n';

// Windows PowerShell 5.1 can inherit a PowerShell 7 module path that loads
// incompatible modules. Give only the child a normalized environment.
export function legacyPowerShellEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
}

const worker = String.raw`$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using System.Threading;

public static class AgentCommsPipeClient {
    static void Copy(Stream source, Stream destination) {
        byte[] buffer = new byte[8192];
        int count;
        while ((count = source.Read(buffer, 0, buffer.Length)) != 0) {
            destination.Write(buffer, 0, count);
            destination.Flush();
        }
    }

    public static void Run(string name) {
        NamedPipeClientStream pipe = null;
        try {
            pipe = new NamedPipeClientStream(
                ".", name, PipeDirection.InOut, PipeOptions.None,
                TokenImpersonationLevel.Identification);
            pipe.Connect(10000);
        } catch {
            Console.Error.Write("REFUSED\n");
            Console.Error.Flush();
            return;
        }

        Console.Error.Write("CONNECTED\n");
        Console.Error.Flush();
        Thread input = new Thread(() => {
            try { Copy(Console.OpenStandardInput(), pipe); }
            catch { }
            finally { try { pipe.Dispose(); } catch { } }
        });
        input.IsBackground = true;
        input.Start();
        try { Copy(pipe, Console.OpenStandardOutput()); }
        catch { }
        finally { try { pipe.Dispose(); } catch { } }
    }
}
'@
[void](Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @('System.dll', 'System.Core.dll'))
[AgentCommsPipeClient]::Run($env:AGENT_COMMS_PIPE_NAME)
`;

function refusal() {
  return Object.assign(new Error('named pipe connection failed'), { code: 'ECONNREFUSED' });
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
  const child = spawnProcess('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });

  let ready = false;
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
  child.stdout.on('end', () => raw.push(null));
  child.stderr.on('data', (chunk) => {
    if (ready || closed) return;
    status += chunk.toString('ascii');
    if (status.length > 32) {
      raw.destroy(refusal());
      return;
    }
    if (status === CONNECTED) {
      ready = true;
      clearTimeout(connectTimer);
      raw.emit('connect');
    } else if (status === REFUSED) {
      raw.destroy(refusal());
    } else if (!CONNECTED.startsWith(status) && !REFUSED.startsWith(status)) {
      raw.destroy(refusal());
    }
  });
  child.once('error', () => {
    if (!closed) raw.destroy(refusal());
  });
  child.once('close', () => {
    if (!closed && !ready) raw.destroy(refusal());
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
  connectTimer = setTimeout(() => raw.destroy(refusal()), 10_000);
  connectTimer.unref();
  raw.once('close', () => clearTimeout(connectTimer));
  return raw;
}
