// The machine broker (ADR-0006). One process owns the event log and answers
// paired accounts, and the owner's principal, on a Unix socket in the shared
// space; the owner approves pairings on an admin socket inside the broker's
// private state directory.

import { assertLogFile } from './platform/account-isolation.mjs';

import { fail } from './errors.mjs';
import { apply, emptyState, EventLog } from './state.mjs';
import { createCensus } from './broker/census.mjs';
import { createLaunch } from './broker/launch.mjs';
import { createTasks } from './broker/tasks.mjs';
import { createMailbox } from './broker/mailbox.mjs';
import { createPairing, systemUidOf } from './broker/pairing.mjs';
import {
  listen, prepare, removeStaleSocket, socketModeFor, stop,
} from './broker/server.mjs';
import { LIMITS } from './broker/shared.mjs';
import { createWatchDelivery } from './broker/watch.mjs';

export { LIMITS, sha256 } from './broker/shared.mjs';
export { systemUidOf } from './broker/pairing.mjs';

export class Broker {
  #pairing;
  #mailbox;
  #tasks;
  #watches;
  #census;
  #launch;

  constructor({ paths, gid = null, mode = 'group', uidOf = systemUidOf, now = () => Date.now(), limits = LIMITS, daemonOperation = null }) {
    this.paths = paths;
    this.gid = gid;
    this.mode = mode;
    if (!['group', 'single-account'].includes(mode)) fail('usage', `unknown broker mode ${mode}`);
    this.uidOf = uidOf;
    this.now = now;
    this.limits = limits;
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
    this.#watches = createWatchDelivery(this, () => this.#pairing, (agentId) => this.#mailbox.unacked(agentId), commit);
    this.daemonOperation = daemonOperation ?? ((request, socket, identity) => request.op === 'account-watch'
      ? this.#watches.accountWatch(request, socket, identity)
      : this.#watches.wakeReport(request, identity));
    this.#pairing = createPairing(this, commit, this.#watches);
    this.#mailbox = createMailbox(this, commit, this.#pairing, this.#watches);
    this.#tasks = createTasks(this, commit, this.#mailbox);
    this.#launch = createLaunch(this, commit, this.#pairing);
    this.#census = createCensus(this, this.#pairing);
  }

  async start() {
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
    await removeStaleSocket(socket);
    await removeStaleSocket(admin);
    this.servers.push(await listen(this, socket, (request, client) => this.#handle(request, client), socketModeFor(this.mode === 'single-account' ? null : this.gid), () => this.gid));
    this.servers.push(await listen(this, admin, (request) => this.#pairing.handleAdmin(request), 0o600));
  }

  async stop() {
    await stop(this);
  }

  #commit(record) {
    this.log.append(record);
    apply(this.state, record);
  }

  #handle(request, socket) {
    if (request.auth?.daemon !== undefined) {
      if (!['account-watch', 'wake-report', 'launch-result'].includes(request.op)) fail('unauthenticated', 'this operation does not accept daemon credentials');
      const identity = this.#pairing.daemon(request);
      if (request.op === 'launch-result') return this.#launch.result(request, identity);
      return this.daemonOperation(request, socket, identity);
    }
    if (['account-watch', 'wake-report', 'launch-result'].includes(request.op)) fail('unauthenticated', 'this operation requires daemon credentials');
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
      case 'task-offer': return this.#tasks.offer(request);
      case 'task-accept': return this.#tasks.transition({ ...request, state: 'accepted' });
      case 'task-reject': return this.#tasks.transition({ ...request, state: 'rejected' });
      case 'task-cancel': return this.#tasks.transition({ ...request, state: 'canceled' });
      case 'task-update': return this.#tasks.transition(request);
      case 'task-show': return this.#tasks.show(request);
      case 'task-list': return this.#tasks.list(request);
      case 'send': return this.#mailbox.send(request);
      case 'read': return this.#mailbox.read(request);
      case 'ack': return this.#mailbox.ack(request);
      case 'watch': return this.#watches.watch(request, socket);
      case 'census': return this.#census.census(request);
      case 'health': return this.#census.health(request);
      default: return fail('unknown-operation', `unknown operation ${request.op}`);
    }
  }
}
