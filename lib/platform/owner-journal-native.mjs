// Disabled fixed-descriptor bridge. Fixed adjacent build-time artifacts only;
// no route, environment/PATH lookup, caller path or runtime compiler fallback.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertAncestors } from '../custody.mjs';
const root = fileURLToPath(new URL('./native/', import.meta.url));
const fixed = Object.freeze(['acceptance','original-action','prepared-challenge','presence','receipt','authorization','release',
  'initial-outcome','observation-reference','terminal-reference','scratch']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const integer = v => Number.isSafeInteger(v) && v >= 0;
const matches = (re, v) => typeof v === 'string' && re.exec(v)?.[0] === v;
const fail = (diagnostic) => {
  const error = new Error('owner-journal-native-unavailable');
  if (diagnostic) error.diagnostic = Object.freeze(diagnostic);
  throw error;
};
function read(name, cap, executable = false) {
  assertAncestors(name, process.getuid());
  const before = fs.lstatSync(name);
  if (!before.isFile() || before.isSymbolicLink() || (before.uid !== process.getuid() && before.uid !== 0) || before.nlink !== 1
      || (before.mode & 0o7022) !== 0 || (executable && (before.mode & 0o111) === 0) || before.size < 1 || before.size > cap) fail();
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail();
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!integer(count) || count === 0 || count > bytes.length - offset) fail(); offset += count; }
    const after = fs.fstatSync(fd);
    if (['dev','ino','size','mode','uid','nlink','mtimeMs','ctimeMs'].some(k => after[k] !== before[k])) fail();
    return { bytes, identity: before };
  } finally { fs.closeSync(fd); }
}
function artifact() {
  const binary = path.join(root, `owner-journal-darwin-helper-${process.arch}`);
  const manifestFile = read(path.join(root, `owner-journal-darwin-helper-${process.arch}.json`), 4096);
  const manifest = JSON.parse(manifestFile.bytes);
  const fields = ['v','platform','architecture','minimumMacOS','sourceSha256','binarySha256','compiler','sdk'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || Object.keys(manifest).length !== fields.length || fields.some(k => !Object.hasOwn(manifest,k))
      || manifest.v !== 1 || manifest.platform !== 'darwin' || manifest.architecture !== process.arch || manifest.minimumMacOS !== '13.0'
      || !['arm64','x64'].includes(process.arch)
      || !matches(/^[a-f0-9]{64}$/,manifest.sourceSha256) || !matches(/^[a-f0-9]{64}$/,manifest.binarySha256)
      || !matches(/^[\x20-\x7e]{1,512}$/,manifest.compiler) || !matches(/^[\x20-\x7e]{1,512}$/,manifest.sdk)) fail();
  const source = read(path.join(root,'owner-journal-darwin-helper.c'),65536);
  if (sha(source.bytes) !== manifest.sourceSha256) fail();
  const executable = read(binary,1048576,true); if (sha(executable.bytes) !== manifest.binarySha256) fail();
  return { binary, manifest, identity: executable.identity, manifestIdentity: manifestFile.identity,
    sourceIdentity: source.identity, manifestDigest: sha(manifestFile.bytes) };
}
const sameArtifact = (a, b) => a.binary === b.binary && a.manifestDigest === b.manifestDigest
  && ['identity','manifestIdentity','sourceIdentity'].every(field =>
    ['dev','ino','mode','uid','size','nlink','mtimeMs','ctimeMs'].every(key => a[field][key] === b[field][key]));
function response(bytes) {
  if (bytes.length !== 32 || bytes.subarray(0,8).toString('ascii') !== 'ODJNRES1'
      || bytes[11] !== 0 || bytes.subarray(16).some(v=>v!==0) || bytes[8] > 2 || bytes[9] > 9 || bytes[10] > 11) fail();
  return { status: bytes[8], stage: bytes[9], slot: bytes[10], errno: bytes.readUInt32BE(12) };
}
// Constructor is private: only this fixed artifact loader creates the bridge.
class Bridge {
  #artifact;
  constructor(value) { this.#artifact = value; }
  invoke({ operation, slot, requestId, lockFd, storeFd, requestFd, slotFds }) {
    try {
      const initialize = operation === 'initialize', selected = fixed.indexOf(slot) + 1;
      if ((!initialize && operation !== 'flush') || (initialize ? slot !== undefined : selected === 0)
          || !matches(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,requestId)
          || !Array.isArray(slotFds) || slotFds.length !== (initialize?11:1)
          || [lockFd,storeFd,requestFd,...slotFds].some(fd=>!integer(fd)||fd<3)
          || new Set([lockFd,storeFd,requestFd,...slotFds]).size !== slotFds.length+3) fail();
      // Revalidate fixed artifact and its exact pinned bytes on every invocation.
      const current = artifact();
      if (!sameArtifact(current, this.#artifact)) fail();
      const input = Buffer.alloc(65); input.write('ODJNAT01',0,'ascii'); input[8]=initialize?1:2; input[9]=initialize?0:selected;
      input.write(requestId,16,'ascii'); input[64]=0xa5;
      // Synchronous return waits for child terminal, including timeout/SIGKILL.
      // An uninterruptible kernel call can outlast timeout; do not unlock early.
      const child = spawnSync(current.binary, [], { input, stdio: ['pipe','pipe','pipe',lockFd,storeFd,requestFd,...slotFds],
        env: {}, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 512, windowsHide: true });
      const output = child.stdout;
      if (child.error || child.signal || !Buffer.isBuffer(output) || (output.length !== 32 && output.length !== 64)
          || !Buffer.isBuffer(child.stderr) || child.stderr.length !== 0) fail();
      const final = response(output.subarray(output.length-32));
      if (output.length === 64) {
        const ready = response(output.subarray(0,32)); if (ready.status !== 0 || ready.stage || ready.slot || ready.errno) fail();
      }
      if (child.status !== 0 || output.length !== 64 || final.status !== 1 || final.stage || final.slot || final.errno) fail(final);
      const after = artifact();
      if (!sameArtifact(after, current)) fail();
      return { completedRequestedNativeFlush: true, authorizationSupported: false, physicalAllocationSupported: false };
    } catch (error) { fail(error?.message === 'owner-journal-native-unavailable' ? error.diagnostic : undefined); }
  }
}
export function createOwnerJournalNativeBridge() {
  if (process.platform !== 'darwin') fail();
  try { return new Bridge(artifact()); } catch { fail(); }
}
