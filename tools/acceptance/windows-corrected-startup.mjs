import { preserveWindowsPipeStage } from '../../lib/platform/windows-pipe-stage.mjs';
// Dev-only fixed source approval. Never accepts a dispatch-supplied revision.
export const CORRECTED_STARTUP_SOURCE = Object.freeze({
  pin: 'cb50469ca0b6757c4ab860de582b9b140fc525a0',
  tree: '34011276c3e651e6fd5bf7ba1e7c7f373053249e',
  archiveSha256: '1fd8baf80dc140cf6b4cc5e13f84ff3711230b50a93de9be6d34a2b3b93c4ba1',
});

// Git archive applies checkout conversion unless explicitly disabled.
export function canonicalCandidateArchiveArgs(pin) {
  return ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', pin];
}

export function verifyCandidateComponent(observedHash, expectedHash) {
  if (observedHash !== expectedHash) throw new Error('candidate-source-mismatch');
}

export function verifyCorrectedStartupSource(tree, archiveSha256) {
  if (tree !== CORRECTED_STARTUP_SOURCE.tree || archiveSha256 !== CORRECTED_STARTUP_SOURCE.archiveSha256) {
    throw new Error('candidate-source-mismatch');
  }
  return { ...CORRECTED_STARTUP_SOURCE };
}

// Preserve actionable production refusals, never their messages, paths or cause.
export function boundedBrokerCode(value) {
  return ['broker-running','broker-timeout','broker-probe-failed','broker-unreachable','broker-untrusted',
    'state-dir-untrusted','storage-failed','unauthenticated','permission-denied'].includes(value) ? value : undefined;
}

export function classifyFixtureFailure(record, allowedChecks) {
  return preserveWindowsPipeStage(Object.assign(new Error(allowedChecks.has(record.failure?.check) ? record.failure.check : 'job-supervisor-failed'),
    boundedBrokerCode(record.failure?.brokerCode) ? { brokerCode: record.failure.brokerCode } : {}), record.failure);
}
