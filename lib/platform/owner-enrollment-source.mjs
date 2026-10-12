// Fixed read-only-open source location. No installer, runtime mkdir, caller
// paths, environment override, key load, signer or authority activation.
import { BrokerOwnerEnrollmentStore } from '../broker/owner-enrollment-store.mjs';
export const BROKER_OWNER_ENROLLMENT_ROOT = '/Library/Application Support/AgentComms/owner-enrollment';
export function openBrokerOwnerEnrollmentSource() {
  return new BrokerOwnerEnrollmentStore(BROKER_OWNER_ENROLLMENT_ROOT);
}
