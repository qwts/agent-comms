// Fixed production readiness inspection. No request/config flag selects keys,
// trust records, arbitrary paths, synthetic enrollment or physical support.
import * as fs from 'node:fs';
import os from 'node:os';
import { createOwnerJournalNativeBridge } from './owner-journal-native.mjs';

export function ownerDecisionReadiness(broker) {
  const platformSupported = process.platform === 'darwin';
  let separateServiceAccount = false, nativeArtifactAvailable = false;
  if (platformSupported && broker.mode === 'group') {
    try {
      const uid = process.getuid(), state = fs.lstatSync(broker.paths.state);
      // Paired account UIDs are kernel-stamped by ordinary pairing. No paired
      // soul account may share the service UID. This is necessary, insufficient
      // evidence: the reviewed installation producer is still unavailable.
      separateServiceAccount = uid > 0 && uid <= 0xffffffff && state.isDirectory()
        && !state.isSymbolicLink() && state.uid === uid && (state.mode & 0o7777) === 0o700
        && ![...broker.state.pairings.values()].some(row => row.uid === uid)
        && ![...broker.state.souls.values()].some(row => row.account === os.userInfo().username);
      createOwnerJournalNativeBridge(); nativeArtifactAvailable = true;
    } catch { /* Unavailable evidence refuses support, without provider text. */ }
  }
  return Object.freeze({ supported: false, platformSupported, separateServiceAccount,
    nativeArtifactAvailable, protectedProducerAvailable: false, physicalAllocationSupported: false });
}
