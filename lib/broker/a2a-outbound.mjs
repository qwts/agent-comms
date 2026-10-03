// Durable outbound A2A requests. Unknown delivery is never a license to resend.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { fail } from '../errors.mjs';
import { STATE_MAP } from './a2a.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// accepted and working share a wire state; the remote claim is working.
export const REMOTE_STATE_MAP = Object.freeze({
  ...Object.fromEntries(Object.entries(STATE_MAP).map(([local, wire]) => [wire, local])),
  submitted: 'offered', working: 'working', unknown: 'unknown',
});
const terminal = new Set(['completed', 'failed', 'rejected', 'canceled']);
const beforeConnection = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function privateRead(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error();
    return readFileSync(fd, 'utf8');
  } catch { fail('unsafe-config', 'A2A files must be owner-owned 0600 regular files'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function validateRoute(route) {
  let url;
  try { url = new URL(route?.url); } catch { fail('bad-request', 'invalid A2A route URL'); }
  if (!object(route) || typeof route.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(route.name)
    || url.href.length > 4096 || route.credentialFile?.length > 4096
    || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search
    || route.authScheme !== 'bearer' || typeof route.credentialFile !== 'string' || !path.isAbsolute(route.credentialFile)
    || route.tenant !== undefined && (typeof route.tenant !== 'string' || route.tenant.length > 1024)
    || !Array.isArray(route.allowedSouls) || route.allowedSouls.length > 100
    || route.allowedSouls.some((soul) => typeof soul !== 'string' || soul.length > 512 || !/^[^/\s]+\/[^/\s]+$/.test(soul))) {
    fail('bad-request', 'invalid A2A route or bearer credential reference');
  }
  return { name: route.name, url: url.href, authScheme: 'bearer', credentialFile: route.credentialFile,
    ...(route.tenant !== undefined ? { tenant: route.tenant } : {}), allowedSouls: [...new Set(route.allowedSouls)] };
}

export function createA2AOutbound(broker, commit, mailbox, tasks, {
  fetch: fetchRemote = globalThis.fetch, timeoutMs = 5000, maxAttempts = 3, pollMs = 10000,
  setTimeout: later = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout,
  sleep = (ms) => new Promise((resolve) => later(resolve, ms)),
} = {}) {
  let file; // Unit fixtures may construct a broker before assigning state paths.
  let routes = [];
  let timer;
  let stopped = false;
  const active = new Map();
  // Reconcile backoff per request (in memory): pollMs doubling to an hour,
  // so long-running or unresolvable requests don't poll the remote forever.
  const nextCheck = new Map();
  const maxCheckMs = 60 * 60_000;
  function load() {
    file = path.join(broker.paths.state, 'a2a-routes.json');
    if (!existsSync(file)) return;
    let rows;
    try { rows = JSON.parse(privateRead(file)); } catch { fail('unsafe-config', 'invalid private A2A routes file'); }
    if (!Array.isArray(rows) || rows.length > 100) fail('unsafe-config', 'invalid A2A routes file');
    routes = rows.map(validateRoute);
    if (new Set(routes.map((route) => route.name)).size !== routes.length) fail('unsafe-config', 'duplicate A2A route');
  }
  function save(next) {
    file ??= path.join(broker.paths.state, 'a2a-routes.json');
    if (Buffer.byteLength(JSON.stringify(next)) > 96 * 1024) fail('bad-request', 'A2A routes exceed the protocol budget');
    if (next.length > 100) fail('bad-request', 'too many A2A routes');
    if (existsSync(file)) privateRead(file);
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
    routes = next;
  }
  function token(route) {
    const value = privateRead(route.credentialFile).trim();
    if (!value || value.length > 8192 || /\s/.test(value)) fail('unsafe-config', 'invalid A2A bearer credential file');
    return value;
  }
  function admin(request) {
    if (request.op === 'a2a-route-list') return { routes: structuredClone(routes) };
    if (request.op === 'a2a-route-remove') {
      save(routes.filter((route) => route.name !== request.name));
      return { removed: request.name };
    }
    if (request.op !== 'a2a-route-add') fail('unknown-operation', 'unknown A2A route operation');
    const route = validateRoute({ authScheme: 'bearer', ...request.route });
    token(route); // Verify custody now, and again for every call.
    save([...routes.filter((row) => row.name !== route.name), route]);
    return { route: structuredClone(route) };
  }
  function caller(request) {
    const soul = mailbox.caller(request, { joined: true });
    if (soul.principal) fail('forbidden', 'outbound A2A requires a joined soul');
    return soul;
  }
  const same = (a, b) => a.account === b.account && a.agentId === b.agentId;
  function get(request) {
    const soul = caller(request);
    const entry = broker.state.outbound.get(request.id);
    if (!entry || !same(soul, entry.sender)) fail('unknown-request', 'no outbound request you may access has that id');
    return entry;
  }
  function routeFor(entry) {
    const route = routes.find((row) => row.name === entry.route);
    if (!route || route.url !== entry.remote.server || (route.tenant ?? null) !== entry.remote.tenant
      || !route.allowedSouls.includes(`${entry.sender.account}/${entry.sender.agentId}`)
      || !broker.state.souls.get(entry.sender.agentId)?.joined
      || broker.state.souls.get(entry.sender.agentId)?.account !== entry.sender.account
      || broker.state.pairings.get(entry.sender.account)?.state !== 'approved') {
      fail('forbidden', 'outbound route is no longer authorized');
    }
    return route;
  }
  function saveEntry(entry, changes) {
    const next = { ...entry, ...changes, updatedAt: broker.now() };
    commit({ t: 'a2a-outbound', request: next });
    return next;
  }
  async function rpc(entry, method, params) {
    const route = routeFor(entry);
    const credential = token(route);
    const controller = new AbortController();
    let deadline;
    try {
      // Race also bounds injected transports that do not implement AbortSignal.
      return await Promise.race([
        (async () => {
          const response = await fetchRemote(route.url, { method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', Authorization: `Bearer ${credential}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: entry.messageId, method, params }) });
          if (!response.ok) throw new Error('remote HTTP failure');
          let body;
          if (response.body) {
            const chunks = [];
            let bytes = 0;
            for await (const chunk of response.body) {
              bytes += chunk.length;
              if (bytes > 256 * 1024) { controller.abort(); throw new Error('remote response too large'); }
              chunks.push(Buffer.from(chunk));
            }
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } else body = await response.json(); // In-process transport fixtures.

          if (!object(body) || body.jsonrpc !== '2.0' || body.id !== entry.messageId) throw new Error('invalid response');
          if (object(body.error) && Number.isInteger(body.error.code)) throw Object.assign(new Error('remote RPC refusal'), { refusal: true });
          if (!object(body.result)) throw new Error('invalid result');
          return body.result;
        })(),
        new Promise((resolve, reject) => {
          deadline = later(() => { controller.abort(); reject(new Error('remote timeout')); }, timeoutMs);
        }),
      ]);
    } finally { clear(deadline); }
  }
  function outcome(entry, result, allowMessage = false) {
    const bounded = (changes) => {
      if (Buffer.byteLength(JSON.stringify({ ...entry, ...changes })) > 96 * 1024) throw new Error('remote outcome too large');
      return changes;
    };
    if (allowMessage && result.kind === 'message') {
      if (typeof result.messageId !== 'string' || !result.messageId || result.messageId.length > 4096
        || !Array.isArray(result.parts) || result.parts.some((part) => typeof part?.text !== 'string'
        || Object.keys(part).some((key) => !['text', 'metadata', 'mediaType'].includes(key))
        || part.mediaType !== undefined && part.mediaType !== 'text/plain')) throw new Error('unsupported remote content');
      const message = { messageId: result.messageId, parts: structuredClone(result.parts) };
      if (Buffer.byteLength(JSON.stringify(message)) > broker.limits.bodyBytes) throw new Error('remote message too large');
      return bounded({ status: 'done', response: message });
    }
    if (typeof result.id !== 'string' || !result.id || result.id.length > 4096
      || typeof result.contextId !== 'string' || !result.contextId || result.contextId.length > 4096
      || typeof result.status?.state !== 'string' || result.status.state.length > 128) throw new Error('invalid remote task');
    if (entry.remote.taskId && (entry.remote.taskId !== result.id || entry.remote.contextId !== result.contextId)) throw new Error('remote namespace changed');
    const originalState = result.status.state;
    return bounded({ status: terminal.has(originalState) ? 'done' : 'sent', remote: {
      ...entry.remote, taskId: result.id, contextId: result.contextId,
      state: REMOTE_STATE_MAP[originalState] ?? 'unknown', originalState,
    } });
  }
  async function transmit(entry) {
    while (!stopped && entry.status === 'pending' && entry.attempts < maxAttempts) {
      // Persist attempt intent before the body can leave. Replay treats it as uncertain.
      entry = saveEntry(entry, { attempts: entry.attempts + 1, retrySafe: false });
      let changes;
      try {
        const result = await rpc(entry, 'SendMessage', { message: { messageId: entry.messageId, role: 'user',
          parts: [{ text: entry.text }], contextId: entry.contextId,
          ...(entry.relatedTask ? { metadata: { relatedTask: entry.relatedTask } } : {}) } });
        changes = outcome(entry, result, true);
      } catch (error) {
        const safeRetry = beforeConnection.has(error.cause?.code ?? error.code);
        if (safeRetry && entry.attempts < maxAttempts) {
          // Durable proof of non-delivery makes a pending replay safe to resume.
          entry = saveEntry(entry, { retrySafe: true });
          await sleep(100 * 2 ** (entry.attempts - 1));
          continue;
        }
        changes = { status: safeRetry || error.refusal || error.code === 'unsafe-config' || error.code === 'forbidden' ? 'failed' : 'uncertain' };
      }
      saveEntry(entry, { ...changes, retrySafe: false });
      return;
    }
  }
  async function reconcile(entry) {
    let changes;
    try {
      if (entry.remote.taskId) changes = outcome(entry, await rpc(entry, 'GetTask', { id: entry.remote.taskId }));
      else {
        let pageToken;
        let match;
        const seen = new Set();
        // Context alone does not identify a send: require its stable messageId too.
        for (let page = 0; page < 100; page += 1) {
          if (stopped) return;
          const result = await rpc(entry, 'ListTasks', { contextId: entry.contextId, pageSize: 100, ...(pageToken ? { pageToken } : {}) });
          if (!Array.isArray(result.tasks)) throw new Error('invalid list');
          for (const task of result.tasks) {
            if (task.contextId === entry.contextId && (task.metadata?.messageId === entry.messageId
              || task.history?.some((message) => message.messageId === entry.messageId))) {
              if (match && match.id !== task.id) throw new Error('ambiguous tasks');
              match = task;
            }
          }
          pageToken = result.nextPageToken;
          if (!pageToken) break;
          if (typeof pageToken !== 'string' || seen.has(pageToken) || page === 99) throw new Error('incomplete list');
          seen.add(pageToken);
        }
        if (!match) return;
        changes = outcome(entry, match);
      }
    } catch { return; } // No match/refusal/outage leaves the uncertainty visible.
    saveEntry(entry, changes);
  }
  function queue(entry, operation) {
    if (stopped || active.has(entry.id)) return;
    const work = Promise.resolve().then(() => operation(entry)).finally(() => active.delete(entry.id));
    active.set(entry.id, work);
    // Persistence failures do not become transport failures or trigger sends.
    work.catch(() => {});
  }
  function send(request) {
    const soul = caller(request);
    const route = routes.find((row) => row.name === request.route);
    if (!route || !route.allowedSouls.includes(`${soul.account}/${soul.agentId}`)) fail('forbidden', 'outbound A2A route is not allowed');
    if (typeof request.text !== 'string' || !request.text.trim() || Buffer.byteLength(request.text) > broker.limits.bodyBytes
      || request.contextId !== undefined && (typeof request.contextId !== 'string' || !request.contextId || request.contextId.length > 4096)) fail('bad-request', 'invalid outbound text or context');
    if (request.relatedTask !== undefined) tasks.show({ ...request, taskId: request.relatedTask });
    const at = broker.now();
    const entry = { id: `outbound_${randomUUID()}`, messageId: randomUUID(), route: route.name,
      sender: mailbox.endpoint(soul), text: request.text, contextId: request.contextId ?? `context_${randomUUID()}`,
      relatedTask: request.relatedTask ?? null, status: 'pending', attempts: 0,
      remote: { server: route.url, tenant: route.tenant ?? null, route: route.name,
        taskId: null, contextId: null, state: null, originalState: null }, createdAt: at, updatedAt: at };
    if (Buffer.byteLength(JSON.stringify(entry)) > 96 * 1024) fail('bad-request', 'outbound request too large once escaped');
    commit({ t: 'a2a-outbound', request: entry });
    queue(entry, transmit);
    return { request: structuredClone(entry) };
  }
  function show(request) { return { request: structuredClone(get(request)) }; }
  function list(request) {
    const soul = caller(request);
    const { after = 0, limit = 20 } = request;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('bad-request', 'invalid outbound page');
    const entries = [...broker.state.outbound.values()].filter((entry) => same(soul, entry.sender));
    const page = [];
    let bytes = 0;
    for (const entry of entries.slice(after, after + limit)) {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (page.length && bytes + size > 96 * 1024) break;
      page.push(structuredClone(entry)); bytes += size;
    }
    return { requests: page, cursor: after + page.length, remaining: Math.max(0, entries.length - after - page.length) };
  }
  function cancel(request) {
    const entry = get(request);
    if (!entry.remote.taskId) fail('bad-request', 'remote task is not yet known');
    if (active.has(entry.id)) fail('busy', 'outbound request is being refreshed; retry cancellation');
    queue(entry, async (entry) => {
      let changes;
      try { changes = outcome(entry, await rpc(entry, 'CancelTask', { id: entry.remote.taskId })); }
      catch { return; } // Best effort: a closed connection claims no cancellation.
      saveEntry(entry, changes);
    });
    return { request: structuredClone(entry) };
  }
  // The timer passes paced: true; an explicit tick (start, tests) reconciles now.
  function tick({ paced = false } = {}) {
    for (let entry of broker.state.outbound.values()) {
      if (active.has(entry.id)) continue;
      if (entry.status === 'pending' && entry.attempts && !entry.retrySafe) entry = saveEntry(entry, { status: 'uncertain' });
      if (entry.status === 'pending') queue(entry, transmit);
      else if (['uncertain', 'sent'].includes(entry.status)) {
        const now = broker.now();
        const check = nextCheck.get(entry.id) ?? { at: 0, delay: pollMs };
        if (paced && now < check.at) continue;
        nextCheck.set(entry.id, { at: now + check.delay, delay: Math.min(check.delay * 2, maxCheckMs) });
        queue(entry, reconcile);
      } else nextCheck.delete(entry.id);
    }
  }
  function start() {
    load(); stopped = false;
    for (const entry of broker.state.outbound.values()) {
      if (entry.status === 'pending' && entry.attempts && !entry.retrySafe) saveEntry(entry, { status: 'uncertain' });
    }
    tick();
    const poll = () => { if (stopped) return; tick({ paced: true }); timer = later(poll, pollMs); timer?.unref?.(); };
    timer = later(poll, pollMs); timer?.unref?.();
  }
  async function drain() { while (active.size) await Promise.all([...active.values()]); }
  async function stop() { stopped = true; clear(timer); await drain(); }
  return { admin, load, start, stop, send, show, list, cancel, tick, drain };
}
