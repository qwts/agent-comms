import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createLocalChannel, pipeNameFor } from '../lib/platform/local-channel.mjs';
import { PROTOCOL_VERSION, lineReader, writeLine } from '../lib/wire.mjs';
import { legacyPowerShellEnv } from '../lib/platform/windows-pipe-client.mjs';

const SID = 'S-1-5-21-100-200-300-1001';
const LABEL = 'agent-comms.native-test';
const pipeServer = String.raw`$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using System.Text;

public static class AgentCommsPipeImpersonationProbe {
    public static void Run(string name) {
        for (int index = 1; index <= 2; index++) {
            using (var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous)) {
                if (index == 1) {
                    Console.WriteLine("READY");
                    Console.Out.Flush();
                }
                server.WaitForConnection();
                var encoding = new UTF8Encoding(false);
                string hello;
                using (var reader = new StreamReader(server, encoding, false, 1024, true)) {
                    hello = reader.ReadLine();
                }
                if (hello == null) throw new InvalidOperationException();
                string level = null;
                server.RunAsClient(delegate {
                    using (var identity = WindowsIdentity.GetCurrent()) {
                        level = identity.ImpersonationLevel.ToString();
                    }
                });
                Console.WriteLine("OBSERVED" + index + ":" + level + ":" + Convert.ToBase64String(encoding.GetBytes(hello)));
                Console.Out.Flush();
                string answer = Console.ReadLine();
                if (answer == null) throw new InvalidOperationException();
                using (var writer = new StreamWriter(server, encoding, 1024, true)) {
                    writer.AutoFlush = true;
                    writer.WriteLine(answer);
                }
                string request;
                using (var reader = new StreamReader(server, encoding, false, 1024, true)) {
                    request = reader.ReadLine();
                }
                if (index == 1 && request != null) {
                    using (var writer = new StreamWriter(server, encoding, 1024, true)) {
                        writer.AutoFlush = true;
                        writer.WriteLine("{\"ok\":true,\"pong\":true}");
                    }
                }
                Console.WriteLine("RESULT" + index + ":" + level + ":" + (request == null ? "NO_REQUEST" : "REQUEST"));
                Console.Out.Flush();
            }
        }
    }
}
'@
[void](Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @('System.dll', 'System.Core.dll'))
[AgentCommsPipeImpersonationProbe]::Run($env:AGENT_COMMS_TEST_PIPE)
`;

function within(promise, label, timeoutMs = 15_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function nextLine(output, label) {
  const result = await within(output.next(), label);
  assert.equal(result.done, false, `${label}: fixture closed early`);
  return result.value;
}

function exchange(socket, body) {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => writeLine(socket, { v: PROTOCOL_VERSION, ...body }));
    socket.once('error', reject);
    lineReader(socket, resolve, reject);
  });
}

test('native Windows client limits server impersonation before broker proof and gates queued request bytes', {
  skip: process.platform !== 'win32',
  timeout: 60_000,
}, async (t) => {
  const label = `${LABEL}.${process.pid}.${randomBytes(6).toString('hex')}`;
  const file = path.join(os.tmpdir(), 'broker.sock');
  const pipe = pipeNameFor(file, { label, sid: SID });
  const pipeName = pipe.split('\\').pop();
  const server = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(pipeServer, 'utf16le').toString('base64'),
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: legacyPowerShellEnv({ ...process.env, AGENT_COMMS_TEST_PIPE: pipeName }),
  });
  const serverClosed = once(server, 'close');
  serverClosed.catch(() => {});
  const lines = createInterface({ input: server.stdout });
  const output = lines[Symbol.asyncIterator]();
  server.stderr.resume();
  const channels = [];
  t.after(async () => {
    for (const channel of channels) channel.destroy();
    lines.close();
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await within(serverClosed, 'fixture process exit', 5_000);
  });

  assert.equal(await nextLine(output, 'pipe server startup'), 'READY');

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const brokerKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const channel = createLocalChannel('win32', {
    label,
    isolation: { currentUid: () => SID },
  });

  const accepted = channel.connect(file, { brokerKey });
  channels.push(accepted);
  const acceptedEof = within(once(accepted, 'end'), 'native pipe EOF');
  const acceptedReply = within(exchange(accepted, { op: 'ping' }), 'native request/reply');
  acceptedEof.catch(() => {});
  acceptedReply.catch(() => {});
  const hello1 = await nextLine(output, 'first client hello');
  assert.match(hello1, /^OBSERVED1:Identification:/);
  const firstHello = JSON.parse(Buffer.from(hello1.slice('OBSERVED1:Identification:'.length), 'base64').toString('utf8'));
  assert.equal(firstHello.v, PROTOCOL_VERSION);
  assert.match(firstHello.hello, /^[0-9a-f]{64}$/);
  const transcript = Buffer.from(`agent-comms broker handshake v1\n${pipe}\n${firstHello.hello}\n`, 'utf8');
  server.stdin.write(`${JSON.stringify({ v: PROTOCOL_VERSION, proof: sign(null, transcript, privateKey).toString('base64') })}\n`);
  assert.deepEqual(await acceptedReply, { ok: true, pong: true });
  await acceptedEof;
  assert.equal(await nextLine(output, 'first request receipt'), 'RESULT1:Identification:REQUEST');

  const rejected = channel.connect(file, { brokerKey });
  channels.push(rejected);
  const refused = within(once(rejected, 'error'), 'invalid broker proof refusal');
  refused.catch(() => {});
  rejected.write(Buffer.from('{"v":1,"op":"ping","auth":{"secret":"must-not-arrive"}}\n'));
  const hello2 = await nextLine(output, 'second client hello');
  assert.match(hello2, /^OBSERVED2:Identification:/);
  const secondHello = JSON.parse(Buffer.from(hello2.slice('OBSERVED2:Identification:'.length), 'base64').toString('utf8'));
  assert.equal(secondHello.v, PROTOCOL_VERSION);
  server.stdin.write(`${JSON.stringify({ v: PROTOCOL_VERSION, proof: 'AAAA' })}\n`);
  const [error] = await refused;
  assert.equal(error.code, 'broker-untrusted');
  assert.equal(await nextLine(output, 'request withholding result'), 'RESULT2:Identification:NO_REQUEST');
  await within(serverClosed, 'fixture process completion', 5_000);
});
