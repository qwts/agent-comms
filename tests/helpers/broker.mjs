import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Broker } from '../../lib/broker.mjs';
import { brokerPaths } from '../../lib/paths.mjs';
import { PROTOCOL_VERSION } from '../../lib/wire.mjs';

function request(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, ...request })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const response = JSON.parse(buffer.slice(0, newline));
      socket.end();
      if (response.ok) resolve(response);
      else reject(Object.assign(new Error(response.error?.message), { code: response.error?.code }));
    });
    socket.on('error', reject);
  });
}

export async function pairAccount(paths, account, brokerUid) {
  const secret = randomBytes(32).toString('hex');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const proof = `${randomBytes(16).toString('hex')}.proof`;
  writeFileSync(path.join(paths.proofs, proof), secretHash, { mode: 0o644, flag: 'wx' });
  try {
    const response = await request(paths.socket, { op: 'pair-request', account, secretHash, proof });
    return { ...response, credential: { account, secret, brokerUid } };
  } finally {
    rmSync(path.join(paths.proofs, proof), { force: true });
  }
}

export function call(paths, credential, requestBody) {
  return request(paths.socket, { ...requestBody, auth: { account: credential.account, secret: credential.secret } });
}

const BIN = fileURLToPath(new URL('../../bin/agent-comms.mjs', import.meta.url));

function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env }, (error, stdout) => {
      let json;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = stdout;
      }
      resolve({ exit: error?.code ?? 0, json });
    });
  });
}

export async function withBroker(run, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-test-'));
  const env = {
    ...process.env,
    AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'),
    AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker'),
    AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'client'),
  };
  const paths = brokerPaths(env);
  const owner = options.owner ?? os.userInfo().username;
  const accounts = {
    alice: `agent_${randomUUID()}`,
    bob: `agent_${randomUUID()}`,
  };
  let broker;
  try {
    broker = await new Broker({ paths, mode: options.brokerOptions?.mode ?? 'group', ...options.brokerOptions }).start();
    const cli = (args, soul = accounts.alice, extraEnv = {}) => runCli(args, {
      ...env,
      QWTS_AGENT_ID: soul,
      ...extraEnv,
    });
    const accountCli = (account, args, soul, extraEnv = {}) => runCli(args, {
      ...env,
      QWTS_AGENT_ID: soul,
      AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, `client-${account}`),
      ...extraEnv,
    });
    const pairArgs = options.brokerOptions?.mode === 'single-account'
      ? ['account', 'pair'] : ['account', 'pair', '--broker', owner];
    // No AGENT_COMMS_MODE: the mode follows from whether a broker account is named.
    const paired = await cli(pairArgs, accounts.alice);
    if (paired.exit !== 0) throw new Error(`pair failed: ${JSON.stringify(paired.json)}`);
    const approved = await cli(['broker', 'approve', paired.json.code]);
    if (approved.exit !== 0) throw new Error(`approval failed: ${JSON.stringify(approved.json)}`);
    for (const [name, soul] of Object.entries(accounts)) {
      const joined = await cli(['join', '--name', name, '--harness', 'test'], soul);
      if (joined.exit !== 0) throw new Error(`join failed for ${name}: ${JSON.stringify(joined.json)}`);
    }
    return await run({ root, env, paths, broker, accounts, cli, accountCli, owner });
  } finally {
    if (broker) await broker.stop();
    rmSync(root, { recursive: true, force: true });
  }
}
