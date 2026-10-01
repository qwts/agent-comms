// Where the broker and its clients keep things. Environment overrides exist
// for embedded hosts and isolated brokers; defaults use the ENG-0339 shared
// space and each account's own state directory.

import { readHostConfig } from './host-config.mjs';
import path from 'node:path';

export function brokerPaths(env = process.env, host = readHostConfig(env)) {
  const shared = host.sharedDir;
  const state = host.brokerStateDir;
  return {
    shared,
    socket: path.join(shared, 'broker.sock'),
    // Sticky and world-writable, like /tmp: anyone may drop a pairing proof,
    // nobody may remove another account's, and the kernel stamps its owner.
    proofs: path.join(shared, 'pairing'),
    state,
    admin: path.join(state, 'admin.sock'),
  };
}

export function clientPaths(env = process.env, host = readHostConfig(env)) {
  const dir = host.clientStateDir;
  return { dir, credential: path.join(dir, 'credential.json') };
}
