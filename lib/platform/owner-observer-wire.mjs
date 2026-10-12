// Private observation codec. Fixture absence-of-OD receipts never become normal v2.
import path from 'node:path';
import schema from './owner-observer-schema.json' with { type: 'json' };
import { createHash, createPublicKey } from 'node:crypto';
const utf8 = b => new TextDecoder('utf-8', { fatal: true }).decode(b);
const fail = () => { throw new Error('owner-observer-unavailable'); };
const hash = b => createHash('sha256').update(b).digest('hex');
function decode(bytes, fixture) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 24576) fail();
  const value = JSON.parse(utf8(bytes));
  const keys = ['custodyFingerprint', 'kind', 'observationDigest', 'projection', 'v'];
  if (JSON.stringify(value) !== utf8(bytes) || Object.keys(value).join(',') !== keys.join(',')
      || value.v !== (fixture ? 1 : 2) || value.kind !== (fixture ? 'owner-enrollment-observation-fixture' : 'owner-enrollment-observation')
      || (typeof value.custodyFingerprint !== 'string' || value.custodyFingerprint.length !== 64 || !/^[a-f0-9]{64}$/.test(value.custodyFingerprint)) || !/^[a-f0-9]{64}$/.test(value.observationDigest)
      || typeof value.projection !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.projection)) fail();
  const projection = Buffer.from(value.projection, 'base64url');
  if (projection.length > 16384 || projection.toString('base64url') !== value.projection || hash(projection) !== value.observationDigest) fail();
  const outer = JSON.parse(utf8(projection));
  if (Object.keys(outer).join(',') !== 'installation,kind,pins,v' || outer.v !== 1 || outer.kind !== schema.projectionKind) fail();
  const installation = JSON.parse(outer.installation), pins = JSON.parse(outer.pins);
  if (installation.v !== 2 || installation.kind !== schema.installationKind
      || pins.v !== 2 || pins.kind !== schema.pinsKind
      || installation.namespaceDigest !== pins.namespaceDigest
      || installation.brokerEnrollmentHeadDigest !== pins.brokerEnrollmentHeadDigest
      || installation.brokerLocalRevision !== pins.brokerLocalRevision) fail();
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
  const canonical = v => v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : (typeof v === 'string' && Buffer.from(v).toString('utf8') !== v ? fail() : JSON.stringify(v));
  const hex = v => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/.test(v);
  const uid = v => Number.isSafeInteger(v) && v > 0 && v <= 0xffffffff;
  const guid = v => typeof v === 'string' && v.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
  const key = v => {
    if (!exact(v, 'alg,keyId,publicKey') || v.alg !== 'ed25519' || !hex(v.keyId)
        || typeof v.publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.publicKey)) return false;
    const raw = Buffer.from(v.publicKey, 'base64url');
    return raw.length === 32 && raw.toString('base64url') === v.publicKey
      && hash(Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])) === v.keyId;
  };
  if (canonical(outer) !== utf8(projection) || canonical(installation) !== outer.installation || canonical(pins) !== outer.pins
      || !exact(installation, 'v,kind,namespaceDigest,publicSocket,brokerUid,brokerAccountGuid,ownerUid,ownerAccountGuid,helperProtocol,helperService,helperIdentifier,brokerLocalRevision,brokerEnrollmentHeadDigest')
      || !exact(pins, 'v,kind,namespaceDigest,brokerLocalRevision,brokerEnrollmentHeadDigest,receiptKey,presenceKey,service')
      || !hex(pins.namespaceDigest) || !hex(pins.brokerEnrollmentHeadDigest)
      || !Number.isSafeInteger(pins.brokerLocalRevision) || pins.brokerLocalRevision < 1 || pins.brokerLocalRevision > 1023
      || !uid(installation.brokerUid) || installation.brokerUid !== process.getuid() || !uid(installation.ownerUid)
      || installation.ownerUid === installation.brokerUid || !guid(installation.ownerAccountGuid) || !guid(installation.brokerAccountGuid)
      || installation.ownerAccountGuid === installation.brokerAccountGuid || installation.helperProtocol !== 1
      || installation.helperService !== schema.helperService || installation.helperIdentifier !== schema.helperIdentifier
      || typeof installation.publicSocket !== 'string' || !path.isAbsolute(installation.publicSocket)
      || path.resolve(installation.publicSocket) !== installation.publicSocket || installation.publicSocket.includes('\0')
      || path.basename(installation.publicSocket) !== 'broker.sock' || installation.publicSocket.endsWith('/') || Buffer.byteLength(installation.publicSocket) > 1024
      || !key(pins.receiptKey) || !key(pins.presenceKey) || pins.receiptKey.keyId === pins.presenceKey.keyId
      || !exact(pins.service, 'platform,brokerUid') || pins.service.platform !== 'darwin' || pins.service.brokerUid !== installation.brokerUid) fail();
  return Object.freeze({ ...value, installation: Object.freeze(installation), pins: Object.freeze(pins) });
}
export function decodeNativeObservationV2(bytes) { try { return decode(bytes, false); } catch { fail(); } }
export function decodeFixtureObservationV1(bytes) { try { return decode(bytes, true); } catch { fail(); } }

export function observationSnapshot(value) {
  const { pins, installation } = value;
  const publicKey = key => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100','hex'), Buffer.from(key.publicKey,'base64url')]), format: 'der', type: 'spki' });
  return Object.freeze({ active: true, namespaceDigest: pins.namespaceDigest, revision: pins.brokerLocalRevision,
    brokerKey: pins.receiptKey.keyId, presenceKey: pins.presenceKey.keyId,
    brokerPublicKey: publicKey(pins.receiptKey), presencePublicKey: publicKey(pins.presenceKey),
    service: Object.freeze({ account: installation.brokerAccountGuid, uid: installation.brokerUid }),
    brokerEnrollmentHeadDigest: pins.brokerEnrollmentHeadDigest, observationDigest: value.observationDigest,
    custodyFingerprint: value.custodyFingerprint });
}
