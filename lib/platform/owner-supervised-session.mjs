// Private inherited-session plumbing. Pipe framing is not installation attestation.
// The dedicated root-supervised service-account launch is the external boundary.
import * as fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { decodeNativeObservationV2, observationSnapshot } from './owner-observer-wire.mjs';
const sessions = new WeakSet(), bindings = new WeakMap();
const unavailable = () => { throw new Error('owner-supervised-session-unavailable'); };
const exact = (v, names) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const hex = (v, size) => typeof v === 'string' && v.length === size && /^[a-f0-9]+$/.test(v);
const uid = v => Number.isSafeInteger(v) && v > 0 && v <= 0xffffffff;
const guid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
function canonical(v) {
  if (typeof v === 'string') {
    for (const scalar of v) { const code = scalar.codePointAt(0); if (code >= 0xd800 && code <= 0xdfff) unavailable(); }
    return JSON.stringify(v);
  }
  if (typeof v === 'number' && (!Number.isSafeInteger(v) || Object.is(v, -0))) unavailable();
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    if (keys.some(k => !/^[\x00-\x7f]*$/.test(k))) unavailable();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
function decodeReply(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') { if (++depth > 8) unavailable(); }
    else if (char === '}' || char === ']') { if (--depth < 0) unavailable(); }
  }
  if (depth || quoted) unavailable();
  const value = JSON.parse(text);
  if (canonical(value) !== text) unavailable();
  return value;
}
function configuration(v) {
  if (!exact(v, 'v,kind,brokerStateDir,sharedDir,socketGroupGid,brokerUid,brokerAccountGuid,ownerUid,ownerAccountGuid,namespaceDigest')
      || v.v !== 1 || v.kind !== 'agent-comms-owner-broker-configuration' || !uid(v.socketGroupGid)
      || !uid(v.brokerUid) || v.brokerUid !== process.getuid() || !uid(v.ownerUid) || v.ownerUid === v.brokerUid
      || !guid(v.brokerAccountGuid) || !guid(v.ownerAccountGuid) || v.brokerAccountGuid === v.ownerAccountGuid || !hex(v.namespaceDigest, 64)) unavailable();
  for (const field of ['brokerStateDir', 'sharedDir']) if (typeof v[field] !== 'string' || !path.isAbsolute(v[field])
      || path.resolve(v[field]) !== v[field] || v[field].includes('\0') || Buffer.byteLength(v[field]) > 1024) unavailable();
  if (v.brokerStateDir === v.sharedDir) unavailable();
  return Object.freeze(v);
}
// No caller-selected endpoints, transport, configuration, paths or native callbacks.
export function acquireInheritedOwnerSession() {
  if (process.platform !== 'darwin') unavailable();
  let poisoned = false, closed = false, sequence = 0, session = null, installation, config, active = null, scopeDeadline = Infinity;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  function poison() {
    if (!poisoned) { poisoned = true; for (const fd of [3, 4]) { try { fs.closeSync(fd); } catch {} } }
    unavailable();
  }
  function io(operation, deadline) {
    for (;;) {
      if (performance.now() >= deadline) poison();
      try { return operation(); }
      catch (error) {
        if (!['EAGAIN', 'EWOULDBLOCK', 'EINTR'].includes(error?.code)) poison();
        Atomics.wait(sleeper, 0, 0, Math.min(2, Math.max(0, deadline - performance.now())));
      }
    }
  }
  function read(size, deadline) {
    const bytes = Buffer.alloc(size); let at = 0;
    while (at < size) { const n = io(() => fs.readSync(4, bytes, at, size - at, null), deadline); if (!Number.isInteger(n) || n <= 0) poison(); at += n; }
    return bytes;
  }
  function exchange(op, scope) {
    if (poisoned || closed || sequence > Number.MAX_SAFE_INTEGER - 1) unavailable();
    try {
      const deadline = Math.min(performance.now() + (op === 'hello' ? 15000 : 10000), scopeDeadline);
      const current = sequence++;
      const body = Buffer.from(canonical({ op, scope, sequence: current, session, v: 1 }));
      const bytes = Buffer.alloc(4 + body.length); bytes.writeUInt32BE(body.length); body.copy(bytes, 4);
      let at = 0;
      while (at < bytes.length) { const n = io(() => fs.writeSync(3, bytes, at, bytes.length - at), deadline); if (!Number.isInteger(n) || n <= 0) poison(); at += n; }
      const length = read(4, deadline).readUInt32BE(); if (!length || length > 65536) poison();
      const reply = decodeReply(read(length, deadline));
      if (!exact(reply, 'configuration,installation,observation,op,scope,sequence,session,v') || reply.v !== 1
          || reply.op !== op || reply.sequence !== current || !hex(reply.session, 32) || !hex(reply.installation, 64)
          || (session !== null && (reply.session !== session || reply.installation !== installation))) poison();
      if (op === 'hello') {
        if (reply.scope !== null || reply.observation !== null) poison();
        config = configuration(reply.configuration); session = reply.session; installation = reply.installation;
      } else {
        if (reply.configuration !== null) poison();
        if (op === 'open-observation-scope' || op === 'observe-current-scope') {
          if (reply.scope !== (op === 'open-observation-scope' ? current : scope)
              || typeof reply.observation !== 'string' || !/^[A-Za-z0-9_-]+$/.test(reply.observation)) poison();
          const bytes = Buffer.from(reply.observation, 'base64url');
          if (bytes.length > 24576 || bytes.toString('base64url') !== reply.observation) poison();
          const observation = decodeNativeObservationV2(bytes), i = observation.installation;
          for (const key of ['brokerUid', 'brokerAccountGuid', 'ownerUid', 'ownerAccountGuid', 'namespaceDigest']) if (i[key] !== config[key]) poison();
          if (i.publicSocket !== path.join(config.sharedDir, 'broker.sock')) poison();
          const snapshot = observationSnapshot(observation);
          if (performance.now() >= deadline) poison();
          return { scope: reply.scope, snapshot };
        }
        if (reply.scope !== null || reply.observation !== null) poison();
      }
      if (performance.now() >= deadline) poison();
      return reply;
    } catch { poison(); }
  }
  exchange('hello', null);
  const value = Object.freeze({
    configuration: config,
    // Correlation only: not proof that the descriptor or launcher is protected.
    installationDigest: installation,
    open() {
      if (active !== null) poison();
      scopeDeadline = performance.now() + 10000;
      const opened = exchange('open-observation-scope', null); active = opened.scope;
      let done = false;
      const initial = opened.snapshot;
      if (performance.now() >= scopeDeadline) poison();
      return Object.freeze({ snapshot: initial,
        observe() {
          if (done || active !== opened.scope) poison();
          const next = exchange('observe-current-scope', active).snapshot;
          for (const key of ['namespaceDigest', 'revision', 'brokerKey', 'presenceKey', 'brokerEnrollmentHeadDigest', 'custodyFingerprint', 'observationDigest']) if (next[key] !== initial[key]) poison();
          if (performance.now() >= scopeDeadline) poison();
          return next;
        },
        close() {
          if (done) return;
          exchange('close-observation-scope', active); active = null; scopeDeadline = Infinity; done = true;
        },
      });
    },
    checkIdle() {
      if (poisoned || closed || active !== null) unavailable();
      try {
        // NONBLOCK is supplied by the independently trusted native launcher.
        // No heartbeat: EAGAIN is healthy; any byte or EOF is fatal while idle.
        fs.readSync(4, Buffer.alloc(1), 0, 1, null); poison();
      } catch (error) { if (!['EAGAIN', 'EWOULDBLOCK'].includes(error?.code)) poison(); }
    },
    close() {
      if (closed) return;
      if (active !== null) poison();
      exchange('close-session', null); closed = true;
      try { fs.closeSync(3); fs.closeSync(4); } catch { poison(); }
    },
  });
  sessions.add(value); return value;
}
export function bindInheritedOwnerSession(broker, session) {
  if (!sessions.has(session) || bindings.has(broker) || broker.mode !== 'group'
      || broker.paths.state !== session.configuration.brokerStateDir || broker.paths.shared !== session.configuration.sharedDir
      || broker.gid !== session.configuration.socketGroupGid) unavailable();
  bindings.set(broker, session);
}
export function observeInheritedOwnerSession(broker) {
  const session = bindings.get(broker); if (!session) return false;
  const scope = session.open();
  try { scope.observe(); } finally { scope.close(); }
  return true;
}
