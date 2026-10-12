// Owner-admin storage only. Scope never inherits a legacy ownerOperations list.
import { ownerDecisionAccount, ownerDecisionSoul } from './owner-decision-identities.mjs';
import { ownerOperationList } from './owner-operation-grants.mjs';

export const OWNER_GRANT_LIMITS = Object.freeze({ entries: 32, soulsPerEntry: 32, totalSouls: 128, bytes: 16384 });
const invalid = () => { throw new Error('invalid scoped owner grants'); };
const selector = entry => JSON.stringify(entry.souls);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function ownerGrantList(value) {
  if (!Array.isArray(value) || value.length > OWNER_GRANT_LIMITS.entries) invalid();
  let totalSouls = 0;
  const entries = Array.from(value, entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).length !== 3 || !['account', 'souls', 'operations'].every(key => Object.hasOwn(entry, key))
        || !ownerDecisionAccount(entry.account)) invalid();
    let souls = entry.souls;
    if (souls !== '*') {
      if (!Array.isArray(souls) || !souls.length || souls.length > OWNER_GRANT_LIMITS.soulsPerEntry
          || Array.from(souls).some(soul => !ownerDecisionSoul(soul)) || new Set(souls).size !== souls.length) invalid();
      totalSouls += souls.length;
      if (totalSouls > OWNER_GRANT_LIMITS.totalSouls) invalid();
      souls = [...souls].sort();
    }
    // Alphabetical object keys define the canonical UTF-8 size calculation.
    return { account: entry.account, operations: ownerOperationList(entry.operations), souls };
  }).sort((a, b) => compare(a.account, b.account) || compare(selector(a), selector(b)));
  if (entries.some((entry, i) => i && entry.account === entries[i - 1].account && selector(entry) === selector(entries[i - 1]))
      || Buffer.byteLength(JSON.stringify(entries)) > OWNER_GRANT_LIMITS.bytes) invalid();
  return entries;
}

export function validateStoredOwnerGrants(principal) {
  if (principal.ownerGrants === undefined) return; // Absence authorizes zero.
  const canonical = ownerGrantList(principal.ownerGrants);
  if ((principal.state !== 'approved' && canonical.length)
      || canonical.some((entry, i) => {
        const stored = principal.ownerGrants[i];
        return entry.account !== stored.account || selector(entry) !== selector(stored)
          || JSON.stringify(entry.operations) !== JSON.stringify(stored.operations);
      })) invalid();
}
