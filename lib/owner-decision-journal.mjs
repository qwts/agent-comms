// Disabled broker-owned bounded storage. No route imports this module.
// Storage validity is not authorization or physical write-capacity reservation.
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireOwnerJournalLock } from './platform/owner-journal-lock.mjs';
import { decodeOwnerDecisionCanonical, snapshotOwnerDecisionBytes } from './owner-decision-canonical.mjs';
import { OWNER_JOURNAL_FIXED_SLOTS, encodeOwnerJournalFrame, decodeOwnerJournalFrame } from './owner-decision-journal-frame.mjs';
import { decodeOwnerDecisionAction } from './owner-decision-codec.mjs';
import { validateOwnerDecisionAdmission } from './owner-decision-admission.mjs';
export { validateOwnerDecisionAdmission } from './owner-decision-admission.mjs';
import { createOwnerDecisionLifecycleValidator } from './owner-decision-lifecycle-records.mjs';
import { decodeOwnerDecisionPrepared } from './owner-decision-prepared.mjs';
import { verifyOwnerDecisionProof } from './owner-decision-proof.mjs';
import { createOwnerJournalNativeBridge } from './platform/owner-journal-native.mjs';
const LIMIT = 4096;
const RESERVATION = 262144;
const CAPS = Object.freeze({ action: 32768, acceptance: 4096, namespace: 4096 });
const uuid4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const matches = (re, v) => typeof v === 'string' && re.exec(v)?.[0] === v;
const integer = v => Number.isSafeInteger(v) && v >= 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code = 'owner-journal-corrupt') => { throw new Error(code); };
// A close failure has unknown descriptor state: never retry that descriptor,
// but still attempt every other owned close and preserve the earliest failure.
function closeOwned(io, descriptors, failure) {
  for (const fd of descriptors) {
    if (fd === undefined) continue;
    try { io.closeSync(fd); } catch (error) { failure ??= error; }
  }
  return failure;
}
const exact = (v, fields) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)
      || Object.keys(v).length !== fields.length || fields.some(k => !Object.hasOwn(v, k))) fail();
};
// Only generated fixed-field records reach this serializer, never arbitrary data.
const json = v => Buffer.from(`{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${JSON.stringify(v[k])}`).join(',')}}`);

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
const FIXED = [...OWNER_JOURNAL_FIXED_SLOTS, { slot: 'scratch', cap: 32768 }];
const FIXED_NAMES = new Map(FIXED.map(entry => [`${entry.slot}.record`, entry]));
const sameFile = (a, b) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size'].every(key => a[key] === b[key]);
const LATER = new Set(['challenge.record', 'presence.record', 'receipt.record', 'authorization.record',
  'release.record', 'outcome.record', 'observation.record', 'resolution.record']);

export class OwnerDecisionAdmissionStore {
  #root; #namespace; #io; #fault; #format; #verified = new Map(); #poisoned = false; #lifecycle; #now; #native; #lockFd;
  // io/fault are trusted test seams, never request-selected adapters or gates.
  constructor(root, options = {}) {
    try {
      const { namespaceDigest, io = fs, fault = () => {}, format = 'scratch-v1', lifecycle, now = Date.now, nativeBridge = false } = options;
      if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')
          || !matches(digest, namespaceDigest) || typeof fault !== 'function'
          || !['scratch-v1', 'fixed-v1'].includes(format) || typeof now !== 'function'
          || typeof nativeBridge !== 'boolean' || (nativeBridge && format !== 'fixed-v1')) fail();
      if (nativeBridge) this.#native = createOwnerJournalNativeBridge();
      if (lifecycle !== undefined) {
        if (format !== 'fixed-v1' || !lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)
            || Object.keys(lifecycle).some(key => !['brokerPublicKeys', 'presencePublicKeys'].includes(key))) fail();
        this.#lifecycle = createOwnerDecisionLifecycleValidator({ ...lifecycle, namespaceDigest });
      }
      this.#now = now; // Trusted local clock/test seam, never a wire option.
      this.#root = path.resolve(root); this.#namespace = namespaceDigest; this.#io = io; this.#fault = fault; this.#format = format;
    } catch (error) {
      if (error?.message === 'owner-journal-native-unavailable') throw error;
      fail('invalid-owner-journal-record');
    }
    this.#locked(() => { this.#bootstrap(true); this.#scan(); });
  }
  #locked(operation) {
    if (this.#poisoned) fail('owner-journal-reopen-required');
    const fd = acquireOwnerJournalLock(this.#root);
    this.#lockFd = fd;
    try { return operation(); }
    catch (error) {
      if (this.#format === 'fixed-v1' && ['owner-journal-corrupt', 'owner-journal-unsupported-phase'].includes(error?.message)) this.#poisoned = true;
      if (['owner-journal-corrupt', 'owner-journal-capacity', 'owner-journal-id-spent',
        'owner-journal-conflict', 'owner-journal-unsupported-phase', 'owner-journal-recovery-required',
        'owner-journal-input-invalid'].includes(error?.message)) throw error;
      if (['invalid-owner-decision', 'invalid-owner-decision-encoding', 'invalid-owner-journal-record'].includes(error?.message)) fail();
      this.#poisoned = true; fail('owner-journal-storage-failed');
    } finally {
      this.#lockFd = undefined;
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
    if (this.#format === 'fixed-v1' && ['action', 'acceptance'].includes(slot)) {
      return this.#publishFixed(dir, slot === 'action' ? 'original-action' : slot, payload);
    }
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
      const closing = fd; fd = undefined; this.#io.closeSync(closing);
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
    const expected = json({ v: 1, kind: this.#format === 'fixed-v1' ? 'broker-fixed-admission-journal-v1' : 'broker-admission-journal', namespaceDigest: this.#namespace });
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
  #readFixed(file, cap) {
    const named = this.#io.lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || named.uid !== process.getuid()
      || (named.mode & 0o7777) !== 0o600 || named.nlink !== 1 || named.size < 0 || named.size > cap + 256) fail();
    const fd = this.#io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = this.#io.fstatSync(fd); if (!sameFile(before, named)) fail();
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {
        const n = this.#io.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!Number.isInteger(n) || n <= 0 || n > bytes.length - offset) fail(); offset += n;
      }
      const after = this.#io.fstatSync(fd);
      if (!sameFile(before, after) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
      return { bytes, info: after, filename: file };
    } finally { this.#io.closeSync(fd); }
  }
  #nativeInvoke(dir, operation, slotFds, slot) {
    let storeFd, requestFd, failure;
    try {
      storeFd = this.#io.openSync(this.#root, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
      requestFd = this.#io.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
      this.#native.invoke({ operation, slot, slotFds, requestId: path.basename(dir), lockFd: this.#lockFd, storeFd, requestFd });
    } catch (error) { failure = error; }
    finally { failure = closeOwned(this.#io, [requestFd, storeFd], failure); }
    if (failure) throw failure;
  }
  #flushFixed(fd, dir, slot) {
    if (this.#native) this.#nativeInvoke(dir, 'flush', [fd], slot);
    else this.#io.fsyncSync(fd);
  }
  #initializeFixedNative(dir) {
    const descriptors = []; let failure;
    try {
      // All exact final names exist at EOF0 before native allocation. Any
      // interrupted creation/allocation remains a fully charged spent orphan.
      for (const { slot } of FIXED) {
        const fd = this.#io.openSync(path.join(dir, `${slot}.record`),
          fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        descriptors.push(fd); this.#fault(`initialize:${slot}:native-created`);
      }
      this.#sync(dir, 'initialize:native-names-flushed');
      this.#nativeInvoke(dir, 'initialize', descriptors);
      this.#fault('initialize:native-completed');
    } catch (error) { failure = error; }
    finally { failure = closeOwned(this.#io, descriptors, failure); }
    if (failure) throw failure;
    this.#sync(dir, 'initialize:directory-flushed');
    const initialized = this.#requestFixed(path.basename(dir));
    if (initialized.rows.length !== FIXED.length || initialized.rows.some(({ slot, bytes }) =>
      bytes.length !== FIXED_NAMES.get(`${slot}.record`).cap + 256 || !bytes.every(byte => byte === 0))) fail();
  }
  #initializeFixed(dir) {
    if (this.#native) return this.#initializeFixedNative(dir);
    for (const { slot, cap } of FIXED) {
      const file = path.join(dir, `${slot}.record`); let fd;
      try {
        fd = this.#io.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        this.#fault(`initialize:${slot}:created`);
        this.#io.ftruncateSync(fd, cap + 256); this.#fault(`initialize:${slot}:sized`);
        const zeros = Buffer.alloc(cap + 256); let offset = 0;
        while (offset < zeros.length) {
          const n = this.#io.writeSync(fd, zeros, offset, zeros.length - offset, offset);
          if (!Number.isInteger(n) || n <= 0 || n > zeros.length - offset) fail('owner-journal-storage-failed'); offset += n;
        }
        this.#fault(`initialize:${slot}:zero-written`);
        this.#io.fsyncSync(fd); this.#fault(`initialize:${slot}:flushed`);
        const closing = fd; fd = undefined; this.#io.closeSync(closing); this.#fault(`initialize:${slot}:closed`);
        const saved = this.#readFixed(file, cap);
        if (saved.bytes.length !== cap + 256 || !saved.bytes.every(byte => byte === 0)) fail();
        this.#fault(`initialize:${slot}:verified`);
      } finally { if (fd !== undefined) this.#io.closeSync(fd); }
    }
    this.#sync(dir, 'initialize:directory-flushed');
    const initialized = this.#requestFixed(path.basename(dir));
    if (initialized.rows.length !== FIXED.length || initialized.rows.some(({ slot, bytes }) =>
      bytes.length !== FIXED_NAMES.get(`${slot}.record`).cap + 256 || !bytes.every(byte => byte === 0))) fail();
  }
  #publishFixed(dir, slot, payload) {
    const entry = OWNER_JOURNAL_FIXED_SLOTS.find(e => e.slot === slot);
    if (!entry || (!this.#lifecycle && !['original-action', 'acceptance'].includes(slot))) fail('owner-journal-unsupported-phase');
    const file = path.join(dir, `${slot}.record`), prior = this.#readFixed(file, entry.cap);
    if (prior.bytes.length !== entry.cap + 256 || !prior.bytes.every(byte => byte === 0)) fail();
    const bytes = encodeOwnerJournalFrame(payload, { slot, requestId: path.basename(dir), namespaceDigest: this.#namespace });
    let fd;
    try {
      fd = this.#io.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      if (!sameFile(this.#io.fstatSync(fd), prior.info)) fail();
      const write = (start, end) => {
        let offset = start;
        while (offset < end) {
          const n = this.#io.writeSync(fd, bytes, offset, end - offset, offset);
          if (!Number.isInteger(n) || n <= 0 || n > end - offset) fail('owner-journal-storage-failed'); offset += n;
        }
      };
      write(0, bytes.length - 128); this.#fault(`${slot}:fixed-body-written`);
      this.#flushFixed(fd, dir, slot); this.#fault(`${slot}:fixed-body-flushed`);
      write(bytes.length - 128, bytes.length); this.#fault(`${slot}:fixed-trailer-written`);
      this.#flushFixed(fd, dir, slot); this.#fault(`${slot}:fixed-trailer-flushed`);
      const closing = fd; fd = undefined; this.#io.closeSync(closing); this.#fault(`${slot}:fixed-closed`);
      const saved = this.#readFixed(file, entry.cap);
      if (!saved.bytes.equals(bytes) || saved.info.dev !== prior.info.dev || saved.info.ino !== prior.info.ino) fail();
      this.#fault(`${slot}:fixed-verified`);
    } finally { if (fd !== undefined) this.#io.closeSync(fd); }
  }
  #requestFixed(requestId) {
    try {
      const dir = path.join(this.#root, 'requests', requestId); this.#directory(dir);
      const names = this.#names(dir, 24);
      if (names.some(name => !FIXED_NAMES.has(name))) fail();
      const frames = new Map(), rows = []; let initialized = names.length === FIXED.length;
      for (const { slot, cap } of FIXED) {
        const filename = `${slot}.record`; if (!names.includes(filename)) continue;
        const saved = this.#readFixed(path.join(dir, filename), cap); rows.push({ slot, ...saved });
        if (saved.bytes.length !== cap + 256) {
          if (!saved.bytes.every(byte => byte === 0)) fail(); initialized = false; continue;
        }
        if (slot === 'scratch' || (!this.#lifecycle && !['original-action', 'acceptance'].includes(slot))) {
          if (!saved.bytes.every(byte => byte === 0)) fail('owner-journal-unsupported-phase');
          continue;
        }
        const decoded = decodeOwnerJournalFrame(saved.bytes, { slot, requestId, namespaceDigest: this.#namespace });
        if (decoded.kind === 'committed') frames.set(slot, decoded.payload);
        else if (decoded.kind === 'uncommitted') {
          if (!['original-action', 'acceptance'].includes(slot)) fail();
          initialized = false;
        }
      }
      const action = frames.get('original-action'), acceptance = frames.get('acceptance');
      if (action && decodeOwnerDecisionAction(action).action.requestId !== requestId) fail();
      if (acceptance) {
        if (!action) fail(); validateOwnerDecisionAdmission(action, acceptance, this.#namespace);
      }
      if (!acceptance && [...frames.keys()].some(slot => !['original-action', 'acceptance'].includes(slot))) fail();
      const graph = this.#lifecycle && acceptance ? this.#lifecycle(frames) : null;
      const stamp = hash(Buffer.from(JSON.stringify(rows.map(({ slot, info, bytes }) =>
        [slot, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, hash(bytes)]))));
      if (this.#verified.has(requestId) && this.#verified.get(requestId) !== stamp) this.#verified.delete(requestId);
      const complete = initialized && action && acceptance;
      const finding = complete ? (this.#verified.get(requestId) === stamp ? 'admission-complete' : 'admission-visible') : 'orphan';
      return { requestId, finding, action, acceptance, stamp, rows, graph, frames };
    } catch (error) {
      this.#verified.delete(requestId);
      if (['invalid-owner-journal-frame', 'invalid-owner-decision', 'invalid-owner-decision-encoding', 'invalid-owner-journal-record'].includes(error?.message)) fail();
      throw error;
    }
  }
  #request(requestId) {
    if (this.#format === 'fixed-v1') return this.#requestFixed(requestId);
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
    // This bounds only volatile flush evidence, never retires a durable ID.
    const retained = new Set(names);
    for (const id of this.#verified.keys()) if (!retained.has(id)) this.#verified.delete(id);
    for (const name of names) {
      if (!matches(uuid4, name)) fail();
      const { requestId, finding, graph } = this.#request(name);
      entries.push({ requestId, finding, ...(this.#lifecycle ? { state: graph?.state ?? null } : {}) });
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
        acceptanceBytes: r.acceptance ? Buffer.from(r.acceptance) : null,
        ...(this.#lifecycle ? { state: r.graph?.state ?? null, authorizationSupported: false,
          physicalAllocationSupported: false, slots: new Map([...r.frames].map(([k, v]) => [k, Buffer.from(v)])) } : {}) };
    });
  }
  recover(requestId) {
    if (!matches(uuid4, requestId)) fail('invalid-owner-journal-record');
    return this.#locked(() => {
      if (this.#format !== 'fixed-v1') fail('owner-journal-unsupported-phase');
      this.#bootstrap(); const entries = this.#scan(); this.#verified.delete(requestId);
      if (!entries.some(e => e.requestId === requestId)) return { requestId, finding: 'absent' };
      const before = this.#requestFixed(requestId);
      if (!['admission-visible', 'admission-complete'].includes(before.finding)) fail('owner-journal-id-spent');
      for (const { slot, filename, info } of before.rows) {
        const fd = this.#io.openSync(filename, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
        try {
          if (!sameFile(this.#io.fstatSync(fd), info)) fail();
          this.#flushFixed(fd, path.join(this.#root, 'requests', requestId), slot); this.#fault(`recovery:${slot}:flushed`);
        } finally { this.#io.closeSync(fd); }
      }
      this.#sync(path.join(this.#root, 'requests', requestId), 'recovery:request-directory-flushed');
      this.#sync(path.join(this.#root, 'requests'), 'recovery:parent-directory-flushed');
      this.#bootstrap(); const after = this.#requestFixed(requestId);
      if (after.finding !== 'admission-visible' || before.stamp !== after.stamp) fail();
      this.#verified.set(requestId, after.stamp);
      return { requestId, finding: 'admission-complete', authorizationSupported: false, physicalAllocationSupported: false,
        ...(this.#lifecycle ? { state: after.graph.state } : {}) };
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
        if (prior.finding === 'admission-visible') fail('owner-journal-recovery-required');
        return { requestId: id, finding: 'admission-complete', duplicate: true };
      }
      if (entries.length === LIMIT) fail('owner-journal-capacity');
      const parent = path.join(this.#root, 'requests'); const dir = path.join(parent, id);
      this.#io.mkdirSync(dir, { mode: 0o700 }); this.#fault('request:directory-created');
      this.#directory(dir); this.#sync(dir, 'request:empty-directory-flushed'); this.#sync(parent, 'request:directory-flushed');
      if (this.#format === 'fixed-v1') this.#initializeFixed(dir);
      this.#publish(dir, 'action', Buffer.from(saved.action)); this.#publish(dir, 'acceptance', Buffer.from(saved.acceptance));
      if (this.#format === 'fixed-v1') {
        const current = this.#requestFixed(id);
        if (current.finding !== 'admission-visible' || !current.action.equals(Buffer.from(saved.action))
            || !current.acceptance.equals(Buffer.from(saved.acceptance))) fail();
        this.#verified.set(id, current.stamp);
      }
      return { requestId: id, finding: 'admission-complete', duplicate: false };
    });
  }
  #transition(requestId, phase, payloads) {
    if (!this.#lifecycle) fail('owner-journal-unsupported-phase');
    if (!matches(uuid4, requestId)) fail('owner-journal-input-invalid');
    const snapshots = new Map();
    try {
      for (const [slot, bytes] of payloads) snapshots.set(slot, Buffer.from(snapshotOwnerDecisionBytes(bytes)));
    } catch { fail('owner-journal-input-invalid'); }
    return this.#locked(() => {
      this.#bootstrap(); const entries = this.#scan();
      if (!entries.some(e => e.requestId === requestId)) fail('owner-journal-id-spent');
      const prior = this.#requestFixed(requestId);
      if (prior.finding === 'orphan') fail('owner-journal-id-spent');
      // Visible bytes never acknowledge a transition until explicit recovery.
      if (prior.finding !== 'admission-complete') fail('owner-journal-recovery-required');
      const present = [...snapshots].filter(([slot]) => prior.frames.has(slot));
      if (present.some(([slot, bytes]) => !prior.frames.get(slot).equals(bytes))) fail('owner-journal-conflict');
      const result = (state, duplicate) => ({ requestId, state, duplicate,
        authorizationSupported: false, physicalAllocationSupported: false });
      if (present.length === snapshots.size) return result(prior.graph.state, true);
      const allowed = { prepare: ['preparing'], authorize: ['prepared'], release: ['authorized'],
        outcome: ['preparing', 'prepared', 'authorized', 'released'], observe: ['indeterminate'], resolve: ['indeterminate'] };
      if (!allowed[phase]?.includes(prior.graph.state)) fail('owner-journal-conflict');
      if (phase === 'authorize' && prior.graph.proofIncomplete) fail('owner-journal-id-spent');
      const next = new Map(prior.frames); for (const [slot, bytes] of snapshots) next.set(slot, bytes);
      let graph;
      try {
        graph = this.#lifecycle(next); // Complete future graph before the first write.
        if (phase === 'prepare') decodeOwnerDecisionPrepared(snapshots.get('prepared-challenge'), graph.saved, this.#now());
        if (['authorize', 'release'].includes(phase)) {
          verifyOwnerDecisionProof({ ...graph.proofKeys, challengeBytes: graph.prepared.challengeBytes,
            saved: { ...graph.saved, ...(graph.prepared.wrapper.stage === null ? {} : { stageExpiresAt: graph.prepared.wrapper.stage.expiresAt }) },
            presenceToken: graph.presenceToken, receiptToken: graph.receiptToken, nowMilliseconds: this.#now() });
        }
      } catch { fail('owner-journal-input-invalid'); }
      for (const [slot, bytes] of snapshots) if (!prior.frames.has(slot))
        this.#publishFixed(path.join(this.#root, 'requests', requestId), slot, bytes);
      const after = this.#requestFixed(requestId);
      if (after.finding !== 'admission-visible' || after.graph.state !== graph.state
          || [...snapshots].some(([slot, bytes]) => !after.frames.get(slot)?.equals(bytes))) fail();
      this.#verified.set(requestId, after.stamp);
      return result(after.graph.state, false);
    });
  }
  recordPrepared(requestId, wrapperBytes) {
    return this.#transition(requestId, 'prepare', [['prepared-challenge', wrapperBytes]]);
  }
  recordAuthorization(requestId, options) {
    try { exact(options, ['presenceBytes', 'receiptBytes', 'authorizationBytes']); }
    catch { fail('owner-journal-input-invalid'); }
    const { presenceBytes, receiptBytes, authorizationBytes } = options;
    return this.#transition(requestId, 'authorize', [['presence', presenceBytes], ['receipt', receiptBytes], ['authorization', authorizationBytes]]);
  }
  recordRelease(requestId, releaseBytes) {
    // Storage evidence only. Future broker composition must perform the live
    // current-authority check in its transaction; this never returns mayApply.
    return this.#transition(requestId, 'release', [['release', releaseBytes]]);
  }
  recordOutcome(requestId, outcomeBytes) {
    return this.#transition(requestId, 'outcome', [['initial-outcome', outcomeBytes]]);
  }
  recordObservation(requestId, referenceBytes) {
    // One immutable observation is supported here. Replacing an existing
    // observation still needs the reviewed bounded scratch/recovery adapter.
    return this.#transition(requestId, 'observe', [['observation-reference', referenceBytes]]);
  }
  recordResolution(requestId, referenceBytes) {
    return this.#transition(requestId, 'resolve', [['terminal-reference', referenceBytes]]);
  }
}
// The lifecycle mode extends the same bounded format/lock/core; no parallel
// store or automatic migration is selected by this compatibility alias.
export { OwnerDecisionAdmissionStore as OwnerDecisionJournalStore };
