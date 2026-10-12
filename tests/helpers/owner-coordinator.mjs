import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Broker } from '../../lib/broker.mjs';
import { createPairing } from '../../lib/broker/pairing.mjs';
import { createWatchDelivery } from '../../lib/broker/watch.mjs';
import { apply, EventLog } from '../../lib/state.mjs';
import { OwnerDecisionJournalStore as Store } from '../../lib/owner-decision-journal.mjs';
import { DisabledOwnerDecisionEnrollment as Enrollment } from '../../lib/broker/owner-enrollment.mjs';
import { createDisabledOwnerDecisionCoordinator as coordinator } from '../../lib/broker/owner-decisions.mjs';
import { decodeOwnerDecisionAction } from '../../lib/owner-decision-codec.mjs';
import { bytes, f, namespaceDigest } from './owner-decision-lifecycle.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
// Socket sinks and enrollment keys are deliberately synthetic. The actual
// pairing/admin/auth, watch-binding implementation and on-disk journal are used.
export class Sink extends EventEmitter {
  destroyed = false; writable = true; events = []; beforeWrite;
  write(line) { const event = JSON.parse(line); this.beforeWrite?.(event); this.events.push(event); return true; }
  destroy() { this.destroyed = true; this.writable = false; this.emit('close'); }
}
export function fixture(t, vector = f.positive[0], journalOptions = {}, coordinatorOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-owner-coordinator-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const action = JSON.parse(vector.actionJson), brokerKeys = coordinatorOptions.fixtureKeys?.broker ?? generateKeyPairSync('ed25519'),
    presenceKeys = coordinatorOptions.fixtureKeys?.presence ?? generateKeyPairSync('ed25519'), daemonKeys = generateKeyPairSync('ed25519');
  const fixtureNamespace = coordinatorOptions.fixtureKeys?.namespaceDigest ?? namespaceDigest;
  let milliseconds = vector.receiptPayload.iat * 1000;
  const broker = new Broker({ paths: { state: path.join(root, 'broker'), socket: path.join(root, 'broker.sock'),
    admin: path.join(root, 'admin.sock'), proofs: path.join(root, 'proofs') }, now: () => milliseconds });
  const log = new EventLog(broker.paths.state);
  const commit = record => { log.append(record); apply(broker.state, record); };
  const secret = 'synthetic-principal-credential', daemonSecret = 'synthetic-daemon-credential';
  for (const record of [
    { t: 'pair-request', account: action.account, hash: hash('synthetic-account'), uid: process.getuid(), code: 'ACCT', at: milliseconds },
    { t: 'pair-approve', account: action.account, at: milliseconds },
    { t: 'daemon-pair-request', account: action.account, hash: hash(daemonSecret), uid: process.getuid(), code: 'DAEM',
      publicKey: daemonKeys.publicKey.export({ type: 'spki', format: 'pem' }), at: milliseconds },
    { t: 'daemon-pair-approve', account: action.account, daemonEpoch: 1, at: milliseconds },
    { t: 'principal-request', principal: action.principal, account: 'native-owner', hash: hash(secret), code: 'PRIN', at: milliseconds },
    { t: 'principal-approve', principal: action.principal, grant: null, at: milliseconds },
    { t: 'principal-owner-grants', principal: action.principal,
      grants: [{ account: action.account, souls: [action.soul], operations: [action.operation] }], at: milliseconds },
  ]) commit(record);
  let pairing;
  const watches = createWatchDelivery(broker, () => pairing, () => [], commit);
  pairing = createPairing(broker, commit, watches);
  const auth = { principal: action.principal, secret }, daemonAuth = { daemon: action.account, secret: daemonSecret };
  const socket = new Sink(); t.after(() => socket.destroy());
  const attach = sink => {
    const request = { v: 1, op: 'account-watch', auth: daemonAuth };
    watches.accountWatch(request, sink, pairing.daemon(request)); return sink;
  };
  attach(socket);
  const enrollment = new Enrollment({ namespaceDigest: fixtureNamespace, service: { account: 'synthetic-broker', uid: process.getuid() } });
  enrollment.install({ revision: 1, brokerPrivateKey: brokerKeys.privateKey, presencePublicKey: presenceKeys.publicKey });
  const journalRoot = path.join(root, 'journal');
  fs.mkdirSync(journalRoot, { mode: 0o700 });
  const open = () => new Store(journalRoot, { namespaceDigest: fixtureNamespace, format: 'fixed-v1',
    lifecycle: { brokerPublicKeys: [brokerKeys.publicKey], presencePublicKeys: [presenceKeys.publicKey] },
    now: () => milliseconds, ...journalOptions });
  const journal = open();
  const options = { broker, pairing, watches, journal, enrollment, namespaceDigest: fixtureNamespace, syntheticFixture: true, ...coordinatorOptions };
  delete options.fixtureKeys;
  if (coordinatorOptions.makeSigningCapability) {
    options.signingCapability = coordinatorOptions.makeSigningCapability(enrollment);
    delete options.makeSigningCapability;
  }
  const core = coordinator(options);
  const prepareRequest = { v: 1, op: 'owner-decision-prepare', auth, requestId: action.requestId,
    account: action.account, soul: action.soul, operation: action.operation, parameters: action.parameters };
  const principal = (op, requestId = action.requestId) => ({ v: 1, op, auth, requestId });
  const binding = (requestId = action.requestId) => {
    const a = JSON.parse(journal.read(requestId).acceptanceBytes);
    return { requestId: a.requestId, payloadDigest: a.payloadDigest, daemonKey: a.daemonKey, daemonEpoch: a.daemonEpoch, watchId: a.watchId };
  };
  const prepare = (requestId = action.requestId) => core.prepare({ ...prepareRequest, requestId });
  const preparedRequest = (requestId = action.requestId) => {
    const at = Math.floor(milliseconds / 1000), p = action.parameters;
    return { v: 1, op: 'owner-decision-prepared', auth: daemonAuth, ...binding(requestId), nonce: randomBytes(32).toString('base64url'),
      preparedAt: at, exp: Math.min(at + 180, JSON.parse(journal.read(requestId).acceptanceBytes).acceptedAt + 180),
      stage: p.stagingId ? { stagingId: p.stagingId, kind: action.operation === 'cold-wake.set' ? 'webhook' : 'package',
        contentDigest: p.packageDigest ?? p.configurationDigest, expiresAt: at + 180 } : null };
  };
  let retainedPrepared;
  const prepared = (requestId = action.requestId) => { retainedPrepared = preparedRequest(requestId); return core.prepared(retainedPrepared); };
  const confirmRequest = (requestId = action.requestId) => {
    const row = journal.read(requestId), w = JSON.parse(row.slots.get('prepared-challenge'));
    const p = { v: 1, aud: 'agent-bot-owner', kind: 'presence', nonce: w.challenge.nonce,
      action: hash(decodeOwnerDecisionAction(row.actionBytes).actionText), iat: Math.floor(milliseconds / 1000), exp: Math.floor(milliseconds / 1000) + 120 };
    const segment = bytes(p).toString('base64url'), presence = `p1.${segment}.${sign(null, Buffer.from(segment), presenceKeys.privateKey).toString('base64url')}`;
    return { ...principal('owner-decision', requestId), payloadDigest: binding(requestId).payloadDigest, presence };
  };
  let retainedConfirm;
  const confirm = () => { retainedConfirm = confirmRequest(); return core.confirm(retainedConfirm); };
  const checkRequest = () => ({ v: 1, op: 'owner-decision-check', auth: daemonAuth, ...binding(),
    receiptDigest: hash(journal.read(action.requestId).slots.get('receipt')) });
  const check = () => core.check(checkRequest());
  return { root, journalRoot, broker, pairing, watches, journal, enrollment, options, core, action, socket, attach, open,
    auth, daemonAuth, brokerKeys, presenceKeys, commit, prepareRequest, principal, prepare, preparedRequest, prepared,
    confirmRequest, confirm, checkRequest, check, binding, get retainedPrepared() { return retainedPrepared; },
    get retainedConfirm() { return retainedConfirm; }, setTime(value) { milliseconds = value; }, advance(value) { milliseconds += value; } };
}
