// Live delivery and immediate watch shutdown when an account is revoked.
//
// Wake mode coalesces a burst into one signal (ADR-0004 decision 6). The
// mailbox is unchanged: the turn pages it with read. Full mode keeps one
// message event per message. A request that omits mode stays full, because
// today's inbox watch does not send one.

import { fail } from '../errors.mjs';
import { wakeEvent, writeLine } from '../wire.mjs';
import { STREAMING } from './server.mjs';

export function createWatchDelivery(broker, pairing, unacked) {
  const modes = new WeakMap(); // socket -> 'full' | 'wake'
  const pending = new Map(); // agentId -> { count, timer }

  function modeOf(request) {
    if (request.mode === undefined) return 'full';
    if (request.mode === 'full' || request.mode === 'wake') return request.mode;
    return fail('bad-request', 'mode must be "full" or "wake"');
  }

  function windowMs() {
    const value = broker.limits.wakeWindowMs;
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  function sendEvent(socket, value) {
    if (socket.destroyed) return;
    writeLine(socket, value);
  }

  function wakeSockets(agentId) {
    return [...(broker.watchers.get(agentId) ?? [])].filter((socket) => modes.get(socket) === 'wake' && !socket.destroyed);
  }

  function clearPending(agentId) {
    const slot = pending.get(agentId);
    if (!slot) return;
    clearTimeout(slot.timer);
    pending.delete(agentId);
  }

  function flush(agentId) {
    const slot = pending.get(agentId);
    pending.delete(agentId);
    if (!slot?.count) return;
    const sockets = wakeSockets(agentId);
    if (!sockets.length) return;
    // Acked during the window: nothing left to pull, so no turn.
    const first = unacked(agentId)[0];
    if (!first) return;
    const event = wakeEvent(slot.count, first.seq);
    for (const socket of sockets) sendEvent(socket, event);
  }

  // Armed by the first message of a burst. Later messages only increment
  // the count, so the burst starts one turn.
  function schedule(agentId, count) {
    let slot = pending.get(agentId);
    if (!slot) {
      slot = { count: 0, timer: setTimeout(() => flush(agentId), windowMs()) };
      slot.timer.unref();
      pending.set(agentId, slot);
    }
    slot.count += count;
  }

  function watch(request, socket) {
    const { account } = pairing().account(request);
    const soul = pairing().joinedSoul(account, request.agentId);
    const mode = modeOf(request);
    const set = broker.watchers.get(soul.agentId) ?? new Set();
    broker.watchers.set(soul.agentId, set);
    set.add(socket);
    modes.set(socket, mode);
    socket.on('close', () => {
      set.delete(socket);
      modes.delete(socket);
      if (!wakeSockets(soul.agentId).length) clearPending(soul.agentId);
    });
    sendEvent(socket, { event: 'ready', address: `${account}/${soul.agentId}` });
    const waiting = unacked(soul.agentId);
    if (mode === 'full') {
      for (const message of waiting) sendEvent(socket, { event: 'message', message });
    } else if (waiting.length && !pending.has(soul.agentId)) {
      schedule(soul.agentId, waiting.length);
    }
    return STREAMING;
  }

  function revoke(account) {
    // Cut the account off at once (ADR-0006 decision 3): close its open
    // watches now rather than when they next authenticate.
    let closed = 0;
    for (const soul of broker.state.souls.values()) {
      if (soul.account !== account) continue;
      clearPending(soul.agentId);
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
        let coalesce = false;
        for (const socket of watchers ?? []) {
          if (modes.get(socket) === 'wake') coalesce = true;
          else sendEvent(socket, { event: 'message', message: { ...message, wake } });
        }
        if (coalesce) schedule(agentId, 1);
      },
    };
  }

  return { watch, revoke, delivery };
}
