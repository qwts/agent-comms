// Internal real filesystem engine. Its phase handles are storage capabilities,
// never owner permission. No route/readiness imports it; no key material enters.
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertAncestors } from '../custody.mjs';
import { acquireOwnerJournalLock, ownerJournalPlatformSupported } from '../platform/owner-journal-lock.mjs';
import { decodeOwnerDecisionCanonical, snapshotOwnerDecisionBytes } from '../owner-decision-canonical.mjs';
import { decodeBrokerOwnerEnrollmentRecord, validateBrokerOwnerEnrollmentChain } from '../owner-enrollment-codec.mjs';
import { BROKER_ENROLLMENT_SLOTS, encodeBrokerOwnerEnrollmentFrame, decodeBrokerOwnerEnrollmentFrame } from '../owner-enrollment-frame.mjs';

export const BROKER_ENROLLMENT_STORE_FORMAT = 'broker-owner-enrollment-fixed-v1\n';
const formatBytes = Buffer.from(BROKER_ENROLLMENT_STORE_FORMAT);
export const BROKER_ENROLLMENT_STORE_LIMITS = Object.freeze({ revisions: 1024, slotEntries: 3072,
  namedEntries: 3078, framedBytes: 6029312, sourceBytes: 4096, physicalAllocationSupported: false });
const slots = BROKER_ENROLLMENT_SLOTS;
const fail = code => { throw new Error(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const canonical = value => value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const bytes = value => Buffer.from(canonical(value));
const identityFields = ['dev','ino','mode','uid','gid','nlink','size'];
const same = (a, b) => identityFields.every(k => a[k] === b[k]);
const stable = (a, b) => same(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const suffix = kind => ({ record: 'record', audit: 'audit', confirmation: 'confirm' })[kind];
const name = (revision, kind) => `${String(revision).padStart(4, '0')}.${suffix(kind)}`;
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const harmless = new Set(['owner-enrollment-conflict', 'owner-enrollment-capacity',
  'owner-enrollment-recovery-required', 'owner-enrollment-pending', 'invalid-owner-enrollment-phase']);

export class BrokerOwnerEnrollmentStore {
  #root; #io; #fault; #uid; #lock; #dirs = new Map(); #identities = new Map(); #source;
  #durable = null; #poisoned = false; #closed = false; #handles = new WeakMap();
  // Constructor options are trusted test/storage plumbing, not wire input.
  // Production's separate fixed-root wrapper supplies no caller overrides.
  constructor(root, { io = fs, fault = () => {} } = {}) {
    this.#root = root; this.#io = io; this.#fault = fault; this.#uid = process.getuid?.();
    try {
      if (!ownerJournalPlatformSupported() || typeof root !== 'string' || !path.isAbsolute(root)
          || root.includes('\0') || !Number.isSafeInteger(this.#uid) || this.#uid <= 0) throw new Error();
      assertAncestors(root, this.#uid);
      this.#openDirectory('');
      // No established open can create a lock, directory or metadata file.
      this.#checkFile(path.join(root, '.journal-lock'), 0);
      this.#lock = acquireOwnerJournalLock(root, { io, createIfEmpty: false });
      this.#identities.set('.journal-lock', this.#io.fstatSync(this.#lock, { bigint: true }));
      for (const slot of slots) this.#openDirectory(slot.directory);
      const sourceBytes = this.#read('source.record', 4096).bytes;
      this.#source = decodeOwnerDecisionCanonical(sourceBytes);
      if (!exact(this.#source, ['v','kind','namespaceDigest','service']) || this.#source.v !== 1
          || this.#source.kind !== 'broker-owner-enrollment-source'
          || !matches(/^[a-f0-9]{64}$/, this.#source.namespaceDigest)
          || !exact(this.#source.service, ['platform','brokerUid']) || this.#source.service.platform !== 'darwin'
          || this.#source.service.brokerUid !== this.#uid || this.#uid > 0xffffffff) throw new Error();
      Object.freeze(this.#source.service); Object.freeze(this.#source);
      const format = this.#read('format', formatBytes.length, true).bytes;
      if (!format.equals(formatBytes)) throw new Error();
      this.#scan();
    } catch (error) {
      this.#poisoned = true;
      try { this.close(); } catch { /* Preserve initial sanitized refusal. */ }
      fail(error?.message === 'owner-journal-busy' ? 'owner-enrollment-busy' : 'owner-enrollment-storage-failed');
    }
  }
  #stat(file) { return this.#io.lstatSync(file, { bigint: true }); }
  #checkFile(file, length, exactLength = true) {
    const s = this.#stat(file);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== BigInt(this.#uid) || s.nlink !== 1n
        || (s.mode & 0o7777n) !== 0o600n || (exactLength ? s.size !== BigInt(length) : s.size < 1n || s.size > BigInt(length))) throw new Error();
    return s;
  }
  #openDirectory(relative) {
    const file = path.join(this.#root, relative), before = this.#stat(file);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== BigInt(this.#uid)
        || (before.mode & 0o7777n) !== 0o700n) throw new Error();
    const fd = this.#io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    this.#dirs.set(relative, { fd, identity: before });
    if (!same(this.#io.fstatSync(fd, { bigint: true }), before) || !same(this.#stat(file), before)) throw new Error();
  }
  #custody() {
    assertAncestors(this.#root, this.#uid);
    for (const [relative, value] of this.#dirs) {
      if (!same(this.#stat(path.join(this.#root, relative)), value.identity)
          || !same(this.#io.fstatSync(value.fd, { bigint: true }), value.identity)) throw new Error();
    }
    const lock = this.#identities.get('.journal-lock');
    if (!same(this.#checkFile(path.join(this.#root, '.journal-lock'), 0), lock)
        || !same(this.#io.fstatSync(this.#lock, { bigint: true }), lock)) throw new Error();
  }
  #entries(relative, expected) {
    const directory = this.#io.opendirSync(path.join(this.#root, relative));
    const found = new Set(); let entry;
    try {
      while ((entry = directory.readSync()) !== null) {
        if (found.size === expected.size || !expected.has(entry.name) || found.has(entry.name)) throw new Error();
        found.add(entry.name);
      }
    } finally { directory.closeSync(); }
    if (found.size !== expected.size) throw new Error();
  }
  #read(relative, length, exactLength = false) {
    const file = path.join(this.#root, relative), before = this.#checkFile(file, length, exactLength);
    const cached = this.#identities.get(relative);
    if (cached && !same(cached, before)) throw new Error();
    let fd = this.#io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      if (!stable(this.#io.fstatSync(fd, { bigint: true }), before)) throw new Error();
      const content = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < content.length) {
        const count = this.#io.readSync(fd, content, offset, content.length - offset, offset);
        if (!Number.isSafeInteger(count) || count < 1 || count > content.length - offset) throw new Error();
        offset += count;
      }
      if (!stable(this.#io.fstatSync(fd, { bigint: true }), before) || !stable(this.#stat(file), before)) throw new Error();
      this.#identities.set(relative, before);
      return { bytes: content, identity: before };
    } finally { const owned = fd; fd = undefined; this.#io.closeSync(owned); }
  }
  #prospective(entries, record, audit) {
    const r = decodeBrokerOwnerEnrollmentRecord(record), value = r.record;
    const a = audit ?? bytes({ v: 1, kind: 'broker-owner-audit', namespaceDigest: value.namespaceDigest,
      revision: value.revision, recordDigest: r.sha256, transactionId: value.transactionId,
      decisionEvidenceDigest: value.decisionEvidenceDigest });
    const c = bytes({ v: 1, kind: 'broker-owner-confirmation', namespaceDigest: value.namespaceDigest,
      revision: value.revision, recordDigest: r.sha256, auditDigest: hash(a) });
    return { triple: { record, audit: a, confirmation: c }, result: validateBrokerOwnerEnrollmentChain([...entries, { record, audit: a, confirmation: c }]) };
  }
  #scan() {
    this.#custody();
    this.#entries('', new Set(['.journal-lock','source.record','format', ...slots.map(s => s.directory)]));
    const source = this.#read('source.record', 4096), format = this.#read('format', formatBytes.length, true);
    if (!source.bytes.equals(bytes(this.#source)) || !format.bytes.equals(formatBytes)) throw new Error();
    const fingerprint = createHash('sha256');
    fingerprint.update(source.bytes); fingerprint.update(format.bytes);
    const entries = [], nonempty = [], slotHashes = new Map(); let pending = null, emptySeen = false;
    const rows = Array.from({ length: 1024 }, () => ({}));
    for (const slot of slots) {
      this.#entries(slot.directory, new Set(Array.from({ length: 1024 }, (_, i) => name(i + 1, slot.kind))));
      for (let revision = 1; revision <= 1024; revision++) {
        const relative = path.join(slot.directory, name(revision, slot.kind));
        const read = this.#read(relative, slot.cap + 256, true);
        slotHashes.set(relative, hash(read.bytes));
        fingerprint.update(relative); fingerprint.update(read.bytes);
        fingerprint.update(identityFields.map(k => read.identity[k].toString()).join(','));
        const decoded = decodeBrokerOwnerEnrollmentFrame(read.bytes, { kind: slot.kind, revision, namespaceDigest: this.#source.namespaceDigest });
        rows[revision - 1][slot.kind] = decoded;
        if (decoded.state !== 'empty') nonempty.push({ relative, identity: read.identity });
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], used = slots.filter(s => row[s.kind].state !== 'empty');
      if (used.length === 0) { emptySeen = true; continue; }
      if (emptySeen || pending || row.record.state === 'empty' || (row.confirmation.state !== 'empty' && row.audit.state === 'empty')) throw new Error();
      if (row.record.record.service.brokerUid !== this.#uid) throw new Error();
      if (used.length === 3) entries.push({ record: row.record.payload, audit: row.audit.payload, confirmation: row.confirmation.payload });
      else {
        this.#prospective(entries, row.record.payload, row.audit.state === 'empty' ? undefined : row.audit.payload);
        pending = { revision: i + 1, record: row.record, audit: row.audit };
      }
    }
    const chain = entries.length ? validateBrokerOwnerEnrollmentChain(entries) : null;
    this.#custody();
    return { entries, nonempty, pending, chain, slotHashes, fingerprint: fingerprint.digest('hex') };
  }
  #run(fn) {
    if (this.#closed || this.#poisoned) fail('owner-enrollment-storage-failed');
    try { return fn(); }
    catch (error) {
      if (harmless.has(error?.message)) throw error;
      this.#poisoned = true; fail('owner-enrollment-storage-failed');
    }
  }
  #verified(scan) {
    if (this.#durable !== scan.fingerprint) fail('owner-enrollment-recovery-required');
  }
  #view(scan) {
    return Object.freeze({ namespaceDigest: this.#source.namespaceDigest, brokerLocalRevision: scan.entries.length,
      state: scan.pending ? 'pending' : scan.chain?.state ?? 'empty', pendingRevision: scan.pending?.revision ?? null,
      headDigest: scan.chain?.headDigest ?? null, completedRequestedFlush: this.#durable === scan.fingerprint,
      authorizationSupported: false, protectedProducerAvailable: false, physicalAllocationSupported: false,
      nativeFullFlushVerified: false, installationProvenanceVerified: false });
  }
  inspect() { return this.#run(() => this.#view(this.#scan())); }
  #flushFile(relative, expected) {
    const file = path.join(this.#root, relative); let fd;
    try {
      if (!stable(this.#stat(file), expected)) throw new Error();
      fd = this.#io.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!stable(this.#io.fstatSync(fd, { bigint: true }), expected)) throw new Error();
      this.#io.fsyncSync(fd);
      if (!stable(this.#io.fstatSync(fd, { bigint: true }), expected) || !stable(this.#stat(file), expected)) throw new Error();
    } finally { if (fd !== undefined) { const owned = fd; fd = undefined; this.#io.closeSync(owned); } }
  }
  recoverConfirmed() {
    return this.#run(() => {
      const scan = this.#scan(); if (scan.pending) fail('owner-enrollment-pending');
      this.#durable = null;
      const extra = ['source.record','format'].map(relative => ({ relative, identity: this.#identities.get(relative) }));
      for (const { relative, identity } of [...extra, ...scan.nonempty]) {
        this.#flushFile(relative, identity); this.#fault(`recover:${relative}:flushed`);
      }
      for (const [relative, value] of this.#dirs) { this.#io.fsyncSync(value.fd); this.#fault(`recover:${relative || 'root'}:directory-flushed`); }
      const after = this.#scan(); if (after.fingerprint !== scan.fingerprint) throw new Error();
      this.#durable = after.fingerprint; return this.#view(after);
    });
  }
  #write(scan, slot, revision, input) {
    const payload = Buffer.from(snapshotOwnerDecisionBytes(input));
    const relative = path.join(slot.directory, name(revision, slot.kind)), file = path.join(this.#root, relative);
    const frame = encodeBrokerOwnerEnrollmentFrame(payload, { kind: slot.kind, revision, namespaceDigest: this.#source.namespaceDigest });
    const before = this.#identities.get(relative); let fd;
    this.#durable = null; this.#poisoned = true;
    try {
      this.#custody(); if (!stable(this.#stat(file), before)) throw new Error();
      fd = this.#io.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!stable(this.#io.fstatSync(fd, { bigint: true }), before)) throw new Error();
      const existing = Buffer.alloc(frame.length); let read = 0;
      while (read < existing.length) {
        const count = this.#io.readSync(fd, existing, read, existing.length - read, read);
        if (!Number.isSafeInteger(count) || count < 1 || count > existing.length - read) throw new Error(); read += count;
      }
      if (!existing.every(b => b === 0)) throw new Error();
      const write = (start, end) => {
        while (start < end) {
          const count = this.#io.writeSync(fd, frame, start, end - start, start);
          if (!Number.isSafeInteger(count) || count < 1 || count > end - start) throw new Error(); start += count;
        }
      };
      write(0, 128); this.#fault(`${slot.kind}:header-written`);
      write(128, 128 + slot.cap); this.#fault(`${slot.kind}:body-written`);
      this.#io.fsyncSync(fd); this.#fault(`${slot.kind}:body-flushed`);
      write(128 + slot.cap, frame.length); this.#fault(`${slot.kind}:trailer-written`);
      this.#io.fsyncSync(fd); this.#fault(`${slot.kind}:trailer-flushed`);
      if (!same(this.#io.fstatSync(fd, { bigint: true }), before) || !same(this.#stat(file), before)) throw new Error();
      const owned = fd; fd = undefined; this.#io.closeSync(owned);
      const after = this.#scan();
      // Revalidation must preserve every other exact immutable slot, even if a
      // concurrent/fault-injected rewrite could form another valid chain.
      for (const [entry, digest] of scan.slotHashes) {
        if (after.slotHashes.get(entry) !== (entry === relative ? hash(frame) : digest)) throw new Error();
      }
      this.#durable = after.fingerprint; this.#poisoned = false;
      return after;
    } finally { if (fd !== undefined) { const owned = fd; fd = undefined; this.#io.closeSync(owned); } }
  }
  #handle(scan, phase) {
    const p = scan.pending, record = p.record.record;
    const handle = Object.freeze({ transactionId: record.transactionId, revision: p.revision, recordDigest: p.record.payloadDigest, phase });
    this.#handles.set(handle, { fingerprint: scan.fingerprint, phase, used: false }); return handle;
  }
  #claim(handle, phase, scan) {
    const value = this.#handles.get(handle);
    if (!value || value.used || value.phase !== phase || value.fingerprint !== scan.fingerprint) fail('invalid-owner-enrollment-phase');
    value.used = true;
  }
  beginIntent(expectedHeadDigest, input) {
    return this.#run(() => {
      const record = Buffer.from(snapshotOwnerDecisionBytes(input)), r = decodeBrokerOwnerEnrollmentRecord(record);
      const scan = this.#scan(); this.#verified(scan);
      if (scan.pending) fail('owner-enrollment-pending');
      const prior = scan.entries.find(e => decodeBrokerOwnerEnrollmentRecord(e.record).record.transactionId === r.record.transactionId);
      if (prior) {
        if (!prior.record.equals(record) || r.record.previousDigest !== expectedHeadDigest) fail('owner-enrollment-conflict');
        return Object.freeze({ duplicate: true, revision: r.record.revision, transactionId: r.record.transactionId, recordDigest: r.sha256 });
      }
      if (scan.entries.length === 1024) fail('owner-enrollment-capacity');
      if (expectedHeadDigest !== (scan.chain?.headDigest ?? null) || r.record.previousDigest !== expectedHeadDigest
          || r.record.revision !== scan.entries.length + 1) fail('owner-enrollment-conflict');
      const candidate = this.#prospective(scan.entries, record);
      if (candidate.result.namespaceDigest !== this.#source.namespaceDigest || r.record.service.brokerUid !== this.#uid) fail('owner-enrollment-conflict');
      return this.#handle(this.#write(scan, slots[0], r.record.revision, record), 'intent');
    });
  }
  recordAudit(handle, input) {
    return this.#run(() => {
      const audit = Buffer.from(snapshotOwnerDecisionBytes(input)), scan = this.#scan(); this.#verified(scan);
      this.#claim(handle, 'intent', scan);
      if (!scan.pending || scan.pending.audit.state !== 'empty') fail('invalid-owner-enrollment-phase');
      this.#prospective(scan.entries, scan.pending.record.payload, audit);
      return this.#handle(this.#write(scan, slots[1], scan.pending.revision, audit), 'audit');
    });
  }
  confirm(handle, input) {
    return this.#run(() => {
      const confirmation = Buffer.from(snapshotOwnerDecisionBytes(input)), scan = this.#scan(); this.#verified(scan);
      this.#claim(handle, 'audit', scan);
      if (!scan.pending || scan.pending.audit.state === 'empty') fail('invalid-owner-enrollment-phase');
      validateBrokerOwnerEnrollmentChain([...scan.entries, { record: scan.pending.record.payload,
        audit: scan.pending.audit.payload, confirmation }]);
      return this.#view(this.#write(scan, slots[2], scan.pending.revision, confirmation));
    });
  }
  close() {
    if (this.#closed) return;
    this.#closed = true; let failure = false;
    for (const value of [...this.#dirs.values()]) {
      const fd = value.fd; value.fd = undefined;
      try { this.#io.closeSync(fd); } catch { failure = true; }
    }
    this.#dirs.clear();
    if (this.#lock !== undefined) { const fd = this.#lock; this.#lock = undefined;
      try { this.#io.closeSync(fd); } catch { failure = true; } }
    if (failure) { this.#poisoned = true; fail('owner-enrollment-storage-failed'); }
  }
}
