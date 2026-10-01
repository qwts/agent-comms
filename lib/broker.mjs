// The machine broker (ADR-0006). One process owns the event log and answers
// paired accounts on a Unix socket in the shared space; the owner approves
// pairings on an admin socket inside the broker's private state directory.

import { lstatSync } from 'node:fs';

import { CommsError, fail } from './errors.mjs';
import { apply, emptyState, EventLog } from './state.mjs';
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
  #watches;

  constructor({ paths, gid = null, uidOf = systemUidOf, now = () => Date.now(), limits = LIMITS }) {
    this.paths = paths;
    this.gid = gid;
    this.uidOf = uidOf;
    this.now = now;
    this.limits = limits;
    this.log = null; // opened by start() once the state directory passes custody
    this.state = emptyState();
    this.watchers = new Map(); // agentId -> Set of sockets
    this.sendTimes = new Map(); // rate-limit key -> recent send times
    this.servers = [];
    this.connections = new Set();
    const commit = (record) => this.#commit(record);
    // Resolve collaborators lazily: pairing revokes watches, and watches read mailboxes.
    this.#watches = createWatchDelivery(this, () => this.#pairing, (agentId) => this.#mailbox.unacked(agentId));
    this.#pairing = createPairing(this, commit, this.#watches);
    this.#mailbox = createMailbox(this, commit, this.#pairing, this.#watches);
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
    try {
      const log = lstatSync(this.log.file);
      if (!log.isFile() || log.uid !== uid) fail('state-dir-untrusted', `${this.log.file} is not the broker's own file`);
    } catch (error) {
      if (error instanceof CommsError) throw error;
    }
    this.state = this.log.replay();
    await removeStaleSocket(socket);
    await removeStaleSocket(admin);
    this.servers.push(await listen(this, socket, (request, client) => this.#handle(request, client), socketModeFor(this.gid), () => this.gid));
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
    switch (request.op) {
      case 'pair-request': return this.#pairing.pairRequest(request);
      case 'pair-status': {
        const { account, pairing } = this.#pairing.account(request, { allowPending: true });
        return { account, state: pairing.state };
      }
      case 'join': return this.#pairing.join(request);
      case 'leave': return this.#pairing.leave(request);
      case 'peers': return this.#mailbox.peers(request);
      case 'send': return this.#mailbox.send(request);
      case 'read': return this.#mailbox.read(request);
      case 'ack': return this.#mailbox.ack(request);
      case 'watch': return this.#watches.watch(request, socket);
      default: return fail('unknown-operation', `unknown operation ${request.op}`);
    }
  }
}
