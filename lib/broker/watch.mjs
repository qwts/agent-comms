// Live delivery and immediate watch shutdown when an account is revoked.
//
// Wake mode coalesces a burst into one signal (ADR-0004 decision 6). The
// mailbox is unchanged: the turn pages it with read. Full mode keeps one
// message event per message. A request that omits mode stays full, because
// today's inbox watch does not send one.
//
// account-watch is the account daemon's stream (ADR-0008 decision 7). It
// reuses this coalescer, one slot per soul, and fans the result in with the
// soul id and the message ids. Its own events are then spaced by wakeRateMs;
// a soul's inbox watch is not, so an R1 worker still sees a wake per window.

import { fail } from '../errors.mjs';
import { wakeEvent, writeLine } from '../wire.mjs';
import { STREAMING } from './server.mjs';

const OUTCOMES = new Set(['warm', 'cold', 'waiting', 'failed']);

export function createWatchDelivery(broker, pairing, unacked, commit) {
  const modes = new WeakMap(); // socket -> 'full' | 'wake'
  const pending = new Map(); // agentId -> { ids, timer }
  const held = new Map(); // agentId -> { ids, timer } account-watch rate limit
  const lastAccountWake = new Map(); // agentId -> Date.now() of the last account-watch event

  function modeOf(request) {
    if (request.mode === undefined) return 'full';
    if (request.mode === 'full' || request.mode === 'wake') return request.mode;
    return fail('bad-request', 'mode must be "full" or "wake"');
  }

  function bounded(value, fallback) {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  function windowMs() {
    return bounded(broker.limits.wakeWindowMs, 0);
  }

  function rateMs() {
    return bounded(broker.limits.wakeRateMs, 0);
  }

  function sendEvent(socket, value) {
    if (socket.destroyed) return;
    writeLine(socket, value);
  }

  function live(sockets) {
    return [...(sockets ?? [])].filter((socket) => !socket.destroyed);
  }

  function wakeSockets(agentId) {
    return live(broker.watchers.get(agentId)).filter((socket) => modes.get(socket) === 'wake');
  }

  function accountSockets(agentId) {
    const account = broker.state.souls.get(agentId)?.account;
    return account ? live(broker.accountWatchers.get(account)) : [];
  }

  function listening(agentId) {
    return wakeSockets(agentId).length > 0 || accountSockets(agentId).length > 0;
  }

  function clearPending(agentId) {
    const slot = pending.get(agentId);
    if (!slot) return;
    clearTimeout(slot.timer);
    pending.delete(agentId);
  }

  function clearHold(agentId) {
    const slot = held.get(agentId);
    if (!slot) return;
    clearTimeout(slot.timer);
    held.delete(agentId);
  }

  function remember(slot, ids) {
    for (const id of ids) if (!slot.ids.includes(id)) slot.ids.push(id);
  }

  // Ids from this burst that are still unacknowledged, in mailbox order.
  // `count` is that list's length: messages acked during the window are not
  // a turn, and the cursor stays the oldest unacked seq, which may be older
  // than this burst.
  function burst(agentId, ids) {
    const waiting = unacked(agentId);
    if (!waiting.length || !ids.length) return null;
    const wanted = new Set(ids);
    const messageIds = waiting.filter((message) => wanted.has(message.id)).map((message) => message.id);
    if (!messageIds.length) return null;
    return { messageIds, cursor: waiting[0].seq };
  }

  function deliverAccount(agentId, messageIds, cursor, sockets) {
    const event = { event: 'wake', agentId, count: messageIds.length, cursor, messageIds };
    for (const socket of sockets) sendEvent(socket, event);
    lastAccountWake.set(agentId, Date.now());
  }

  function release(agentId) {
    const slot = held.get(agentId);
    held.delete(agentId);
    if (!slot) return;
    const ready = burst(agentId, slot.ids);
    const sockets = accountSockets(agentId);
    if (!ready || !sockets.length) return;
    deliverAccount(agentId, ready.messageIds, ready.cursor, sockets);
  }

  // At most one account-watch wake per soul per wakeRateMs. A burst that
  // arrives inside the gap is appended and leaves on the same timer.
  function emitAccount(agentId, messageIds, cursor) {
    const sockets = accountSockets(agentId);
    if (!sockets.length || !messageIds.length) return;
    const limit = rateMs();
    const last = lastAccountWake.get(agentId);
    const wait = limit > 0 && last !== undefined ? Math.max(0, limit - (Date.now() - last)) : 0;
    if (wait > 0) {
      let slot = held.get(agentId);
      if (!slot) {
        slot = { ids: [], timer: setTimeout(() => release(agentId), wait) };
        slot.timer.unref();
        held.set(agentId, slot);
      }
      remember(slot, messageIds);
      return;
    }
    deliverAccount(agentId, messageIds, cursor, sockets);
  }

  function flush(agentId) {
    const slot = pending.get(agentId);
    pending.delete(agentId);
    if (!slot?.ids.length) return;
    const ready = burst(agentId, slot.ids);
    if (!ready) return;
    const event = wakeEvent(ready.messageIds.length, ready.cursor);
    for (const socket of wakeSockets(agentId)) sendEvent(socket, event);
    emitAccount(agentId, ready.messageIds, ready.cursor);
  }

  // Armed by the first message of a burst. Later messages only add ids, so
  // the burst starts one turn. The timer is not reset.
  function schedule(agentId, ids) {
    if (!ids.length) return;
    let slot = pending.get(agentId);
    if (!slot) {
      slot = { ids: [], timer: setTimeout(() => flush(agentId), windowMs()) };
      slot.timer.unref();
      pending.set(agentId, slot);
    }
    remember(slot, ids);
  }

  function watch(request, socket) {
    const { account } = pairing().account(request);
    const soul = pairing().joinedSoul(account, request.agentId, request.soulToken);
    const mode = modeOf(request);
    pairing().rememberVerification(soul);
    const set = broker.watchers.get(soul.agentId) ?? new Set();
    broker.watchers.set(soul.agentId, set);
    set.add(socket);
    modes.set(socket, mode);
    socket.on('close', () => {
      set.delete(socket);
      modes.delete(socket);
      if (!listening(soul.agentId)) clearPending(soul.agentId);
    });
    sendEvent(socket, { event: 'ready', address: `${account}/${soul.agentId}` });
    const waiting = unacked(soul.agentId);
    if (mode === 'full') {
      for (const message of waiting) sendEvent(socket, { event: 'message', message });
    } else if (waiting.length && !pending.has(soul.agentId)) {
      schedule(soul.agentId, waiting.map((message) => message.id));
    }
    return STREAMING;
  }

  function accountWatch(request, socket, { account }) {
    const set = broker.accountWatchers.get(account) ?? new Set();
    broker.accountWatchers.set(account, set);
    set.add(socket);
    socket.on('close', () => {
      set.delete(socket);
      if (set.size) return;
      broker.accountWatchers.delete(account);
      for (const soul of broker.state.souls.values()) {
        if (soul.account !== account) continue;
        clearHold(soul.agentId);
        if (!listening(soul.agentId)) clearPending(soul.agentId);
      }
    });
    // No address: the stream covers the account, and each wake names its soul.
    sendEvent(socket, { event: 'ready' });
    for (const soul of broker.state.souls.values()) {
      if (soul.account !== account || !soul.joined) continue;
      const waiting = unacked(soul.agentId);
      // Union into any open slot so a connect announces the backlog once,
      // including mail already waiting on a soul-watch window.
      if (waiting.length) schedule(soul.agentId, waiting.map((message) => message.id));
    }
    return STREAMING;
  }

  function wakeReport(request, { account }) {
    const { agentId, messageIds, outcome, detail } = request;
    const soul = pairing().soulForAccount(account, agentId);
    if (!OUTCOMES.has(outcome)) fail('bad-request', 'outcome must be "warm", "cold", "waiting", or "failed"');
    if (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.length > broker.limits.unackedPerMailbox
      || messageIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128)) {
      fail('bad-request', 'messageIds must be a non-empty list of message ids');
    }
    if (detail !== undefined && (typeof detail !== 'string' || detail.length > 500)) {
      fail('bad-request', 'detail must be a short string');
    }
    const mailbox = broker.state.mailboxes.get(soul.agentId) ?? [];
    const mine = new Set(mailbox);
    const recorded = [];
    const ignored = [];
    const seen = new Set();
    for (const id of messageIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (mine.has(id)) recorded.push(id);
      else ignored.push(id);
    }
    if (recorded.length) {
      commit({
        t: 'wake-outcome',
        account,
        agentId: soul.agentId,
        ids: recorded,
        outcome,
        ...(typeof detail === 'string' && detail.length ? { detail } : {}),
        at: broker.now(),
      });
    }
    return { recorded, ignored };
  }

  // Every account the broker can name, so status can say "not watching" as
  // well as "watching". Live sockets are the whole signal; the credential
  // map is only here so a paired daemon shows up before its first connect.
  function daemonWatches() {
    const accounts = new Set([...broker.state.daemons.keys(), ...broker.accountWatchers.keys()]);
    for (const soul of broker.state.souls.values()) accounts.add(soul.account);
    return {
      daemons: [...accounts].sort().map((account) => ({
        account,
        watching: live(broker.accountWatchers.get(account)).length > 0,
      })),
    };
  }

  function revoke(account) {
    // Cut the account off at once (ADR-0006 decision 3): close its open
    // watches now rather than when they next authenticate. The daemon stream
    // is the account's too.
    let closed = 0;
    for (const soul of broker.state.souls.values()) {
      if (soul.account !== account) continue;
      clearPending(soul.agentId);
      clearHold(soul.agentId);
      for (const socket of broker.watchers.get(soul.agentId) ?? []) {
        socket.destroy();
        closed += 1;
      }
      broker.watchers.delete(soul.agentId);
    }
    for (const socket of broker.accountWatchers.get(account) ?? []) {
      socket.destroy();
      closed += 1;
    }
    broker.accountWatchers.delete(account);
    return closed;
  }

  // Cut off the daemon credential alone: its account-watch streams close,
  // while the souls' own watches stay open because the account is still
  // approved. Approving a replacement daemon key runs this too, so a stream
  // opened with the old key does not outlive the rotation.
  function revokeDaemon(account) {
    const sockets = [...(broker.accountWatchers.get(account) ?? [])];
    broker.accountWatchers.delete(account);
    for (const socket of sockets) socket.destroy();
    for (const soul of broker.state.souls.values()) {
      if (soul.account !== account) continue;
      clearHold(soul.agentId);
      if (!listening(soul.agentId)) clearPending(soul.agentId);
    }
    return sockets.length;
  }

  function delivery(agentId) {
    const watchers = broker.watchers.get(agentId);
    // The soul's own sockets only. An open account-watch stays `waiting`
    // until the daemon reports what it actually did.
    const wake = watchers?.size ? 'warm' : 'waiting';
    return {
      wake,
      notify(message) {
        let coalesce = false;
        for (const socket of watchers ?? []) {
          if (modes.get(socket) === 'wake') coalesce = true;
          else sendEvent(socket, { event: 'message', message: { ...message, wake } });
        }
        if (coalesce || accountSockets(agentId).length) schedule(agentId, [message.id]);
      },
    };
  }

  return { watch, accountWatch, wakeReport, daemonWatches, revoke, revokeDaemon, delivery };
}
