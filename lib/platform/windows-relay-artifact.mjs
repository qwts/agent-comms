import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELAY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const relayPath = (root = RELAY_ROOT) => path.join(root, 'bin', 'windows', 'agent-comms-pipe-relay.exe');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Fail closed on a missing, stale, corrupted, or console-subsystem build.
export function verifyWindowsRelay(root = RELAY_ROOT) {
  const file = relayPath(root);
  const metadata = readFileSync(path.join(root, 'bin', 'windows', 'relay-build.json'));
  if (metadata.length > 1024) throw new Error('relay-artifact-invalid');
  const manifest = JSON.parse(metadata.toString('utf8'));
  const keys = Object.keys(manifest).sort().join(',');
  if (keys !== 'binarySha256,format,sourceCommit,sourceSha256,subsystem' || manifest.format !== 1
      || !['sourceCommit', 'sourceSha256', 'binarySha256'].every(key => typeof manifest[key] === 'string')
      || manifest.subsystem !== 'windows' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(manifest.sourceCommit)
      || !/^[0-9a-f]{64}$/.test(manifest.sourceSha256) || !/^[0-9a-f]{64}$/.test(manifest.binarySha256)) throw new Error('relay-artifact-invalid');
  const binary = readFileSync(file);
  if (binary.length > 1048576 || digest(binary) !== manifest.binarySha256
      || digest(readFileSync(path.join(root, 'native', 'windows', 'AgentCommsPipeRelay.cs'))) !== manifest.sourceSha256) throw new Error('relay-artifact-invalid');
  if (binary.length < 64 || binary.toString('ascii', 0, 2) !== 'MZ') throw new Error('relay-artifact-invalid');
  const pe = binary.readUInt32LE(0x3c);
  if (pe > binary.length - 94 || binary.toString('ascii', pe, pe + 4) !== 'PE\u0000\u0000'
      || ![0x10b, 0x20b].includes(binary.readUInt16LE(pe + 24))
      || binary.readUInt16LE(pe + 24 + 68) !== 2) throw new Error('relay-artifact-invalid');
  const stamp = path.join(root, 'RELEASE_COMMIT');
  if (existsSync(stamp)) {
    const commit = readFileSync(stamp, 'utf8').trim();
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) && commit !== manifest.sourceCommit) throw new Error('relay-artifact-invalid');
  }
  return file;
}
