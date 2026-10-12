// Private synchronous observation plumbing; no installed provenance or readiness claim.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { decodeNativeObservationV2, decodeFixtureObservationV1, observationSnapshot } from './owner-observer-wire.mjs';
import { assertAncestors } from '../custody.mjs';
import { ownerJournalPlatformSupported } from './owner-journal-lock.mjs';
const fail = () => { throw new Error('owner-observer-unavailable'); };
const hash = b => createHash('sha256').update(b).digest('hex');
const fields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'];
const same = (a, b) => fields.every(k => a[k] === b[k]);
function artifact(binary, digest) {
  if (typeof binary !== 'string' || !path.isAbsolute(binary) || path.resolve(binary) !== binary
      || typeof digest !== 'string' || digest.length !== 64 || !/^[a-f0-9]{64}$/.test(digest)) fail();
  assertAncestors(binary, process.getuid());
  const before = fs.lstatSync(binary);
  if (!before.isFile() || before.nlink !== 1 || ![0, process.getuid()].includes(before.uid)
      || (before.mode & 0o7022) || !(before.mode & 0o111) || before.size < 1 || before.size > 32 * 1024 * 1024) fail();
  const fd = fs.openSync(binary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!same(before, fs.fstatSync(fd))) fail();
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0) fail(); offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) fail();
    if (hash(bytes) !== digest || !same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(binary))) fail();
  } finally { fs.closeSync(fd); }
  return before;
}

const normal = new WeakSet(), fixtures = new WeakSet();
export const isNativeObserver = value => normal.has(value);
export const isFixtureObserver = value => fixtures.has(value);
function create(binary, binarySha256, fixture) {
  if (!ownerJournalPlatformSupported()) fail();
  const initial = artifact(binary, binarySha256);
  let poisoned = false;
  const observer = Object.freeze({ observe(lockFd, fixtureInput) {
    if (poisoned || !Number.isSafeInteger(lockFd) || lockFd < 3) fail();
    const deadline = performance.now() + 10000;
    let input = Buffer.alloc(0), stdio = ['pipe','pipe','pipe',lockFd];
    if (fixture) {
      if (!fixtureInput || !Buffer.isBuffer(fixtureInput.bootstrap) || fixtureInput.bootstrap.length < 1
          || fixtureInput.bootstrap.length > 4096 || !Number.isSafeInteger(fixtureInput.rootFd)
          || fixtureInput.rootFd < 3 || fixtureInput.rootFd === lockFd) fail();
      input = Buffer.from(fixtureInput.bootstrap); stdio.push(fixtureInput.rootFd);
    } else if (fixtureInput !== undefined) fail();
    if (!same(initial, artifact(binary, binarySha256)) || performance.now() >= deadline) fail();
    // spawnSync returns after owned child termination and pipe closure, even on
    // timeout. Uninterruptible syscalls can overrun; no early FD release occurs.
    let child;
    try { child = spawnSync(binary, [], { input, env: {}, cwd: '/', stdio,
      timeout: Math.max(1, Math.floor(deadline-performance.now())), killSignal: 'SIGKILL', maxBuffer: 24576, windowsHide: true }); }
    catch { poisoned = true; fail(); }
    if (child.error || child.signal || !Number.isInteger(child.status)) { poisoned = true; fail(); }
    if (child.status !== 0 || !Buffer.isBuffer(child.stderr) || child.stderr.length || performance.now() >= deadline) { poisoned = true; fail(); }
    if (!same(initial, artifact(binary, binarySha256))) { poisoned = true; fail(); }
    const snapshot = observationSnapshot((fixture ? decodeFixtureObservationV1 : decodeNativeObservationV2)(child.stdout));
    if (performance.now() >= deadline) fail();
    return snapshot;
  } });
  (fixture ? fixtures : normal).add(observer); return observer;
}
// Trusted private pinned-artifact plumbing only. Production installation gate
// does not call this until signed provenance is implemented and reviewed.
export function createNativeOwnerObserver({ binary, binarySha256 } = {}) { return create(binary, binarySha256, false); }
export function createNativeOwnerObserverFixture({ binary, binarySha256, syntheticFixture = false } = {}) {
  if (!syntheticFixture) fail(); return create(binary, binarySha256, true);
}
