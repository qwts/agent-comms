// The owner's read of the hub (ADR-0007 decisions 1 and 9): one census row per
// soul the principal's grant covers, plus broker health beside it. Both are
// reads; a principal credential carries no sending authority in R1.

import { statSync } from 'node:fs';

export function createCensus(broker, pairing) {
  function covers(grant, soul) {
    if (grant === null) return true;
    return grant.some((entry) => entry === soul.account || entry === soul.agentId
      || entry === `${soul.account}/${soul.agentId}`);
  }

  function presence(soul) {
    // A soul whose account pairing is gone can no longer read, watch, or be
    // sent to, so it is not present however its last join record reads
    // (ADR-0006 decision 3).
    if (!soul.joined || broker.state.pairings.get(soul.account)?.state !== 'approved') return 'left';
    return broker.watchers.get(soul.agentId)?.size ? 'watching' : 'joined';
  }

  function unacked(agentId) {
    const acked = broker.state.acked.get(agentId);
    return broker.state.mailboxes.get(agentId).filter((id) => !acked.has(id)).length;
  }

  // The wake outcome recorded when the mailbox's newest message was delivered,
  // acknowledged or not: it is the last time the broker tried to wake the soul.
  function lastWake(agentId) {
    const newest = broker.state.mailboxes.get(agentId).at(-1);
    return newest === undefined ? null : broker.state.wakes.get(newest) ?? null;
  }

  function census(request) {
    const { pairing: { grant } } = pairing.principal(request);
    // Filter before building anything, so a soul outside the grant leaves no
    // trace, not even a count (ADR-0003 decision 7). Subagents are rows like
    // any other and carry their parent; nesting is the reader's to draw.
    const souls = [...broker.state.souls.values()]
      .filter((soul) => covers(grant, soul))
      .map((soul) => ({
        account: soul.account,
        hardened: broker.state.hardened.has(soul.account),
        verification: soul.verification ?? 'claimed',
        agentId: soul.agentId,
        name: soul.name,
        harness: soul.harness,
        parent: soul.parent,
        presence: presence(soul),
        unacked: unacked(soul.agentId),
        lastWake: lastWake(soul.agentId),
      }));
    return { souls };
  }

  function health(request) {
    // Health is not public either: it counts pairings, so it needs the same
    // credential census does, and its answer carries no grant to filter by.
    pairing.principal(request);
    let eventLogBytes = 0;
    try {
      eventLogBytes = statSync(broker.log.file).size;
    } catch {
      // start() opens the log; before that there is nothing to measure
    }
    let watches = 0;
    for (const sockets of broker.watchers.values()) watches += sockets.size;
    return {
      uptimeMs: broker.now() - broker.startedAt,
      eventLogBytes,
      pairings: { accounts: broker.state.pairings.size, principals: broker.state.principals.size },
      watches,
    };
  }

  return { census, health };
}
