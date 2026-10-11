// Narrow the existing principal owner check to its command's soul target.
// This is a current-grant query, not an owner-decision receipt or relay.
import { fail } from '../errors.mjs';
import { covers } from './shared.mjs';

const AGENT_ID = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createPrincipalTarget(broker, pairing) {
  return (request) => {
    const { principal, pairing: { grant } } = pairing.principal(request);
    if (pairing.isInbound(request)) fail('unauthenticated', 'this operation requires a presented principal credential');
    // An account supplied by a client cannot establish the soul's ownership.
    if (request.account !== undefined || request.sender !== undefined
      || typeof request.agentId !== 'string' || !AGENT_ID.test(request.agentId)) {
      fail('bad-request', 'principal-target-check requires only a valid target agentId');
    }
    const soul = broker.state.souls.get(request.agentId);
    if (soul) {
      // A left soul retains its account binding. Revocation must not turn a
      // known soul into the account-independent, pre-join case below.
      if (broker.state.pairings.get(soul.account)?.state !== 'approved' || !covers(grant, soul)) {
        fail('unauthorized-target', 'this principal does not authorize the requested target');
      }
    } else if (grant !== null && !grant.includes(request.agentId)) {
      // Existing null and bare-ID grants do not depend on an account. An
      // account/address grant cannot establish ownership before the first join.
      fail('unauthorized-target', 'this principal does not authorize the requested target');
    }
    return { principal, agentId: request.agentId, account: soul?.account ?? null };
  };
}
