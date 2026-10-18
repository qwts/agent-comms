// Separate acceptance candidate for the reviewed prebuilt relay. Legacy
// compiler and old/new comparison inputs remain immutable in their own modes.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, realpathSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

export const RELAY_STARTUP_SOURCE = Object.freeze({
  pin: 'ba75753e8e99e7c475baff9bfa139721276b5b06',
  tree: '35ac6cf0306590fa600591aaffcd79cf7f20c428',
  archiveSha256: '91b34843c6a97e100415bdcbf3ebf889e8bf018b3272910255dbfe2e9582c612',
  pipeStageSha256: 'e012c398a9a7ec03332472c45a469e2c635dfe6c6b4236677b8bdaa537058e90',
});

export function verifyRelayStartupSource(tree, archiveSha256) {
  if (tree !== RELAY_STARTUP_SOURCE.tree || archiveSha256 !== RELAY_STARTUP_SOURCE.archiveSha256) {
    throw new Error('candidate-source-mismatch');
  }
  return { ...RELAY_STARTUP_SOURCE };
}

// Install only the two bounded build outputs into the independently approved
// archive. No compiler runs in the disposable account or measured private job.
export async function installRelayArtifact(source, artifactDirectory) {
  assert.equal(readFileSync(path.join(source, 'RELEASE_COMMIT'), 'utf8').trim(), RELAY_STARTUP_SOURCE.pin);
  const destination = path.join(source, 'bin/windows');
  mkdirSync(destination, { recursive: true });
  for (const [name, limit] of [['agent-comms-pipe-relay.exe', 1048576], ['relay-build.json', 1024]]) {
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
