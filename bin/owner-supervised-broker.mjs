#!/usr/bin/env node
// Dedicated immutable-distribution entrypoint; never selected by the ordinary CLI.
import { Broker } from '../lib/broker.mjs';
import { brokerPaths } from '../lib/paths.mjs';
import { acquireInheritedOwnerSession, bindInheritedOwnerSession } from '../lib/platform/owner-supervised-session.mjs';
let broker, session, stopping, idle, failed = false;
function stop(fatal = false) {
  failed ||= fatal;
  if (stopping) return stopping;
  clearInterval(idle);
  // Fatal channel loss must not leave ordinary ingress live behind a hanging
  // async stop. Hard exit terminates this owned process, not a durable-cleanup proof.
  const timer = setTimeout(() => process.exit(1), 2000);
  stopping = (async () => {
    try {
      if (broker) await broker.stop();
      session?.close();
      clearTimeout(timer);
      process.exit(failed ? 1 : 0);
    } catch {
      clearTimeout(timer);
      process.exit(1);
    }
  })();
  return stopping;
}
// Register before acquisition/startup awaits. Repeated signals retain failure.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stop(); });
try {
  if (process.argv.length !== 2) throw new Error('owner-supervised-session-unavailable');
  session = acquireInheritedOwnerSession();
  const config = session.configuration;
  const paths = brokerPaths({}, { sharedDir: config.sharedDir, brokerStateDir: config.brokerStateDir });
  broker = new Broker({ paths, gid: config.socketGroupGid, mode: 'group' });
  bindInheritedOwnerSession(broker, session);
  const scope = session.open();
  try { scope.observe(); } finally { scope.close(); }
  await broker.start();
  idle = setInterval(() => {
    try { session.checkIdle(); }
    catch { stop(true); }
  }, 100);
} catch {
  process.stderr.write('owner-supervised-broker-unavailable\n');
  await stop(true);
}
