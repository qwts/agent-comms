// Fixed source provider never retains a lifetime JavaScript enrollment lock.
// Installed signed observer provenance is still unavailable. No caller paths,
// artifact selectors, environment override or fixture can activate this gate.
export const BROKER_OWNER_ENROLLMENT_ROOT = '/Library/Application Support/AgentComms/owner-enrollment';
export function openBrokerOwnerEnrollmentSource() {
  throw new Error('owner-observer-unavailable');
}
