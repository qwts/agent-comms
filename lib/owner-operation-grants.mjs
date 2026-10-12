// Explicit owner-operation grants. Target grants remain a separate requirement.
export const OWNER_OPERATIONS = Object.freeze([
  'cold-wake.set', 'revision.adopt', 'revision.approve', 'revision.edit', 'revision.reject',
]);
export function ownerOperationList(value) {
  if (!Array.isArray(value) || value.length > OWNER_OPERATIONS.length) throw new Error('invalid owner operation grant');
  const seen = new Set();
  for (const operation of value) {
    if (!OWNER_OPERATIONS.includes(operation) || seen.has(operation)) throw new Error('invalid owner operation grant');
    seen.add(operation);
  }
  return [...seen].sort();
}
export function validateStoredOwnerOperations(principal) {
  if (principal.ownerOperations === undefined) return; // Legacy principals inherit no power.
  const canonical = ownerOperationList(principal.ownerOperations);
  if (canonical.some((value, index) => value !== principal.ownerOperations[index])
      || (principal.state !== 'approved' && canonical.length)) throw new Error('invalid stored owner operation grant');
}
