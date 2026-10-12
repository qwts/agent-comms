// Calls the pinned public custody API; never replaces its subprocesses/checks.
export async function probePinnedCustody(load, mkdir, phase) {
  phase('custody-imports');
  const [{ createAccountIsolation }, { brokerPaths }] = await Promise.all([
    load('lib/platform/account-isolation.mjs'), load('lib/paths.mjs'),
  ]);
  const isolation = createAccountIsolation(), paths = brokerPaths();
  phase('custody-current-uid');
  const owner = isolation.currentUid();
  phase('custody-uid-checked');
  for (const [name, dir, code] of [['shared', paths.shared, 'shared-dir-untrusted'],
    ['proofs', paths.proofs, 'shared-dir-untrusted'], ['state', paths.state, 'state-dir-untrusted']]) {
    phase(`custody-${name}`);
    mkdir(dir, { recursive: true });
    isolation.assertOwnedDir(dir, owner, { code });
    phase(`custody-${name}-checked`);
  }
  phase('custody-ready');
  return { ready: true, startupCustodyChecks: 4 };
}
