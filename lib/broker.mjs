// The machine broker (ADR-0006). One process owns the event log and answers
// paired accounts, and the owner's principal, on a Unix socket in the shared
// space; the owner approves pairings on an admin socket inside the broker's
// private state directory.

import { assertLogFile } from './platform/account-isolation.mjs';

import { CommsError, fail } from './errors.mjs';
import { brokerDiagnostic } from './diagnostics.mjs';
import { performance } from 'node:perf_hooks';
import { apply, emptyState, EventLog } from './state.mjs';
import { createChannels } from './broker/channels.mjs';
import { createChannelCensus } from './broker/channel-census.mjs';
import { CHANNEL_LIMITS } from './channel-state.mjs';
import { createCensus } from './broker/census.mjs';
import { createPrincipalTarget } from './broker/principal-target.mjs';
import { createOwnerDecisionIngress, isOwnerDecisionOperation } from './broker/owner-ingress.mjs';
import { createLaunch } from './broker/launch.mjs';
import { createA2AOutbound } from './broker/a2a-outbound.mjs';
import { createA2A } from './broker/a2a.mjs';
import { createTasks } from './broker/tasks.mjs';
import { createMailbox } from './broker/mailbox.mjs';
import { createPairing, systemUidOf } from './broker/pairing.mjs';
import {
  listen, prepare, removeStaleSocket, socketModeFor, stop,
} from './broker/server.mjs';
import { LIMITS } from './broker/shared.mjs';
import { createWatchDelivery } from './broker/watch.mjs';
import { nextExpiry, RETENTION_KEYS } from './retention.mjs';

export { LIMITS, sha256 } from './broker/shared.mjs';
export { systemUidOf } from './broker/pairing.mjs';

export class Broker {
  #pairing;
  #channels;
  #channelCensus;
  #mailbox;
  #tasks;
  #watches;
  #census;
  #principalTarget;
  #ownerDecisions;
  #launch;
  #a2a;
  #outbound;
  #maintenanceTimer;
  #nextExpiry = Infinity;
  #diagnostic;

  constructor({ paths, gid = null, mode = 'group', uidOf = systemUidOf, now = () => Date.now(), limits = LIMITS, daemonOperation = null, a2aOutbound = {}, diagnostic = brokerDiagnostic }) {
    this.#diagnostic = diagnostic;
    this.paths = paths;
    this.gid = gid;
    this.mode = mode;
    if (!['group', 'single-account'].includes(mode)) fail('usage', `unknown broker mode ${mode}`);
    this.uidOf = uidOf;
    this.now = () => Math.max(now(), this.state?.maintenanceTime ?? 0);
    if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some((key) => !Object.hasOwn(LIMITS, key))) fail('usage', 'limits must contain known broker limit names');
    this.limits = { ...LIMITS, ...limits };
    for (const key of [...RETENTION_KEYS, 'retainedPerMailbox', 'mailboxBytes', 'dedupeEntriesPerSender', 'dedupeBytesPerSender', 'maintenanceIntervalMs', 'compactAfterBytes', ...Object.keys(CHANNEL_LIMITS)]) {
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1) fail('usage', `${key} must be a positive safe integer`);
    }
    this.startedAt = now();
    this.log = null; // opened by start() once the state directory passes custody
    this.state = emptyState();
    this.watchers = new Map(); // agentId -> Set of sockets
    this.accountWatchers = new Map(); // account -> Set of account-watch sockets
    this.sendTimes = new Map(); // rate-limit key -> recent send times
    this.servers = [];
    this.connections = new Set();
    const commit = (record) => this.#commit(record);
    // Resolve collaborators lazily: pairing revokes watches, and watches read mailboxes.
    this.#watches = createWatchDelivery(this, () => this.#pairing, (agentId) => this.#mailbox.unacked(agentId), commit,
      (message) => this.#channels.wakeAllowed(message));
    this.daemonOperation = daemonOperation ?? ((request, socket, identity) => request.op === 'account-watch'
      ? this.#watches.accountWatch(request, socket, identity)
      : this.#watches.wakeReport(request, identity));
    this.#pairing = createPairing(this, commit, this.#watches);
    this.#ownerDecisions = createOwnerDecisionIngress({ broker: this, pairing: this.#pairing, watches: this.#watches });
    this.#mailbox = createMailbox(this, commit, this.#pairing, this.#watches);
    this.#channels = createChannels(this, commit, this.#mailbox, this.#watches);
    this.#channelCensus = createChannelCensus(this, this.#mailbox, this.#channels);
    this.#tasks = createTasks(this, commit, this.#mailbox, this.#pairing);
    this.#outbound = createA2AOutbound(this, commit, this.#mailbox, this.#tasks, a2aOutbound);
    this.#launch = createLaunch(this, commit, this.#pairing);
    this.#census = createCensus(this, this.#pairing);
    this.#principalTarget = createPrincipalTarget(this, this.#pairing);
  }

  async start() {
    this.#ownerDecisions.open();
    const uid = prepare(this);
    try {
      await this.#open(uid);
    } catch (error) {
      await this.stop(); // releases the lock so a corrected start can take it
      throw error;
    }
    return this;
  }

  async #open(uid) {
    const { socket, admin, state } = this.paths;
    this.log = new EventLog(state);
    assertLogFile(this.log.file, uid);
    this.state = this.log.replay();
    this.#nextExpiry = nextExpiry(this.state);
    this.maintain({ compact: true });
    this.#a2a = createA2A(this, (principal, request) =>
      this.#handle(this.#pairing.inboundRequest(principal, request)));
    await removeStaleSocket(socket);
    await removeStaleSocket(admin);
    this.servers.push(await listen(this, socket, (request, client, metadata) => this.#handle(request, client, metadata), socketModeFor(this.mode === 'single-account' ? null : this.gid), () => this.gid));
    this.servers.push(await listen(this, admin, (request) => {
      this.maintain();
      if (request.op?.startsWith('channel-')) return this.#channels.admin(request);
      return request.op?.startsWith('a2a-route-') ? this.#outbound.admin(request) : request.op?.startsWith('a2a-') ? this.#a2a.admin(request) : this.#pairing.handleAdmin(request);
    }, 0o600));
    await this.#a2a.start();
    this.#outbound.start();
    this.#maintenanceTimer = setInterval(() => {
      const started = performance.now();
      try { this.maintain(); } catch {
        this.reportDiagnostic(this.log.poisoned ? 'maintenance-storage' : 'maintenance-internal', Math.floor(performance.now() - started));
      }
    }, this.limits.maintenanceIntervalMs);
    this.#maintenanceTimer.unref();
  }

  reportDiagnostic(event, durationMs, count) {
    try { this.#diagnostic(event, durationMs, count); } catch { /* Diagnostics cannot change broker outcomes. */ }
  }

  async stop() {
    clearInterval(this.#maintenanceTimer);
    this.#ownerDecisions.close();
    await this.#outbound.stop();
    await this.#a2a?.stop();
    await stop(this);
  }

  #commit(record) {
    const started = performance.now();
    try { this.log.append(record); apply(this.state, record); }
    catch (error) { throw this.#storageFailure(error, 'storage-append', started); }
    if (record.message) this.#nextExpiry = Math.min(this.#nextExpiry, record.message.expiresAt, record.dedupeExpiresAt ?? Infinity);
    if (record.t.startsWith('channel-')) this.#nextExpiry = nextExpiry(this.state);
  }

  #storageFailure(cause, event, started) {
    this.log.poisoned = true;
    this.reportDiagnostic(event, Math.floor(performance.now() - started));
    const error = new CommsError('storage-failed', 'broker storage is uncertain; stop the broker, correct storage and restart to recover before retrying');
    error.cause = cause;
    return error;
  }

  maintain({ compact = false } = {}) {
    if (!this.log) return;
    if (this.log.poisoned) fail('storage-failed', 'broker storage is uncertain; correct storage and restart before retrying');
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) fail('internal', 'the broker clock is invalid');
    const due = at >= this.#nextExpiry || at - this.state.maintenanceTime >= this.limits.maintenanceIntervalMs;
    if (!due && !compact && this.log.tailBytes < this.limits.compactAfterBytes) return;
    const sizes = () => [this.state.messages.size, this.state.idempotency.size, this.state.expired.size,
      [...this.state.channels.values()].reduce((sum, channel) => sum + channel.members.length, 0)];
    const before = sizes();
    const oldGaps = new Map([...this.state.mailboxMeta].map(([id, position]) => [id, position.totalLoss]));
    this.#commit({ t: 'maintenance', at, policy: Object.fromEntries(RETENTION_KEYS.map((key) => [key, this.limits[key]])) });
    this.#nextExpiry = nextExpiry(this.state);
    const after = sizes();
    const removed = before.some((count, index) => count !== after[index]);
    for (const [id, position] of this.state.mailboxMeta) {
      if (position.totalLoss > (oldGaps.get(id) ?? 0)) this.#watches.gap(id);
    }
    if (compact || removed || this.log.tailBytes >= this.limits.compactAfterBytes) {
      const started = performance.now();
      try { this.log.compact(this.state); } catch (error) { throw this.#storageFailure(error, 'storage-compact', started); }
    }
  }

  #handle(request, socket, metadata) {
    this.maintain();
    if (isOwnerDecisionOperation(request.op)) return this.#ownerDecisions.handle(request, metadata);
    if (request.auth?.daemon !== undefined) {
      if (!['account-watch', 'wake-report', 'launch-result', 'launch-progress'].includes(request.op)) fail('unauthenticated', 'this operation does not accept daemon credentials');
      const identity = this.#pairing.daemon(request);
      if (request.op === 'launch-result') return this.#launch.result(request, identity);
      if (request.op === 'launch-progress') return this.#launch.progress(request, identity);
      return this.daemonOperation(request, socket, identity);
    }
    if (['account-watch', 'wake-report', 'launch-result', 'launch-progress'].includes(request.op)) fail('unauthenticated', 'this operation requires daemon credentials');
    switch (request.op) {
      case 'daemon-pair-request': return this.#pairing.pairRequest(request, 'daemon');
      case 'whoami': {
        const { account } = this.#pairing.account(request);
        const soul = this.#pairing.ownSoul(account, request.agentId, request.soulToken);
        this.#pairing.rememberVerification(soul);
        return { account, agentId: soul.agentId, verification: soul.verification };
      }
      case 'pair-request': return this.#pairing.pairRequest(request);
      case 'pair-status': {
        const { account, pairing } = this.#pairing.account(request, { allowPending: true });
        return { account, state: pairing.state };
      }
      case 'principal-pair-request': return this.#pairing.principalRequest(request);
      case 'join': return this.#pairing.join(request);
      case 'leave': return this.#pairing.leave(request);
      case 'peers': return this.#mailbox.peers(request);
      case 'launch': return this.#launch.launch(request);
      case 'launch-status': return this.#launch.status(request);
      case 'a2a-send': return this.#outbound.send(request);
      case 'a2a-outbound-show': return this.#outbound.show(request);
      case 'a2a-outbound-list': return this.#outbound.list(request);
      case 'a2a-cancel': return this.#outbound.cancel(request);
      case 'task-offer': return this.#tasks.offer(request);
      case 'task-accept': return this.#tasks.transition({ ...request, state: 'accepted' });
      case 'task-reject': return this.#tasks.transition({ ...request, state: 'rejected' });
      case 'task-cancel': return this.#tasks.transition({ ...request, state: 'canceled' });
      case 'task-update': return this.#tasks.transition(request);
      case 'task-invocation': return this.#tasks.invocation(request);
      case 'task-show': return this.#tasks.show(request);
      case 'task-list': return this.#tasks.list(request);
      case 'channel-create': return this.#channels.create(request);
      case 'channel-invite': return this.#channels.invite(request);
      case 'channel-invitations': return this.#channels.invitations(request);
      case 'channel-remove': return this.#channels.remove(request);
      case 'channel-permission': return this.#channels.permission(request);
      case 'channel-subscribe': return this.#channels.subscribe(request);
      case 'channel-unsubscribe': return this.#channels.unsubscribe(request);
      case 'channel-wake': return this.#channels.setWake(request);
      case 'channel-post': return this.#channels.post(request);
      case 'channel-census': return this.#channelCensus.census(request);
      case 'send': return this.#mailbox.send(request);
      case 'read': return this.#mailbox.read(request);
      case 'ack': return this.#mailbox.ack(request);
      case 'gap-ack': return this.#mailbox.ackGap(request);
      case 'message-status': return this.#mailbox.messageStatus(request);
      case 'watch': return this.#watches.watch(request, socket);
      case 'census': return this.#census.census(request);
      case 'health': return this.#census.health(request);
      case 'principal-target-check': return this.#principalTarget(request);
      default: return fail('unknown-operation', `unknown operation ${request.op}`);
    }
  }
}
