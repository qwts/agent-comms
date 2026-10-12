import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { BROKER_ENROLLMENT_SLOTS, encodeBrokerOwnerEnrollmentFrame } from '../../lib/owner-enrollment-frame.mjs';
import { BROKER_ENROLLMENT_STORE_FORMAT } from '../../lib/broker/owner-enrollment-store.mjs';
const vectors = JSON.parse(fs.readFileSync(new URL('../fixtures/owner-decisions/broker-enrollment-v1.json', import.meta.url)));
export const namespaceDigest = vectors.namespaceDigest;
export const canonical = value => value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
export const bytes = value => Buffer.from(canonical(value));
export const hash = value => createHash('sha256').update(value).digest('hex');
export function triple(revision = 1, previousDigest = null, enrollmentDigest = null) {
  const record = JSON.parse(vectors.cases.find(v => v.name === (revision % 2 ? 'enrollment' : 'revocation')).canonical);
  record.service.brokerUid = process.getuid(); record.revision = revision; record.previousDigest = previousDigest;
  record.transactionId = `${revision.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
  if (revision % 2 === 0) record.enrollmentDigest = enrollmentDigest;
  return fromRecord(bytes(record));
}
export function fromRecord(record) {
  const r = JSON.parse(record), recordDigest = hash(record);
  const audit = bytes({ v: 1, kind: 'broker-owner-audit', namespaceDigest, revision: r.revision,
    recordDigest, transactionId: r.transactionId, decisionEvidenceDigest: r.decisionEvidenceDigest });
  return { record, audit, confirmation: bytes({ v: 1, kind: 'broker-owner-confirmation', namespaceDigest,
    revision: r.revision, recordDigest, auditDigest: hash(audit) }) };
}
export const slotPath = (root, revision, kind) => {
  const slot = BROKER_ENROLLMENT_SLOTS.find(s => s.kind === kind);
  return path.join(root, slot.directory, `${String(revision).padStart(4, '0')}.${{record:'record',audit:'audit',confirmation:'confirm'}[kind]}`);
};
export function seed(root, entry, revision) {
  for (const slot of BROKER_ENROLLMENT_SLOTS) fs.writeFileSync(slotPath(root, revision, slot.kind),
    encodeBrokerOwnerEnrollmentFrame(entry[slot.kind], { kind: slot.kind, revision, namespaceDigest }));
}
// Only tests provision disposable stores. Production open never provisions.
export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-owner-enrollment-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.journal-lock'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'format'), BROKER_ENROLLMENT_STORE_FORMAT, { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'source.record'), bytes({ v: 1, kind: 'broker-owner-enrollment-source', namespaceDigest,
    service: { platform: 'darwin', brokerUid: process.getuid() } }), { mode: 0o600 });
  for (const slot of BROKER_ENROLLMENT_SLOTS) {
    fs.mkdirSync(path.join(root, slot.directory), { mode: 0o700 });
    for (let revision = 1; revision <= 1024; revision++) fs.writeFileSync(slotPath(root, revision, slot.kind),
      Buffer.alloc(slot.cap + 256), { mode: 0o600 });
  }
  return root;
}
