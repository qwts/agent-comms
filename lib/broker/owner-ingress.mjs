// Actual Broker ingress; authority remains unsupported without the fixed
// production readiness producer. Never selects the synthetic coordinator.
import { fail } from '../errors.mjs';
import { receivedFrameBytes, receivedFrameUtf8Valid } from '../wire.mjs';
import { createProductionOwnerDecisionCoordinator } from './owner-decisions.mjs';
import { createOwnerDecisionAdmissionLimiter } from './owner-admission.mjs';

const operations = new Map([
  ['owner-decision-prepare', ['principal', 'prepare', ['requestId', 'account', 'soul', 'operation', 'parameters']]],
  ['owner-decision', ['principal', 'confirm', ['requestId', 'payloadDigest', 'presence']]],
  ['owner-decision-status', ['principal', 'status', ['requestId']]],
  ['owner-decision-cancel', ['principal', 'cancel', ['requestId']]],
  ...[['owner-decision-prepared', 'prepared', ['nonce', 'preparedAt', 'exp', 'stage']],
    ['owner-decision-check', 'check', ['receiptDigest']],
    ['owner-decision-result', 'result', ['receiptDigest', 'state', 'outcome', 'reconciliation']]]
    .map(([op, method, extra]) => [op, ['daemon', method, ['requestId', 'payloadDigest', 'daemonKey', 'daemonEpoch', 'watchId', ...extra]]]),
]);
export const isOwnerDecisionOperation = op => operations.has(op);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function createOwnerDecisionIngress({ broker, pairing, watches }) {
  const limiter = createOwnerDecisionAdmissionLimiter();
  let closed = false, coordinator = null;
  return Object.freeze({
    handle(request, metadata) {
      const spec = operations.get(request.op), length = receivedFrameBytes(metadata);
      if (!spec || length === null || length > 32768 || !receivedFrameUtf8Valid(metadata)) fail('bad-request', 'The owner-decision frame is invalid.');
      const [kind, method, fields] = spec;
      if (!exact(request.auth, [kind, 'secret'])) fail('unauthenticated', 'This owner operation requires its presented credential kind.');
      const identity = kind === 'principal' ? pairing.principal(request) : pairing.daemon(request);
      if (kind === 'principal' && pairing.isInbound(request)) fail('unauthenticated', 'A presented principal credential is required.');
      if (!exact(request, ['v', 'op', 'auth', ...fields]) || request.v !== 1) fail('bad-request', 'The owner-decision input is invalid.');
      if (closed) fail('owner-decision-unsupported', 'The owner-decision provider is unsupported.');
      if (method === 'prepare') limiter.admit(identity.principal, request.account);
      // No request supplies a key/provider/journal or readiness override. The
      // production factory is presently fail-closed and creates no journal.
      coordinator ??= createProductionOwnerDecisionCoordinator({ broker, pairing, watches });
      return coordinator[method](request);
    },
    open() { closed = false; },
    close() { closed = true; coordinator = null; limiter.close(); },
  });
}
