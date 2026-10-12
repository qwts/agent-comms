// Actual Broker ingress; authority remains unsupported without the fixed
// production readiness producer. Never selects the synthetic coordinator.
import { fail } from '../errors.mjs';
import { receivedFrameBytes, receivedFrameUtf8Valid } from '../wire.mjs';
import { createProductionOwnerDecisionCoordinator, isDisabledOwnerDecisionCoordinator } from './owner-decisions.mjs';
import { createOwnerDecisionAdmissionLimiter } from './owner-admission.mjs';
import { ownerDecisionWireOperation } from '../owner-decision-wire-operations.mjs';
export { isOwnerDecisionOperation } from '../owner-decision-wire-operations.mjs';

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function createOwnerDecisionIngress({ broker, pairing, watches }) {
  return composeIngress({ broker, pairing, watches });
}
// Explicit test-only composition; the production factory cannot select this.
export function createDisabledOwnerDecisionIngressForTest({ broker, pairing, watches, fixtureCoordinator, syntheticFixture = false }) {
  if (!syntheticFixture || !isDisabledOwnerDecisionCoordinator(fixtureCoordinator))
    fail('owner-decision-unsupported', 'The owner-decision provider is unsupported.');
  return composeIngress({ broker, pairing, watches }, fixtureCoordinator);
}
function composeIngress({ broker, pairing, watches }, initial = null) {
  const limiter = createOwnerDecisionAdmissionLimiter();
  let closed = false, coordinator = initial;
  return Object.freeze({
    handle(request, metadata) {
      const spec = ownerDecisionWireOperation(request.op), length = receivedFrameBytes(metadata);
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
    close() { closed = true; coordinator?.close(); coordinator = null; limiter.close(); },
  });
}
