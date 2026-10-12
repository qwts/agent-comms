// Dev-only fixed source approval. Never accepts a dispatch-supplied revision.
export const CORRECTED_STARTUP_SOURCE = Object.freeze({
  pin: '2d94b16a17f7d0a8625e6151e97fee844232aab1',
  tree: '9c1719821d656e17eb04dc477cc9415e4697f12f',
  archiveSha256: 'd3465c40e5e11561f22f3aa720f74146aa70b2091dcd09c34c1c4046daea6853',
});

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
  return Object.assign(new Error(allowedChecks.has(record.failure?.check) ? record.failure.check : 'job-supervisor-failed'),
    boundedBrokerCode(record.failure?.brokerCode) ? { brokerCode: record.failure.brokerCode } : {});
}
