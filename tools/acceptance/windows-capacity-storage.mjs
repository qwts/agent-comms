// Actual fixed candidate startup storage prefix. No function or source overrides.
import assert from 'node:assert/strict';

export async function probePinnedStorage(load, phase, registerCleanup) {
  phase('storage-imports');
  const [{ Broker }, { EventLog }, { assertLogFile }, channel, { brokerPaths }, { nextExpiry }] = await Promise.all([
    load('lib/broker.mjs'), load('lib/state.mjs'), load('lib/platform/account-isolation.mjs'),
    load('lib/platform/local-channel.mjs'), load('lib/paths.mjs'), load('lib/retention.mjs'),
  ]);
  const paths = brokerPaths();
  phase('storage-broker-construct');
  const broker = new Broker({ paths, mode: 'single-account' });
  registerCleanup(() => broker.stop()); // Before prepare can take a lock or fail.
  phase('storage-broker-constructed');
  phase('storage-prepare');
  const uid = channel.prepare(broker);
  phase('storage-prepared');
  phase('storage-log-construct');
  broker.log = new EventLog(paths.state);
  phase('storage-log-constructed');
  phase('storage-log-custody');
  assertLogFile(broker.log.file, uid);
  phase('storage-log-custody-checked');
  phase('storage-replay');
  broker.state = broker.log.replay();
  // A fresh namespace is required. The constructor's private expiry starts at
  // Infinity, matching #open's nextExpiry assignment for this empty replay.
  assert.equal(broker.state.seq, 0);
  assert.equal(nextExpiry(broker.state), Infinity);
  phase('storage-replayed');
  phase('storage-maintain');
  broker.maintain({ compact: true });
  phase('storage-maintained');
  phase('storage-ready');
  return { ready: true, startupStorageChecks: 6 };
}
