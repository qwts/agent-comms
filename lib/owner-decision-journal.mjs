// Disabled broker-owned admission-prefix storage. No route imports this module.
// Storage validity is not authorization or physical write-capacity reservation.
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireOwnerJournalLock } from './platform/owner-journal-lock.mjs';
import { decodeOwnerDecisionCanonical, snapshotOwnerDecisionBytes } from './owner-decision-canonical.mjs';
import { decodeOwnerDecisionAction } from './owner-decision-codec.mjs';
const LIMIT = 4096;
const RESERVATION = 262144;
const CAPS = Object.freeze({ action: 32768, acceptance: 4096, namespace: 4096 });
const uuid4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const matches = (re, v) => typeof v === 'string' && re.exec(v)?.[0] === v;
const integer = v => Number.isSafeInteger(v) && v >= 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code = 'owner-journal-corrupt') => { throw new Error(code); };
const exact = (v, fields) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)
      || Object.keys(v).length !== fields.length || fields.some(k => !Object.hasOwn(v, k))) fail();
};
// Only generated fixed-field records reach this serializer, never arbitrary data.
const json = v => Buffer.from(`{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${JSON.stringify(v[k])}`).join(',')}}`);

export function validateOwnerDecisionAdmission(actionBytes, acceptanceBytes, namespaceDigest) {
  try {
    if (!matches(digest, namespaceDigest)) fail();
    const original = snapshotOwnerDecisionBytes(actionBytes);
    const saved = snapshotOwnerDecisionBytes(acceptanceBytes);
    if (saved.length > CAPS.acceptance) fail();
    const verified = decodeOwnerDecisionAction(original);
    const acceptance = decodeOwnerDecisionCanonical(saved);
    exact(acceptance, ['v', 'kind', 'requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest',
      'namespaceDigest', 'acceptedAt', 'daemonKey', 'daemonEpoch', 'watchId', 'reservationBytes']);
    if (acceptance.v !== 1 || acceptance.kind !== 'acceptance' || acceptance.namespaceDigest !== namespaceDigest
        || acceptance.reservationBytes !== RESERVATION || !integer(acceptance.acceptedAt)
        || !matches(digest, acceptance.daemonKey) || !integer(acceptance.daemonEpoch) || acceptance.daemonEpoch === 0
        || !matches(uuid4, acceptance.watchId) || acceptance.payloadDigest !== verified.payloadDigest) fail();
    for (const k of ['requestId', 'principal', 'account', 'soul', 'operation']) if (acceptance[k] !== verified.action[k]) fail();
    return { action: original, acceptance: saved, record: acceptance, payloadDigest: verified.payloadDigest };
  } catch { fail('invalid-owner-journal-record'); }
}
function frame(slot, payload) {
  if (!Object.hasOwn(CAPS, slot) || payload.length === 0 || payload.length > CAPS[slot]) fail();
  const header = json({ v: 1, slot, bytes: payload.length, sha256: hash(payload) });
  if (header.length + 1 > 256) fail();
  return Buffer.concat([header, Buffer.from('\n'), payload]);
}
function unframe(bytes, expected) {
  const newline = bytes.indexOf(10);
  if (newline < 1 || newline > 255) fail();
  const h = decodeOwnerDecisionCanonical(bytes.subarray(0, newline));
  exact(h, ['v', 'slot', 'bytes', 'sha256']);
  if (h.v !== 1 || !Object.hasOwn(CAPS, h.slot) || (expected && h.slot !== expected)
      || !integer(h.bytes) || h.bytes === 0 || h.bytes > CAPS[h.slot] || !matches(digest, h.sha256)) fail();
  const payload = bytes.subarray(newline + 1);
  if (payload.length !== h.bytes || hash(payload) !== h.sha256) fail();
  return { slot: h.slot, payload };
}
const LATER = new Set(['challenge.record', 'presence.record', 'receipt.record', 'authorization.record',
  'release.record', 'outcome.record', 'observation.record', 'resolution.record']);

export class OwnerDecisionAdmissionStore {
  #root; #namespace; #io; #fault; #poisoned = false;
  // io/fault are trusted test seams, never request-selected adapters or gates.
  constructor(root, options = {}) {
    try {
      const { namespaceDigest, io = fs, fault = () => {} } = options;
      if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')
          || !matches(digest, namespaceDigest) || typeof fault !== 'function') fail();
      this.#root = path.resolve(root); this.#namespace = namespaceDigest; this.#io = io; this.#fault = fault;
    } catch { fail('invalid-owner-journal-record'); }
    this.#locked(() => { this.#bootstrap(true); this.#scan(); });
  }
  #locked(operation) {
    if (this.#poisoned) fail('owner-journal-reopen-required');
    const fd = acquireOwnerJournalLock(this.#root);
    try { return operation(); }
    catch (error) {
      if (['owner-journal-corrupt', 'owner-journal-capacity', 'owner-journal-id-spent',
        'owner-journal-conflict', 'owner-journal-unsupported-phase'].includes(error?.message)) throw error;
      if (['invalid-owner-decision', 'invalid-owner-decision-encoding', 'invalid-owner-journal-record'].includes(error?.message)) fail();
      this.#poisoned = true; fail('owner-journal-storage-failed');
    } finally {
      try { fs.closeSync(fd); } catch { this.#poisoned = true; fail('owner-journal-storage-failed'); }
    }
  }
  #directory(dir) {
    const info = this.#io.lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
        || (info.mode & 0o7777) !== 0o700) fail();
  }
  #names(dir, limit) {
    const directory = this.#io.opendirSync(dir); const names = [];
    try {
      for (;;) {
        const entry = directory.readSync(); if (entry === null) break;
        if (names.length === limit) fail('owner-journal-capacity');
        if (!matches(/^[\x21-\x7e]{1,64}$/, entry.name)) fail();
        names.push(entry.name);
      }
    } finally { directory.closeSync(); }
    return names;
  }
  #sync(dir, event) {
    const fd = this.#io.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
    try { this.#io.fsyncSync(fd); } finally { this.#io.closeSync(fd); }
    this.#fault(event);
  }
  #read(file, cap) {
    const named = this.#io.lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || named.uid !== process.getuid()
        || (named.mode & 0o7777) !== 0o600 || named.nlink < 1 || named.nlink > 2
        || named.size === 0 || named.size > cap + 256) fail();
    const fd = this.#io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = this.#io.fstatSync(fd);
      if (!before.isFile() || before.uid !== named.uid || before.mode !== named.mode || before.nlink !== named.nlink
          || before.ino !== named.ino || before.dev !== named.dev || before.size !== named.size) fail();
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {
        const n = this.#io.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!Number.isInteger(n) || n <= 0 || n > bytes.length - offset) fail(); offset += n;
      }
      const after = this.#io.fstatSync(fd);
      if (after.size !== before.size || after.mode !== before.mode || after.uid !== before.uid || after.nlink !== before.nlink
          || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail();
      return bytes;
    } finally { this.#io.closeSync(fd); }
  }
  #publish(dir, slot, payload) {
    const target = path.join(dir, `${slot}.record`); const pending = path.join(dir, 'pending');
    const bytes = frame(slot, payload); let fd;
    try {
      fd = this.#io.openSync(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      this.#fault(`${slot}:scratch-created`);
      let offset = 0;
      while (offset < bytes.length) {
        const n = this.#io.writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(n) || n <= 0 || n > bytes.length - offset) fail('owner-journal-storage-failed'); offset += n;
      }
      this.#fault(`${slot}:written`); this.#io.fsyncSync(fd); this.#fault(`${slot}:file-flushed`);
      this.#io.closeSync(fd); fd = undefined;
      this.#io.linkSync(pending, target); this.#fault(`${slot}:linked`);
      this.#sync(dir, `${slot}:directory-flushed`);
      this.#io.unlinkSync(pending); this.#fault(`${slot}:scratch-removed`);
      this.#sync(dir, `${slot}:cleanup-flushed`);
    } finally { if (fd !== undefined) this.#io.closeSync(fd); }
  }
  #bootstrap(initialize = false) {
    const names = this.#names(this.#root, 24);
    for (const name of names) if (!['.journal-lock', 'namespace.record', 'requests', 'pending'].includes(name)) fail();
    if (names.includes('pending')) fail(); // Unknown/partial global metadata never selects a new namespace.
    const expected = json({ v: 1, kind: 'broker-admission-journal', namespaceDigest: this.#namespace });
    const newNamespace = !names.includes('namespace.record');
    if (newNamespace) {
      if (!initialize || names.includes('requests')) fail();
      this.#publish(this.#root, 'namespace', expected);
    } else {
      const saved = unframe(this.#read(path.join(this.#root, 'namespace.record'), CAPS.namespace), 'namespace').payload;
      if (!saved.equals(expected)) fail();
    }
    const requests = path.join(this.#root, 'requests');
    if (!names.includes('requests')) {
      if (!initialize || !newNamespace) fail();
      this.#io.mkdirSync(requests, { mode: 0o700 }); this.#directory(requests);
      this.#sync(requests, 'store:requests-directory-flushed'); this.#sync(this.#root, 'store:directory-flushed');
    } else this.#directory(requests);
  }
  #request(requestId) {
    const dir = path.join(this.#root, 'requests', requestId); this.#directory(dir);
    const names = this.#names(dir, 24);
    for (const name of names) {
      if (LATER.has(name)) fail('owner-journal-unsupported-phase');
      if (!['action.record', 'acceptance.record', 'pending'].includes(name)) fail();
    }
    let action; let acceptance;
    if (names.includes('action.record')) {
      action = unframe(this.#read(path.join(dir, 'action.record'), CAPS.action), 'action').payload;
      if (decodeOwnerDecisionAction(action).action.requestId !== requestId) fail();
    }
    if (names.includes('acceptance.record')) {
      if (!action) fail();
      acceptance = unframe(this.#read(path.join(dir, 'acceptance.record'), CAPS.acceptance), 'acceptance').payload;
      validateOwnerDecisionAdmission(action, acceptance, this.#namespace);
    }
    if (names.includes('pending')) {
      const candidate = unframe(this.#read(path.join(dir, 'pending'), CAPS.action));
      if (candidate.slot === 'action') {
        if (decodeOwnerDecisionAction(candidate.payload).action.requestId !== requestId
            || (action && !candidate.payload.equals(action))) fail();
      } else if (candidate.slot === 'acceptance') {
        if (!action) fail(); validateOwnerDecisionAdmission(action, candidate.payload, this.#namespace);
        if (acceptance && !candidate.payload.equals(acceptance)) fail();
      } else fail();
    }
    // A visible link plus pending is not proof that directory fsync completed.
    // Never acknowledge this prefix from visibility, even for identical bytes.
    return { requestId, finding: acceptance && !names.includes('pending') ? 'admission-complete' : 'orphan', action, acceptance };
  }
  #scan() {
    this.#directory(path.join(this.#root, 'requests'));
    const names = this.#names(path.join(this.#root, 'requests'), LIMIT);
    const entries = [];
    for (const name of names) {
      if (!matches(uuid4, name)) fail();
      const { requestId, finding } = this.#request(name); entries.push({ requestId, finding });
    }
    return entries;
  }
  inspect() {
    return this.#locked(() => {
      this.#bootstrap(); const entries = this.#scan();
      return { retainedIds: entries.length, logicalReservedBytes: entries.length * RESERVATION,
        physicalAllocationSupported: false, authorizationSupported: false, entries };
    });
  }
  read(requestId) {
    if (!matches(uuid4, requestId)) fail('invalid-owner-journal-record');
    return this.#locked(() => {
      this.#bootstrap(); const entries = this.#scan();
      if (!entries.some(e => e.requestId === requestId)) return { requestId, finding: 'absent' };
      const r = this.#request(requestId);
      return { requestId, finding: r.finding, actionBytes: r.action ? Buffer.from(r.action) : null,
        acceptanceBytes: r.acceptance ? Buffer.from(r.acceptance) : null };
    });
  }
  admit(actionBytes, acceptanceBytes) {
    // Snapshot and validate the complete caller data before any request artifact.
    const saved = validateOwnerDecisionAdmission(actionBytes, acceptanceBytes, this.#namespace);
    return this.#locked(() => {
      this.#bootstrap(); const entries = this.#scan(); const id = saved.record.requestId;
      if (entries.some(e => e.requestId === id)) {
        const prior = this.#request(id);
        if (prior.finding === 'orphan') fail('owner-journal-id-spent');
        if (!prior.action.equals(Buffer.from(saved.action)) || !prior.acceptance.equals(Buffer.from(saved.acceptance))) fail('owner-journal-conflict');
        return { requestId: id, finding: 'admission-complete', duplicate: true };
      }
      if (entries.length === LIMIT) fail('owner-journal-capacity');
      const parent = path.join(this.#root, 'requests'); const dir = path.join(parent, id);
      this.#io.mkdirSync(dir, { mode: 0o700 }); this.#fault('request:directory-created');
      this.#directory(dir); this.#sync(dir, 'request:empty-directory-flushed'); this.#sync(parent, 'request:directory-flushed');
      this.#publish(dir, 'action', Buffer.from(saved.action)); this.#publish(dir, 'acceptance', Buffer.from(saved.acceptance));
      return { requestId: id, finding: 'admission-complete', duplicate: false };
    });
  }
}
