// Host API over the same custody-checked broker protocol as the CLI.
import { callPrincipal } from './client.mjs';
import { fail } from './errors.mjs';
import { readHostConfig } from './host-config.mjs';
import { brokerPaths, clientPaths } from './paths.mjs';
import { readPrincipalCredential } from './platform/secret-store.mjs';

export function createPrincipalClient({ env = process.env, timeoutMs,
  credentialLoader = readPrincipalCredential } = {}) {
  const host = readHostConfig(env);
  const saved = credentialLoader(clientPaths(env, host), host, env);
  if (!saved || !/^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(saved.principal)
    || typeof saved.secret !== 'string' || !saved.secret
    || !Number.isInteger(saved.brokerUid) || saved.brokerUid < 0
    || (saved.mode !== undefined && !['group', 'single-account'].includes(saved.mode))) {
    fail('credential-invalid', 'the saved principal credential is invalid');
  }
  // Copy only credential fields; callers cannot substitute sender, auth or op.
  const credential = { principal: saved.principal, secret: saved.secret,
    brokerUid: saved.brokerUid, mode: saved.mode ?? 'group' };
  const paths = brokerPaths(env, host);
  const request = (payload) => callPrincipal(paths, credential, payload, { timeoutMs });
  return Object.freeze({
    principal: credential.principal,
    launch: ({ account, soul, package: packagePath, harness, name }) =>
      request({ op: 'launch', account, soul, package: packagePath, harness, name }),
    launchStatus: (requestId) => request({ op: 'launch-status', requestId }),
    census: () => request({ op: 'census' }),
    send: ({ to, body, key, kind, refs, correlation, replyTo }) =>
      request({ op: 'send', to, body, key, kind, refs, correlation, replyTo }),
    inbox: ({ after, limit } = {}) => request({ op: 'read', after, limit }),
    ack: (ids) => request({ op: 'ack', ids }),
  });
}
