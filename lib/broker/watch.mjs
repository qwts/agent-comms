// Live delivery and immediate watch shutdown when an account is revoked.

import { writeLine } from '../wire.mjs';
import { STREAMING } from './server.mjs';

export function createWatchDelivery(broker, pairing, unacked) {
  function watch(request, socket) {
    const { account } = pairing().account(request);
    const soul = pairing().joinedSoul(account, request.agentId);
    const set = broker.watchers.get(soul.agentId) ?? new Set();
    broker.watchers.set(soul.agentId, set);
    set.add(socket);
    socket.on('close', () => set.delete(socket));
    writeLine(socket, { event: 'ready', address: `${account}/${soul.agentId}` });
    for (const message of unacked(soul.agentId)) writeLine(socket, { event: 'message', message });
    return STREAMING;
  }

  function revoke(account) {
    // Cut the account off at once (ADR-0006 decision 3): close its open
    // watches now rather than when they next authenticate.
    let closed = 0;
    for (const soul of broker.state.souls.values()) {
      if (soul.account !== account) continue;
      for (const socket of broker.watchers.get(soul.agentId) ?? []) {
        socket.destroy();
        closed += 1;
      }
      broker.watchers.delete(soul.agentId);
    }
    return closed;
  }

  function delivery(agentId) {
    const watchers = broker.watchers.get(agentId);
    const wake = watchers?.size ? 'warm' : 'waiting';
    return {
      wake,
      notify(message) {
        for (const socket of watchers ?? []) writeLine(socket, { event: 'message', message: { ...message, wake } });
      },
    };
  }

  return { watch, revoke, delivery };
}
