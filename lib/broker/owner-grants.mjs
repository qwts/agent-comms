// Pure internal prerequisite, not a request handler or complete authorization.
import { ownerDecisionAccount, ownerDecisionSoul } from '../owner-decision-identities.mjs';
import { OWNER_OPERATIONS } from '../owner-operation-grants.mjs';
import { validateStoredOwnerGrants } from '../owner-scoped-grants.mjs';
import { covers } from './shared.mjs';

// `target` must come from independent authenticated account-daemon resolution.
// This function cannot establish that provenance from an ordinary object.
// Future routes must resolve it themselves, then recheck at durable release.
export function ownerGrantCovers(state, principalId, target, operation) {
  try {
    if (!target || !ownerDecisionAccount(target.account) || !ownerDecisionSoul(target.agentId)
        || !OWNER_OPERATIONS.includes(operation)) return false;
    const principal = state.principals.get(principalId);
    if (principal?.state !== 'approved' || state.pairings.get(target.account)?.state !== 'approved'
        || state.daemons.get(target.account)?.state !== 'approved') return false;
    validateStoredOwnerGrants(principal);
    if (!covers(principal.grant, target)) return false;
    return (principal.ownerGrants ?? []).some(entry => entry.account === target.account
      && (entry.souls === '*' || entry.souls.includes(target.agentId)) && entry.operations.includes(operation));
  } catch { return false; }
}
