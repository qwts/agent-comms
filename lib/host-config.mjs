// One host configuration; legacy names are compatibility data, not app logic.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail } from './errors.mjs';

const defaults = JSON.parse(readFileSync(new URL('./host-defaults.json', import.meta.url), 'utf8'));
const variables = {
  serviceLabel: 'AGENT_COMMS_SERVICE_LABEL',
  credentialName: 'AGENT_COMMS_CREDENTIAL_NAME',
  logDir: 'AGENT_COMMS_LOG_DIR',
  sharedDir: 'AGENT_COMMS_SHARED_DIR',
  brokerStateDir: 'AGENT_COMMS_BROKER_STATE_DIR',
  clientStateDir: 'AGENT_COMMS_CLIENT_STATE_DIR',
};

export function readHostConfig(env = process.env, home = os.homedir()) {
  const stateHome = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  const config = {
    ...defaults,
    logDir: path.join(home, 'Library', 'Logs', 'agent-comms'),
    sharedDir: '/Users/Shared/Public/agent-comms',
    brokerStateDir: path.join(stateHome, 'agent-comms-broker'),
    clientStateDir: path.join(stateHome, 'agent-comms'),
  };
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
    if (env[variable] || (env.XDG_STATE_HOME && key.endsWith('StateDir'))) {
      environment[variable] = config[key];
    }
  }
  return Object.freeze({ ...config, environment: Object.freeze(environment) });
}

export const HOST_CONFIG = readHostConfig();
