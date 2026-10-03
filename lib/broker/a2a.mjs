// A2A 1.0 JSON-RPC edge. Configuration and transport never grant task authority.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fail } from '../errors.mjs';
import { sha256 } from './shared.mjs';

const METHODS = ['SendMessage', 'GetTask', 'CancelTask', 'ListTasks'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const rpcError = (code, message) => { throw Object.assign(new Error(message), { rpcCode: code }); };
export const STATE_MAP = Object.freeze({
  offered: 'submitted', accepted: 'working', working: 'working',
  'input-required': 'input-required', 'auth-required': 'auth-required',
  completed: 'completed', canceled: 'canceled', failed: 'failed', rejected: 'rejected',
});

export function wireTask(task, historyLength) {
  const history = task.a2a ? [task.a2a.message] : [];
  return {
    kind: 'task', id: task.id, contextId: task.a2a?.contextId ?? task.id,
    status: { state: STATE_MAP[task.state] ?? 'unknown', timestamp: new Date(task.updatedAt).toISOString() },
    metadata: { localState: task.state, revision: task.revision },
    history: historyLength === 0 ? [] : history,
  };
}

function validate(config) {
  if (!object(config) || config.host !== '127.0.0.1'
    || typeof config.enabled !== 'boolean' || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535
    || !Array.isArray(config.skills) || config.skills.length > 100
    || !object(config.callers)) fail('bad-request', 'A2A requires enabled, host 127.0.0.1, port and skills/callers');
  const ids = new Set();
  for (const skill of config.skills) {
    if (!object(skill) || typeof skill.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(skill.id)
      || ids.has(skill.id) || typeof skill.soul !== 'string' || !skill.soul.includes('/')
      || !['name', 'description'].every((key) => typeof skill[key] === 'string' && skill[key].length <= 1024)
      || !Array.isArray(skill.tags) || skill.tags.some((tag) => typeof tag !== 'string')) fail('bad-request', 'invalid A2A skill');
    ids.add(skill.id);
  }
  for (const [hash, caller] of Object.entries(config.callers)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !object(caller) || typeof caller.principal !== 'string'
      || !Array.isArray(caller.souls) || caller.souls.some((soul) => typeof soul !== 'string')
      || !Array.isArray(caller.operations) || caller.operations.some((op) => !METHODS.includes(op))) fail('bad-request', 'invalid A2A caller map');
  }
  return config;
}

export function createA2A(broker, operate) {
  const file = path.join(broker.paths.state, 'a2a.json');
  let config = { enabled: false, host: '127.0.0.1', port: 0, skills: [], callers: {} };
  let server;
  function load() {
    if (!existsSync(file)) return;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) fail('unsafe-config', 'A2A config must be an owner-owned 0600 regular file');
    config = validate(JSON.parse(readFileSync(file, 'utf8')));
  }
  function save(next) {
    validate(next);
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
    config = structuredClone(next);
  }
  function admin(request) {
    switch (request.op) {
      case 'a2a-configure': save({ ...request.config, callers: config.callers }); return { restartRequired: true };
      case 'a2a-enroll': {
        if (broker.state.principals.get(request.principal)?.state !== 'approved') fail('not-approved', 'enroll an approved principal first');
        save({ ...config, callers: { ...config.callers, [request.tokenHash]: {
          principal: request.principal, souls: request.souls, operations: request.operations,
        } } });
        return { tokenHash: request.tokenHash, principal: request.principal };
      }
      case 'a2a-revoke': {
        const callers = { ...config.callers };
        delete callers[request.tokenHash];
        save({ ...config, callers });
        return { revoked: request.tokenHash };
      }
      case 'a2a-list': return { callers: structuredClone(config.callers) };
      case 'a2a-serve-status': return { enabled: config.enabled, listening: !!server?.listening, address: server?.address() ?? null, skills: structuredClone(config.skills) };
      default: fail('unknown-operation', 'unknown A2A admin operation');
    }
  }
  function authenticate(headers) {
    const match = /^Bearer ([^\s]+)$/i.exec(headers.authorization ?? '');
    const caller = match && config.callers[sha256(match[1])];
    if (!caller || broker.state.principals.get(caller.principal)?.state !== 'approved') {
      throw Object.assign(new Error('an enrolled bearer credential is required'), { httpStatus: 401, rpcCode: -32004 });
    }
    return caller;
  }
  function card(skill) {
    const port = server?.address()?.port ?? config.port;
    return {
      protocolVersion: '1.0', name: skill.name, description: skill.description,
      url: `http://127.0.0.1:${port}/a2a/${skill.id}`, preferredTransport: 'JSONRPC',
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
      skills: config.skills.filter((row) => row.soul === skill.soul).map(({ soul, ...row }) => row),
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, security: [{ bearer: [] }],
    };
  }
  // Called by HTTP and fixtures; authorization precedes method dispatch.
  function dispatch(headers, skillId, envelope) {
    let id = null;
    try {
      const caller = authenticate(headers);
      if (!object(envelope) || envelope.jsonrpc !== '2.0' || typeof envelope.method !== 'string'
        || !Object.hasOwn(envelope, 'id') || !(envelope.id === null || typeof envelope.id === 'string' || typeof envelope.id === 'number')) rpcError(-32600, 'invalid JSON-RPC request');
      id = envelope.id;
      if (headers['a2a-version'] !== undefined && headers['a2a-version'] !== '1.0') rpcError(-32009, 'only A2A version 1.0 is supported');
      if (!METHODS.includes(envelope.method)) rpcError(-32601, 'method not found');
      const skill = config.skills.find((row) => row.id === skillId);
      if (!skill || !caller.souls.includes(skill.soul) || !caller.operations.includes(envelope.method)) {
        throw Object.assign(new Error('operation or soul is not allowed'), { httpStatus: 403, rpcCode: -32004 });
      }
      const params = envelope.params ?? {};
      if (!object(params)) rpcError(-32602, 'params must be an object');
      const op = (request) => operate(caller.principal, request);
      const scoped = (task) => {
        if (`${task.assignee.account}/${task.assignee.agentId}` !== skill.soul || task.offerer.principal !== caller.principal) rpcError(-32001, 'task not found');
        return task;
      };
      let result;
      if (envelope.method === 'SendMessage') {
        if (Object.keys(params).some((key) => !['message', 'configuration'].includes(key))) rpcError(-32602, 'unsupported send parameter');
        const message = params.message;
        if (!object(message) || typeof message.messageId !== 'string' || !message.messageId
          || !['user', 'agent'].includes(message.role) || !Array.isArray(message.parts) || !message.parts.length
          || (message.contextId !== undefined && (typeof message.contextId !== 'string' || !message.contextId))) rpcError(-32602, 'invalid message');
        if (message.extensions !== undefined && (!Array.isArray(message.extensions) || message.extensions.length)
          || params.configuration !== undefined && !object(params.configuration)) rpcError(-32004, 'extensions or configuration unsupported');
        if (headers['a2a-extensions'] || params.configuration && Object.keys(params.configuration).length) rpcError(-32004, 'extensions or configuration unsupported');
        if (message.taskId !== undefined) rpcError(-32004, 'continuing a task with SendMessage is unsupported');
        if (message.parts.some((part) => !object(part) || typeof part.text !== 'string'
          || Object.keys(part).some((key) => !['text', 'metadata', 'mediaType'].includes(key))
          || part.mediaType !== undefined && part.mediaType !== 'text/plain')) rpcError(-32005, 'only text/plain text parts are supported');
        const contextId = message.contextId ?? `context_${randomUUID()}`;
        const task = op({ op: 'task-offer', to: skill.soul, acceptanceCriteria: message.parts.map((part) => part.text).join('\n'),
          a2a: { contextId, message: { ...structuredClone(message), contextId } } }).task;
        result = wireTask(task);
      } else if (envelope.method === 'ListTasks') {
        if (Object.keys(params).some((key) => !['pageToken', 'pageSize'].includes(key))
          || params.pageToken !== undefined && (typeof params.pageToken !== 'string' || !/^\d+$/.test(params.pageToken))) rpcError(-32602, 'unsupported list filter or invalid page token');
        const rows = op({ op: 'task-list', after: Number(params.pageToken ?? 0), limit: params.pageSize ?? 20 });
        result = { tasks: rows.tasks.filter((task) => task.offerer.principal === caller.principal
          && `${task.assignee.account}/${task.assignee.agentId}` === skill.soul).map((task) => wireTask(task)),
        nextPageToken: rows.remaining ? String(rows.cursor) : '' };
      } else if (envelope.method === 'GetTask' || envelope.method === 'CancelTask') {
        if (Object.keys(params).some((key) => !['id', 'historyLength'].includes(key))) rpcError(-32602, 'unsupported task query parameter');
        if (typeof params.id !== 'string' || !params.id || params.historyLength !== undefined
          && (!Number.isSafeInteger(params.historyLength) || params.historyLength < 0)) rpcError(-32602, 'invalid task query');
        let task = scoped(op({ op: 'task-show', taskId: params.id }).task);
        if (envelope.method === 'CancelTask') {
          if (['completed', 'failed', 'rejected', 'canceled'].includes(task.state)) rpcError(-32002, 'task is terminal');
          task = op({ op: 'task-cancel', taskId: task.id, revision: task.revision }).task;
        }
        result = wireTask(task, params.historyLength);
      } else rpcError(-32601, 'method not found');
      return { status: 200, body: { jsonrpc: '2.0', id, result } };
    } catch (error) {
      const code = error.rpcCode ?? ({ 'unknown-task': -32001, 'invalid-transition': -32002,
        'bad-request': -32602, 'unknown-recipient': -32004, forbidden: -32004,
        'rate-limited': -32004, 'mailbox-full': -32004 }[error.code] ?? -32603);
      return { status: error.httpStatus ?? 200, body: { jsonrpc: '2.0', id,
        error: { code, message: code === -32603 ? 'internal broker error' : error.message } } };
    }
  }
  async function start() {
    load();
    if (!config.enabled) return;
    server = http.createServer(async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json', 'A2A-Version': '1.0',
          ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) });
        res.end(JSON.stringify(body));
      };
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return send(400, { error: 'invalid URL' }); }
      const cardId = /^\/a2a\/([^/]+)\/\.well-known\/agent-card.json$/.exec(url.pathname)?.[1];
      const skill = config.skills.find((row) => row.id === cardId) ?? (url.pathname === '/.well-known/agent-card.json' ? config.skills[0] : undefined);
      if (req.method === 'GET' && skill) return send(200, card(skill));
      if (req.method !== 'POST') return send(404, { error: 'not found' });
      const skillId = /^\/a2a\/([^/]+)$/.exec(url.pathname)?.[1];
      try { authenticate(req.headers); } catch (error) { req.resume(); return send(401, { error: error.message }); }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { req.resume(); return send(415, { error: 'application/json required' }); }
      const chunks = [];
      let bytes = 0;
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 96 * 1024) { send(413, { error: 'request too large' }); req.destroy(); return; }
          chunks.push(chunk);
        }
        let envelope;
        try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } }); }
        const result = dispatch(req.headers, skillId, envelope);
        send(result.status, result.body);
      } catch { if (!res.headersSent) send(400, { error: 'request interrupted' }); }
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', resolve);
    });
  }
  async function stop() {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  return { start, stop, admin, dispatch, card, load };
}
