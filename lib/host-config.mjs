// One host configuration; legacy names are compatibility data, not app logic.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail } from './errors.mjs';
import { hostDirs } from './platform/host-dirs.mjs';

const defaults = JSON.parse(readFileSync(new URL('./host-defaults.json', import.meta.url), 'utf8'));
const variables = {
  serviceLabel: 'AGENT_COMMS_SERVICE_LABEL',
  credentialName: 'AGENT_COMMS_CREDENTIAL_NAME',
  logDir: 'AGENT_COMMS_LOG_DIR',
  sharedDir: 'AGENT_COMMS_SHARED_DIR',
  brokerStateDir: 'AGENT_COMMS_BROKER_STATE_DIR',
  clientStateDir: 'AGENT_COMMS_CLIENT_STATE_DIR',
};

// `platform` defaults through the host-dirs seam; launchd and Task Scheduler
// installs pass their own.
export function readHostConfig(env = process.env, home = os.homedir(), platform = undefined) {
  const stateHome = path.resolve(env.XDG_STATE_HOME || path.join(home, '.local', 'state'));
  const dirs = hostDirs(platform, home, stateHome);
  const config = {
    ...defaults,
    ...dirs,
    brokerStateDir: path.join(stateHome, 'agent-comms-broker'),
    clientStateDir: path.join(stateHome, 'agent-comms'),
  };
  // An explicit XDG_STATE_HOME is pinned for every directory derived from it.
  const fromState = (key) => key.endsWith('StateDir') || (key in dirs && dirs[key].startsWith(stateHome + path.sep));
  const environment = {};
  for (const [key, variable] of Object.entries(variables)) {
    if (env[variable]) config[key] = env[variable];
    // Names enter launchctl targets, filenames, and security's stdin command
    // parser. Keep them single safe tokens; directories may contain spaces.
    if (key === 'serviceLabel' || key === 'credentialName') {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(config[key])) {
        fail('usage', `${variable} must use letters, digits, dots, underscores or hyphens and start with a letter, digit or underscore`);
      }
    } else {
      config[key] = path.resolve(config[key]);
    }
    if (env[variable] || (env.XDG_STATE_HOME && fromState(key))) {
      environment[variable] = config[key];
    }
  }
  return Object.freeze({ ...config, environment: Object.freeze(environment) });
}

export const HOST_CONFIG = readHostConfig();

// #83: two hosts in one account (a package-manager CLI and a desktop host, say) share the
// client state directory but pair different principals under different
// credential names. Each name keeps its own local copy, so pairing one never
// overwrites the other's, and the CLI answers as the principal the
// configured name holds. The default name keeps `principal.json`, so
// existing installs need no migration.
export function principalFileName(host = HOST_CONFIG) {
  return host.credentialName === defaults.credentialName ? 'principal.json' : `principal.${host.credentialName}.json`;
}
