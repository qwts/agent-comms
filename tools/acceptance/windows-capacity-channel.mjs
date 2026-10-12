// Actual pinned default channel exports; no injected connector or source patch.
export async function probePinnedChannel(load, phase, registerCleanup) {
  phase('channel-imports');
  const [channel, { brokerPaths }] = await Promise.all([
    load('lib/platform/local-channel.mjs'), load('lib/paths.mjs'),
  ]);
  const paths = brokerPaths();
  // Only the fields used by default prepare/stop; no Broker or listener exists.
  const context = { paths, mode: 'single-account', servers: [], connections: new Set(),
    watchers: new Map(), accountWatchers: new Map() };
  registerCleanup(() => channel.stop(context));
  phase('channel-prepare');
  channel.prepare(context);
  phase('channel-prepared');
  phase('channel-stale-main');
  await channel.removeStaleSocket(paths.socket);
  phase('channel-stale-main-checked');
  phase('channel-stale-admin');
  await channel.removeStaleSocket(paths.admin);
  phase('channel-stale-admin-checked');
  phase('channel-ready');
  return { ready: true, startupChannelChecks: 3 };
}
