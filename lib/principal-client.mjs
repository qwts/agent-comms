// Host API over the same custody-checked broker protocol as the CLI.
import { callPrincipal } from './client.mjs';
import { fail } from './errors.mjs';
import { readHostConfig } from './host-config.mjs';
import { brokerPaths, clientPaths } from './paths.mjs';
import { isEd25519PublicKey, isWindowsSid } from './platform/identity-validators.mjs';
import { readPrincipalCredential } from './platform/secret-store.mjs';

const pinnedBrokerIdentity = ({ brokerUid, brokerKey }) => {
  if (Number.isInteger(brokerUid) && brokerUid >= 0) {
    if (brokerKey === undefined || isEd25519PublicKey(brokerKey)) {
      return { brokerUid, ...(brokerKey === undefined ? {} : { brokerKey }) };
    }
    return null;
  }
  if (isWindowsSid(brokerUid) && isEd25519PublicKey(brokerKey)) return { brokerUid, brokerKey };
  return null;
};

export function createPrincipalClient({ env = process.env, timeoutMs,
  credentialLoader = readPrincipalCredential, principalCaller = callPrincipal } = {}) {
  const host = readHostConfig(env);
  const saved = credentialLoader(clientPaths(env, host), host, env);
  const brokerIdentity = saved ? pinnedBrokerIdentity(saved) : null;
  if (!saved || !/^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(saved.principal)
    || typeof saved.secret !== 'string' || !saved.secret
    || !brokerIdentity
    || (saved.mode !== undefined && !['group', 'single-account'].includes(saved.mode))) {
    fail('credential-invalid', 'the saved principal credential is invalid');
  }
  // Copy only credential fields; callers cannot substitute sender, auth or op.
  const credential = { principal: saved.principal, secret: saved.secret,
    ...brokerIdentity,
    mode: saved.mode ?? 'group' };
  const paths = brokerPaths(env, host);
  const request = (payload) => principalCaller(paths, credential, payload, { timeoutMs });
  return Object.freeze({
    principal: credential.principal,
    // `parent` is forwarded as given: undefined is omitted from the wire,
    // null (independent) is kept.
    launch: ({ account, soul, package: packagePath, harness, name, comms, model, brief, role, parent }) =>
      request({ op: 'launch', account, soul, package: packagePath, harness, name, comms, model, brief, role, parent }),
    launchStatus: (requestId) => request({ op: 'launch-status', requestId }),
    census: () => request({ op: 'census' }),
    send: ({ to, body, key, kind, refs, correlation, replyTo }) =>
      request({ op: 'send', to, body, key, kind, refs, correlation, replyTo }),
    offerTask: ({ to, acceptanceCriteria, parent, dependencies, relatedTask }) =>
      request({ op: 'task-offer', to, acceptanceCriteria, parent, dependencies, relatedTask }),
    acceptTask: (taskId, revision) => request({ op: 'task-accept', taskId, revision }),
    rejectTask: (taskId, revision) => request({ op: 'task-reject', taskId, revision }),
    updateTask: (taskId, revision, state) => request({ op: 'task-update', taskId, revision, state }),
    cancelTask: (taskId, revision) => request({ op: 'task-cancel', taskId, revision }),
    reportInvocation: (taskId, invocationId, phase, outcome) =>
      request({ op: 'task-invocation', taskId, invocationId, phase, outcome }),
    showTask: (taskId) => request({ op: 'task-show', taskId }),
    listTasks: ({ state, after, limit } = {}) => request({ op: 'task-list', state, after, limit }),
    inbox: ({ after, limit } = {}) => request({ op: 'read', after, limit }),
    ack: (ids) => request({ op: 'ack', ids }),
  });
}
