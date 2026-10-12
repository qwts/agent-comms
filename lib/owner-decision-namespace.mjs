// Pure proposed derivation only. No bootstrap, enrollment, storage or authority.
import { createHash } from 'node:crypto';
import { snapshotOwnerDecisionBytes } from './owner-decision-canonical.mjs';
const domain = Buffer.from('agent-comms-owner-broker-namespace-v1\n', 'ascii');
export function deriveOwnerDecisionBrokerNamespace(installationIdBytes) {
  try {
    const id = snapshotOwnerDecisionBytes(installationIdBytes);
    if (id.length !== 32) throw new Error();
    return createHash('sha256').update(domain).update(id).digest('hex');
  } catch { throw new Error('invalid-owner-broker-namespace'); }
}
