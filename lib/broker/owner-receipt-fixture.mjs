// Explicit synthetic test capability. This is not a native custody provider.
// Production construction never imports a fixture instance or accepts a hook.
import { createHash } from 'node:crypto';
import { DisabledOwnerDecisionEnrollment } from './owner-enrollment.mjs';
import { issueOwnerDecisionReceipt } from '../owner-decision-issuer.mjs';
import { decodeOwnerDecisionCanonical } from '../owner-decision-canonical.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => { throw new Error('owner-receipt-unavailable'); };
export class SyntheticOwnerReceiptCapability {
  #enrollment; #beforeSign; #terminalConfirmed; #terminalReject; #safeClose;
  constructor(enrollment, { syntheticFixture = false, beforeSign = async () => {}, terminalConfirmed = true, terminalReject = false, safeClose = true } = {}) {
    if (!syntheticFixture || !(enrollment instanceof DisabledOwnerDecisionEnrollment) || typeof beforeSign !== 'function') invalid();
    this.#enrollment = enrollment; this.#beforeSign = beforeSign; this.#terminalConfirmed = terminalConfirmed === true; this.#terminalReject = terminalReject === true; this.#safeClose = safeClose === true;
  }
  observe() {
    const s = this.#enrollment.snapshot(); if (!s?.active) invalid();
    const fingerprint = hash(JSON.stringify([s.namespaceDigest, s.revision, s.brokerKey, s.presenceKey, s.service]));
    return Object.freeze({ active: true, namespaceDigest: s.namespaceDigest, revision: s.revision,
      brokerKey: s.brokerKey, presenceKey: s.presenceKey, service: s.service,
      brokerPublicKey: s.brokerPublicKey, presencePublicKey: s.presencePublicKey,
      brokerEnrollmentHeadDigest: fingerprint, observationDigest: fingerprint, custodyFingerprint: fingerprint, syntheticFixtureOnly: true });
  }
  startDecisionReceipt(command, { signal }) {
    // Separate owned terminal receipt: result settlement alone does not prove
    // native exit/descriptor cleanup. False terminal is a fixture fault only.
    const result = this.#issue(command, signal);
    const receipt = () => { if (this.#terminalReject) throw new Error('owner-receipt-unavailable'); return Object.freeze({ terminalConfirmed: this.#terminalConfirmed, safeClose: this.#safeClose }); };
    return Object.freeze({ result, terminal: result.then(receipt, receipt) });
  }
  async #issue(command, signal) {
    // The test hook may suspend/fail only this explicit synthetic producer. It
    // cannot authorize, supply public pins, or replace command interpretation.
    await this.#beforeSign(signal);
    if (signal.aborted) invalid();
    const names = ['v','op','namespaceDigest','brokerLocalRevision','brokerEnrollmentHeadDigest','observationDigest','prepared','originalAction','presence','iat','exp'];
    if (!command || Object.keys(command).length !== names.length || names.some(k => !Object.hasOwn(command, k))
        || command.v !== 1 || command.op !== 'issue-decision-receipt') invalid();
    const s = this.observe(), privateSnapshot = this.#enrollment.snapshot();
    if (command.namespaceDigest !== s.namespaceDigest || command.brokerLocalRevision !== s.revision
        || command.brokerEnrollmentHeadDigest !== s.brokerEnrollmentHeadDigest || command.observationDigest !== s.observationDigest) invalid();
    const preparedBytes = Buffer.from(command.prepared, 'base64url');
    const c = decodeOwnerDecisionCanonical(preparedBytes).challenge;
    const issued = issueOwnerDecisionReceipt({ preparedBytes,
      saved: { originalActionBytes: Buffer.from(command.originalAction, 'base64url'), acceptedAt: c.acceptedAt,
        daemonKey: c.daemonKey, daemonEpoch: c.daemonEpoch, watchId: c.watchId },
      presenceToken: command.presence, presencePublicKey: s.presencePublicKey,
      brokerPrivateKey: privateSnapshot.brokerPrivateKey, nowMilliseconds: command.iat * 1000 });
    if (issued.payload.exp !== command.exp || issued.payload.iat !== command.iat) invalid();
    return { signature: Buffer.from(issued.receiptToken.split('.')[2], 'base64url') };
  }
}
