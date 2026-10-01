// Where the broker and its clients keep things. Environment overrides exist
// for tests and for running a second, isolated broker; production uses the
// ENG-0339 shared space and each account's own state directory.

import os from 'node:os';
import path from 'node:path';

const stateHome = (env) => env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');

export function brokerPaths(env = process.env) {
  const shared = env.AGENT_COMMS_SHARED_DIR || '/Users/Shared/Public/agent-comms';
  const state = env.AGENT_COMMS_BROKER_STATE_DIR || path.join(stateHome(env), 'agent-comms-broker');
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

export function clientPaths(env = process.env) {
  const dir = env.AGENT_COMMS_CLIENT_STATE_DIR || path.join(stateHome(env), 'agent-comms');
  return { dir, credential: path.join(dir, 'credential.json') };
}
