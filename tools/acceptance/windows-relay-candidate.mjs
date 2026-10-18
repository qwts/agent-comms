// Separate acceptance candidate for the fixed prebuilt relay. Legacy
// compiler and old/new comparison inputs remain immutable in their own modes.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, realpathSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

export const RELAY_STARTUP_SOURCE = Object.freeze({
  pin: '260d5dbbd7a27c2b044b3497757ee9b73e649c53',
  tree: '530018f0aca82b0a51f8cf6c86717c20eb83d481',
  archiveSha256: 'eb2186494f19516c5e878043d714a60f0bd7da7985bb41aee46e66a6f1835694',
  pipeStageSha256: 'e012c398a9a7ec03332472c45a469e2c635dfe6c6b4236677b8bdaa537058e90',
});

export function verifyRelayStartupSource(tree, archiveSha256) {
  if (tree !== RELAY_STARTUP_SOURCE.tree || archiveSha256 !== RELAY_STARTUP_SOURCE.archiveSha256) {
    throw new Error('candidate-source-mismatch');
  }
  return { ...RELAY_STARTUP_SOURCE };
}

// Match verifyWindowsRelay's production ceilings exactly. This fixed-source
// diagnostic must refuse any artifact the shipped runtime would refuse, even
// if its digest matches. A larger product requires a reviewed runtime change.
const RELAY_BINARY_MAX_BYTES = 1048576;
const RELAY_MANIFEST_MAX_BYTES = 1024;

// Install only the two bounded build outputs into the independently approved
// archive. No compiler runs in the disposable account or measured private job.
export async function installRelayArtifact(source, artifactDirectory) {
  assert.equal(readFileSync(path.join(source, 'RELEASE_COMMIT'), 'utf8').trim(), RELAY_STARTUP_SOURCE.pin);
  const destination = path.join(source, 'bin/windows');
  mkdirSync(destination, { recursive: true });
  for (const [name, limit] of [['agent-comms-pipe-relay.exe', RELAY_BINARY_MAX_BYTES], ['relay-build.json', RELAY_MANIFEST_MAX_BYTES]]) {
    const file = path.join(artifactDirectory, name);
    const stat = statSync(file);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= limit);
    copyFileSync(file, path.join(destination, name));
  }
  return (await verifiedRelayContract(source)).artifact;
}

// Capture the actual public connector contract with inert streams. Verification
// stays enabled; this never launches a process or connects to a named pipe.
export async function verifiedRelayContract(source) {
  source = realpathSync(source);
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(),
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: 0, signalCode: null });
  let raw, captured;
  try {
    const { connectWindowsPipe } = await import(pathToFileURL(path.join(source, 'lib/platform/windows-pipe-client.mjs')));
    raw = connectWindowsPipe('\\\\.\\pipe\\agent-comms-acceptance-contract', {
      env: {},
      spawnProcess(file, args, options) {
        assert.equal(captured, undefined);
        assert.equal(options.windowsHide, true);
        assert.equal(options.detached, false);
        assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
        assert.deepEqual(args, []);
        assert.equal(file, path.join(source, 'bin/windows/agent-comms-pipe-relay.exe'));
        captured = { shellExecutable: realpathSync(file), relayArgs: [...args] };
        return child;
      },
    });
    assert.ok(captured);
    const artifact = JSON.parse(readFileSync(path.join(source, 'bin/windows/relay-build.json'), 'utf8'));
    assert.equal(artifact.sourceCommit, RELAY_STARTUP_SOURCE.pin);
    return { ...captured,
      diagnosticArgs: ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(path.join(source, 'lib/diagnostic-writer.mjs')).href)}).catch(() => process.exit(0));`],
      artifact: { sourceCommit: artifact.sourceCommit, sourceSha256: artifact.sourceSha256,
        binarySha256: artifact.binarySha256, subsystem: artifact.subsystem },
    };
  } catch {
    throw new Error('candidate-source-mismatch');
  } finally {
    raw?.destroy();
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
  }
}
