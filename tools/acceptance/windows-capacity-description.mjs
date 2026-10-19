// Priority is explicit: specialized candidates precede their shared startup flag.
export function capacityScope({ relayCandidateStartup, desktopContext, candidateChannel, candidateStorage, candidateStartup, connectorOnly, channelOnly, custodyOnly, startupOnly }) {
  if (relayCandidateStartup && desktopContext) return 'current standard-user desktop fixed prebuilt-relay source Broker startup, pairing, one delivery and disposal only; no offered-rate or installed-host acceptance';
  if (relayCandidateStartup) return 'hosted standard-user fixed prebuilt-relay source Broker startup, pairing, one delivery and disposal; no offered-rate, desktop or installed-host acceptance';
  if (desktopContext) return 'current standard-user desktop exact corrected-source Broker startup, one delivery and disposal only; no offered-rate or installed-host acceptance';
  if (candidateChannel) return 'hosted standard-user exact corrected-source channel-prepare-and-stale-probes only; actual default channel; no Broker.start, EventLog, replay, maintenance, listeners, delivery or offered rates';
  if (candidateStorage) return 'hosted standard-user exact corrected-source fresh storage prefix only; actual prepare, EventLog custody/replay and compacting maintenance; no Broker.start, stale probes, listeners, delivery or offered rates';
  if (candidateStartup) return 'hosted standard-user exact corrected-source Broker startup, one delivery and disposal only; no offered-rate stages, capacity comparison, desktop or host acceptance';
  if (connectorOnly) return 'actual-connector-events; prepare/main stale probe then unconsumed admin connector; no Broker, listener, EventLog, replay, maintenance or workload';
  if (channelOnly) return 'channel-prepare-and-stale-probes; actual pinned default channel; no Broker, listener, EventLog, replay, maintenance or workload';
  if (custodyOnly) return 'hosted standard-user Windows pinned custody API only; no Broker or connector or offered-rate stages';
  if (startupOnly) return 'hosted standard-user Windows old-pin production startup and disposal only; no offered-rate stages or capacity acceptance';
  return 'hosted standard-user Windows finite capacity pilot; no benchmark, desktop, host or 100/s support acceptance';
}

export function capacityDeployment({ relayCandidate, preflight }) {
  if (relayCandidate) return 'one embedded production Broker/client; Identification prebuilt .NET relay';
  if (preflight === 'storage') return 'actual corrected-source fresh Broker storage prefix; no Broker.start, stale probes, listeners, A2A startup or delivery';
  if (preflight === 'connector') return 'actual pinned connector lifecycle events; no Broker, listener, EventLog, replay, maintenance or workload';
  if (preflight === 'channel') return 'channel-prepare-and-stale-probes; no Broker, listener, EventLog, replay, maintenance or workload';
  if (preflight === 'custody') return 'actual pinned account custody API only; no Broker or connector';
  return 'one embedded production Broker/client; Identification PowerShell connector';
}
