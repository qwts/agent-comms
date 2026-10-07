import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { chownSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { assertAncestors, assertOwnedDir, createAccountIsolation } from './account-isolation.mjs';
import { HOST_CONFIG } from '../host-config.mjs';
import { CommsError, fail } from '../errors.mjs';
import { lineReader, MAX_LINE_BYTES, PROTOCOL_VERSION, writeLine } from '../wire.mjs';
export const STREAMING = Symbol('streaming');
export const SOCKET_MODE_GROUP = 0o660;
export const SOCKET_MODE_OWNER = 0o600;

// One broker per state directory. The lock holds the owner's pid; a lock
// whose pid is gone is left over from a crash and may be taken. So is a lock
// written before this boot: after an unclean shutdown its pid can belong to
// an unrelated process, which would keep the broker down until someone
// deleted the file. The socket probe still stops a second live broker.
function takeLock(file, bootedAt = Date.now() - os.uptime() * 1000) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const pid = Number(readFileSync(file, 'utf8'));
    // Allow for the second-level precision of uptime and file times.
    const fromEarlierBoot = lstatSync(file).mtimeMs < bootedAt - 5000;
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = Number.isInteger(pid) && pid > 0;
    } catch (error) {
      alive = error.code === 'EPERM';
    }
    if (alive && !fromEarlierBoot) break;
    rmSync(file, { force: true });
  }
  fail('broker-running', `another broker holds ${file}`);
}

async function stopBroker(broker) {
  const closing = broker.servers.map((server) => new Promise((resolve) => server.close(resolve)));
  for (const socket of broker.connections) socket.destroy();
  await Promise.all(closing);
  broker.servers = [];
  broker.watchers.clear();
  broker.accountWatchers.clear();
  if (broker.lock) rmSync(broker.lock, { force: true });
  broker.lock = null;
}

// One request per connection, answered with one line or, for a watch, a line
// per event until either side closes. The same on both platforms: the pipe
// branch runs its handshake first and then hands the lines here.
function requestServer(broker, socket, handler) {
  let handled = false;
  const onRequest = (request) => {
    if (handled) return;
    handled = true;
    try {
      if (request?.v !== PROTOCOL_VERSION) {
        fail('protocol-version', `this broker speaks protocol ${PROTOCOL_VERSION}`);
      }
      const result = handler(request, socket);
      if (result === STREAMING) return;
      writeLine(socket, { ok: true, ...result });
    } catch (error) {
      const code = error instanceof CommsError ? error.code : 'internal';
      const message = error instanceof CommsError ? error.message : 'the broker hit an internal error';
      if (!(error instanceof CommsError)) console.error(error);
      writeLine(socket, { ok: false, error: { code, message } });
    }
    socket.end();
  };
  // Stop reading, flush the refusal, then drop the connection.
  const refuse = (error) => {
    socket.pause();
    socket.end(`${JSON.stringify({ ok: false, error: { code: 'bad-request', message: error.message } })}\n`, () => socket.destroy());
  };
  return { onRequest, refuse };
}

function track(broker, socket) {
  broker.connections.add(socket);
  socket.on('close', () => broker.connections.delete(socket));
  socket.on('error', () => {});
}

// macOS implementation. POSIX test runners retain the existing Unix behaviour.
// Select before invoking an operation so win32 never reaches a Unix API.
export function createLocalChannel(platform = process.platform, options = {}) {
  if (platform === 'win32') return createPipeChannel(options);
  function stat(file, code) {
    try {
      return lstatSync(file);
    } catch {
      return fail(code, `${file} does not exist`);
    }
  }

  function assertBrokerSocket(file, ownerUid, code = 'broker-untrusted') {
    const info = stat(file, 'broker-unreachable');
    if (!info.isSocket() || info.uid !== ownerUid) fail(code, `${file} is not the broker account's socket`);
  }

  function assertPrivateBrokerCustody(paths, ownerUid) {
    assertAncestors(paths.shared, ownerUid);
    assertOwnedDir(paths.shared, ownerUid, { mode: 0o700 });
    assertOwnedDir(paths.proofs, ownerUid, { mode: 0o700 });
    assertBrokerSocket(paths.socket, ownerUid);
    const socket = stat(paths.socket, 'broker-unreachable');
    if ((socket.mode & 0o7777) !== 0o600) fail('broker-untrusted', `${paths.socket} is not a private 0600 socket`);
  }
  // ADR-0006 decision 1: refuse a broker unless its directory, ancestors, and
  // socket belong to the broker account named at pairing. There is no trust on
  // first use: `account pair --broker ACCOUNT` names it, and later calls use the
  // uid recorded then.
  function checkBrokerCustody(paths, brokerUid, mode = 'group') {
    if (!Number.isInteger(brokerUid)) fail('broker-untrusted', 'no broker account is pinned for this client');
    try {
      lstatSync(paths.socket);
    } catch {
      fail('broker-unreachable', `no broker socket at ${paths.socket}; is the broker running?`);
    }
    if (mode === 'single-account') {
      assertPrivateBrokerCustody(paths, brokerUid);
      return;
    }
    assertAncestors(paths.shared, brokerUid);
    const dir = assertOwnedDir(paths.shared, brokerUid);
    if ((dir.mode & 0o022) !== 0) fail('broker-untrusted', `${paths.shared} is writable by accounts other than the broker's`);
    assertBrokerSocket(paths.socket, brokerUid);
  }

  // Unlink a socket only when nothing answers on it, so a second broker cannot
  // take over the rendezvous path from a running one.
  async function removeStaleSocket(file) {
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      return;
    }
    if (!stat.isSocket()) fail('socket-path-occupied', `${file} exists and is not a socket`);
    const live = await new Promise((resolve) => {
      const probe = net.createConnection(file);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (live) fail('broker-running', `another broker is already answering on ${file}`);
    unlinkSync(file);
  }

  function prepare(broker) {
    const { shared, proofs, state } = broker.paths;
    const uid = process.getuid();
    // Refuse a rendezvous path another account could have planted: check the
    // ancestors and ownership before touching modes, so a foreign directory or
    // symlink stops the broker instead of being adopted.
    mkdirSync(shared, { recursive: true, mode: broker.mode === 'single-account' ? 0o700 : 0o755 });
    assertAncestors(shared, uid, 'shared-dir-untrusted');
    assertOwnedDir(shared, uid, { code: 'shared-dir-untrusted' });
    const privateMode = broker.mode === 'single-account';
    chmodSync(shared, privateMode ? 0o700 : 0o755);
    mkdirSync(proofs, { recursive: true, mode: privateMode ? 0o700 : 0o755 });
    assertOwnedDir(proofs, uid, { code: 'shared-dir-untrusted' });
    chmodSync(proofs, privateMode ? 0o700 : 0o1777);
    // The event log is the broker's authority, so its directory must pass
    // custody before a single record is replayed: another account able to
    // write there could forge pairings or messages.
    mkdirSync(state, { recursive: true, mode: 0o700 });
    assertAncestors(state, uid, 'state-dir-untrusted');
    const stateDir = assertOwnedDir(state, uid, { code: 'state-dir-untrusted' });
    if ((stateDir.mode & 0o022) !== 0) fail('state-dir-untrusted', `${state} is writable by accounts other than the broker's`);
    chmodSync(state, 0o700);
    const lock = path.join(state, 'broker.lock');
    takeLock(lock, broker.bootedAt);
    broker.lock = lock;
    return uid;
  }

  // `setGroup` hands back the gid the socket should belong to, so the caller owns
  // the chgrp (broker.mjs resolves the group name) and a test can supply one
  // without touching a real group.
  function listen(broker, file, handler, mode, setGroup) {
    const server = net.createServer((socket) => {
      track(broker, socket);
      const { onRequest, refuse } = requestServer(broker, socket, handler);
      lineReader(socket, onRequest, refuse);
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(file, () => {
        try {
          // The socket has to be usable the moment listen resolves, and a throw
          // here would otherwise leave the promise pending forever.
          shareSocket(file, mode, { setGroup });
          resolve(server);
        } catch (error) {
          server.close();
          reject(error);
        }
      });
    });
  }

  // ---- the socket as a group boundary (ADR-0006 decision 1) -----------------
  //
  // A client account outside the group is refused by the kernel at connect(2),
  // with no code of ours to trust, so the mode and the group are the whole
  // access decision and the pairing check is only the second door. Node has no
  // API for a socket's peer credentials (ADR-0006, alternatives), so there is no
  // second in-broker check to make until a native helper exists.

  const socketModeFor = (gid) => (gid === null ? SOCKET_MODE_OWNER : SOCKET_MODE_GROUP);

  // lstat on the socket, or null when the path is not there. A status command
  // must report a missing socket rather than fail on it.
  function socketStat(file) {
    try {
      const stat = lstatSync(file);
      return stat.isSocket() ? stat : null;
    } catch {
      return null;
    }
  }

  // The group is set and then the mode, so the socket is never briefly
  // group-writable under the wrong group.
  function shareSocket(file, mode, { setGroup } = {}) {
    const gid = setGroup && (mode & 0o060) !== 0 ? setGroup(file) : null;
    if (gid !== null) chownSync(file, process.getuid(), gid);
    chmodSync(file, mode);
    return gid;
  }

  // The socket's ownership is the custody here, so a pairing record pins
  // nothing beyond the broker uid and a connection needs no trust argument.
  const connect = (file) => net.createConnection(file);
  const brokerPin = () => ({});

  return Object.freeze({ assertBrokerSocket, assertPrivateBrokerCustody, checkBrokerCustody, removeStaleSocket, prepare, stop: stopBroker, listen, socketModeFor, socketStat, shareSocket, connect, brokerPin });
}

// ---- Windows: a per-account named pipe, and the broker proves itself --------
//
// docs/windows.md, the host's ADR-0046 decision 2. The broker listens on
// `\\.\pipe\<serviceLabel>.<SID>`; Node's net module serves and connects to
// that name as it does a socket path. Pipe names are one namespace for the
// whole machine and Node can neither read a pipe server's identity nor set
// its access list, so the name establishes no custody. Instead the broker
// proves itself on every connection: the first frame is the client's nonce,
// answered by the broker's Ed25519 signature over the pipe name and that
// nonce, checked against the public key the client pinned at pairing. The key
// is pinned from the broker's own state file, not from the wire: the pairing
// client runs as the same account and reads it there, so there is no trust on
// first use. After the handshake the wire is the macOS one.

export const IDENTITY_FILE = 'identity.json';
export const IDENTITY_KEY_FILE = 'identity.key';
export const PIPE_PREFIX = '\\\\.\\pipe\\';
const NONCE = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+=*$/;

// The bytes the broker signs: a fixed tag, the pipe name and the nonce, each
// on its own line, so a signature made for one pipe cannot answer for another.
export const handshakeMessage = (pipe, nonce) => Buffer.from(`agent-comms broker handshake v1\n${pipe}\n${nonce}\n`, 'utf8');

export function pipeNameFor(file, { label = HOST_CONFIG.serviceLabel, sid } = {}) {
  // `broker.sock` is the broker's pipe, `\\.\pipe\<label>.<SID>`; any other
  // channel in the broker's paths (the admin socket) keeps its stem between
  // the label and the SID, so the two never collide.
  const stem = path.basename(file).replace(/\.sock$/, '');
  return `${PIPE_PREFIX}${label}.${stem === 'broker' ? '' : `${stem}.`}${sid}`;
}

const publicKeyFrom = (base64) => {
  if (typeof base64 !== 'string' || !BASE64.test(base64)) throw new Error('not base64');
  const key = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
  return key;
};

// The client side of the handshake, wrapped around a raw connection so a
// caller sees one stream that connects only once the broker has proven
// itself: `connect` fires after a verified answer, writes made before it are
// held until then, and an answer that does not verify ends the stream with
// `broker-untrusted`, the error the macOS ownership check raises.
export function clientHandshake(raw, { pipe, brokerKey, nonce = randomBytes(32).toString('hex') }) {
  let verified = false;
  let closed = false;
  const queued = [];
  const channel = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      if (verified) raw.write(chunk, encoding, callback);
      else queued.push([chunk, encoding, callback]);
    },
    final(callback) {
      if (verified) raw.end(callback);
      else callback();
    },
    destroy(error, callback) {
      closed = true;
      raw.destroy();
      callback(error);
    },
  });
  let key;
  try {
    key = publicKeyFrom(brokerKey);
  } catch {
    process.nextTick(() => channel.destroy(new CommsError('broker-untrusted', brokerKey === undefined ? 'no broker key is pinned for this client; pair again' : 'the pinned broker key is not an Ed25519 key; pair again')));
    return channel;
  }
  const refuse = (message) => channel.destroy(new CommsError('broker-untrusted', message));
  let head = Buffer.alloc(0);
  const onAnswer = (chunk) => {
    if (closed) return;
    head = Buffer.concat([head, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const newline = head.indexOf(0x0a);
    if (newline === -1) {
      if (head.length > MAX_LINE_BYTES) refuse('the broker did not answer the handshake');
      return;
    }
    let answer;
    try {
      answer = JSON.parse(head.subarray(0, newline).toString('utf8'));
    } catch {
      answer = null;
    }
    const proof = answer?.v === PROTOCOL_VERSION && typeof answer.proof === 'string' && BASE64.test(answer.proof) ? Buffer.from(answer.proof, 'base64') : null;
    if (!proof || !verify(null, handshakeMessage(pipe, nonce), key, proof)) {
      refuse(`the broker on ${pipe} did not prove it holds the pinned key; it is not the broker this client paired with`);
      return;
    }
    verified = true;
    raw.removeListener('data', onAnswer);
    raw.on('data', (data) => channel.push(data));
    const rest = head.subarray(newline + 1);
    if (rest.length) channel.push(rest);
    for (const [chunk, encoding, callback] of queued.splice(0)) raw.write(chunk, encoding, callback);
    if (channel.writableEnded) raw.end();
    channel.emit('connect');
  };
  raw.on('connect', () => writeLine(raw, { v: PROTOCOL_VERSION, hello: nonce }));
  raw.on('data', onAnswer);
  raw.on('error', (error) => { if (!closed) channel.destroy(error); });
  // A broker that goes away before answering is out of reach, not untrusted:
  // the stream closes with no error and the caller reports the closed
  // connection. After the answer, the end of the raw stream is the end here.
  let ended = false;
  const dropped = () => {
    if (closed) return;
    if (!verified) channel.destroy();
    else if (!ended) {
      ended = true;
      channel.push(null);
    }
  };
  raw.on('end', dropped);
  raw.on('close', dropped);
  return channel;
}

// The broker side: the first line must be a hello carrying a nonce, which is
// answered with the signature; a connection whose first line is anything
// else is refused as a bad request, so an unaware client learns why.
export function answerHello(line, { pipe, privateKey }) {
  if (line?.v !== PROTOCOL_VERSION || typeof line.hello !== 'string' || !NONCE.test(line.hello)) {
    fail('bad-request', 'the first frame on this pipe must be a hello carrying a 32-byte hex nonce');
  }
  return { v: PROTOCOL_VERSION, proof: sign(null, handshakeMessage(pipe, line.hello), privateKey).toString('base64') };
}

export function serveConnection(broker, socket, handler, identity) {
  const { onRequest, refuse } = requestServer(broker, socket, handler);
  let greeted = false;
  lineReader(socket, (line) => {
    if (greeted) {
      onRequest(line);
      return;
    }
    greeted = true;
    try {
      writeLine(socket, answerHello(line, identity));
    } catch (error) {
      refuse(error);
    }
  }, refuse);
}

function createPipeChannel({
  run = spawnSync,
  isolation = createAccountIsolation('win32', { run }),
  label = HOST_CONFIG.serviceLabel,
  createServer = net.createServer,
  createConnection = net.createConnection,
  bind = (server, address, callback) => server.listen(address, callback),
} = {}) {
  const sid = () => isolation.currentUid();
  const pipeName = (file) => pipeNameFor(file, { label, sid: sid() });
  const isSid = (value) => typeof value === 'string' && /^S-1-\d+(?:-\d+)+$/.test(value);
  const identityFile = (state) => path.join(state, IDENTITY_FILE);

  // What a pairing record pins besides the broker SID: the broker's public
  // key, read from its state file. Missing means no broker has run here yet.
  function brokerPin(paths) {
    const file = identityFile(paths.state);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return fail('broker-unreachable', `no broker identity at ${file}; is the broker installed and running?`);
    }
    try {
      const identity = JSON.parse(text);
      if (identity.v !== 1 || identity.algorithm !== 'ed25519') throw new Error('shape');
      publicKeyFrom(identity.publicKey);
      return { brokerKey: identity.publicKey };
    } catch {
      return fail('broker-untrusted', `${file} is not a broker identity; reinstall the broker and pair again`);
    }
  }

  // The keypair lives in the broker's state directory: the public half in
  // identity.json for clients to pin, the private half in identity.key, a
  // file whose access list names this account alone (inheritance removed
  // through icacls) once written. Generated once; a broker keeps its identity
  // across restarts so pairings survive them.
  function ensureIdentity(state, ownerSid) {
    const file = identityFile(state);
    const keyFile = path.join(state, IDENTITY_KEY_FILE);
    const have = [existsSync(file), existsSync(keyFile)];
    if (have[0] !== have[1]) {
      // Never rotate quietly: a new key would make every paired client refuse
      // the broker, so half an identity is reported, not replaced.
      fail('state-dir-untrusted', `${file} and ${keyFile} must both exist or neither; remove the one left to issue a new identity, then pair every client again`);
    }
    if (have[0]) {
      const pin = brokerPin({ state });
      const privateKey = createPrivateKey(readFileSync(keyFile, 'utf8'));
      // A key file that does not match the published half would make every
      // client refuse the broker; say so here rather than on each connection.
      const probe = randomBytes(32).toString('hex');
      if (!verify(null, handshakeMessage('probe', probe), publicKeyFrom(pin.brokerKey), sign(null, handshakeMessage('probe', probe), privateKey))) {
        fail('state-dir-untrusted', `${keyFile} does not match ${file}; remove both to issue a new identity, then pair every client again`);
      }
      return { privateKey, publicKey: pin.brokerKey };
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    writeFileSync(keyFile, pem, { flag: 'wx', mode: 0o600 });
    const restrict = run('icacls.exe', [keyFile, '/inheritance:r', '/grant:r', `*${ownerSid}:F`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (restrict?.status !== 0) {
      rmSync(keyFile, { force: true });
      fail('state-dir-untrusted', `could not restrict ${keyFile} to this account: ${String(restrict?.stderr ?? '').trim() || 'icacls failed'}`);
    }
    writeFileSync(file, `${JSON.stringify({ v: 1, algorithm: 'ed25519', publicKey: spki, createdAt: new Date().toISOString() }, null, 2)}\n`);
    return { privateKey, publicKey: spki };
  }

  // Custody of the pipe is the handshake, made on every connection, so what a
  // client checks before connecting is the pin itself: a SID, this account's
  // (one-account mode is the only mode), and a broker identity to verify
  // against. The directory owners were checked by the broker at start and by
  // the client when it saved its credential.
  function checkBrokerCustody(paths, brokerSid, mode = 'single-account') {
    if (!isSid(brokerSid)) fail('broker-untrusted', 'no broker account is pinned for this client');
    if (mode !== 'single-account') fail('platform-not-implemented', 'persona-accounts (group mode) is not implemented on win32; one-account mode is the only mode on Windows');
    if (brokerSid !== sid()) fail('broker-untrusted', `the pinned broker account ${brokerSid} is not this account; one-account mode is the only mode on Windows`);
    if (!existsSync(identityFile(paths.state))) fail('broker-unreachable', `no broker identity at ${identityFile(paths.state)}; is the broker installed and running?`);
  }

  // Ownership of the broker's directories through Get-Acl: what `prepare`
  // checks for the broker, offered to a caller that wants the full check.
  function assertPrivateBrokerCustody(paths, ownerSid) {
    isolation.assertOwnedDir(paths.shared, ownerSid);
    isolation.assertOwnedDir(paths.proofs, ownerSid);
    isolation.assertOwnedDir(paths.state, ownerSid);
  }

  // There is no socket file whose owner could be read; the pipe is trusted
  // through the handshake. The pin is checked for shape so a caller written
  // against the macOS name still gets a refusal for an unpinned broker.
  function assertBrokerSocket(file, ownerSid, code = 'broker-untrusted') {
    if (!isSid(ownerSid)) fail(code, `no broker account is pinned for ${pipeName(file)}`);
    if (ownerSid !== sid()) fail(code, `${pipeName(file)} belongs to ${ownerSid}, not this account`);
  }

  // Nothing to unlink: a pipe disappears with its server. A probe still stops
  // a second broker, or a stranger, from being joined on the same name.
  async function removeStaleSocket(file) {
    const pipe = pipeName(file);
    const live = await new Promise((resolve) => {
      const probe = createConnection(pipe);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (live) fail('broker-running', `another process is already answering on ${pipe}`);
  }

  function prepare(broker) {
    if (broker.mode !== 'single-account') fail('platform-not-implemented', 'persona-accounts (group mode) is not implemented on win32; run the broker with --single-account');
    const { shared, proofs, state } = broker.paths;
    const owner = sid();
    // The profile's access list is the custody: each directory must be a real
    // directory owned by this account, and there is no mode to set.
    mkdirSync(shared, { recursive: true });
    isolation.assertOwnedDir(shared, owner, { code: 'shared-dir-untrusted' });
    mkdirSync(proofs, { recursive: true });
    isolation.assertOwnedDir(proofs, owner, { code: 'shared-dir-untrusted' });
    mkdirSync(state, { recursive: true });
    isolation.assertOwnedDir(state, owner, { code: 'state-dir-untrusted' });
    const lock = path.join(state, 'broker.lock');
    takeLock(lock, broker.bootedAt);
    broker.lock = lock;
    broker.identity = ensureIdentity(state, owner);
    return owner;
  }

  function listen(broker, file, handler, mode, setGroup) {
    shareSocket(file, mode, { setGroup }); // a group mode is refused before anything listens
    const pipe = pipeName(file);
    const identity = { pipe, privateKey: broker.identity.privateKey };
    const server = createServer((socket) => {
      track(broker, socket);
      serveConnection(broker, socket, handler, identity);
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      bind(server, pipe, () => resolve(server));
    });
  }

  const socketModeFor = (gid) => (gid === null ? SOCKET_MODE_OWNER : fail('platform-not-implemented', 'a group-shared pipe is not implemented on win32; one-account mode is the only mode on Windows'));

  // No socket file exists, so a status has nothing to report for it.
  const socketStat = () => null;

  function shareSocket(file, mode) {
    if ((mode & 0o060) !== 0) fail('platform-not-implemented', 'a group-shared pipe is not implemented on win32; one-account mode is the only mode on Windows');
    return null;
  }

  // `trust` is the pairing record, or what `brokerPin` read for a client that
  // has none yet; its `brokerKey` is what the broker must prove it holds.
  const connect = (file, trust = {}) => {
    const pipe = pipeName(file);
    return clientHandshake(createConnection(pipe), { pipe, brokerKey: trust?.brokerKey });
  };

  return Object.freeze({
    assertBrokerSocket,
    assertPrivateBrokerCustody,
    checkBrokerCustody,
    removeStaleSocket,
    prepare,
    stop: stopBroker,
    listen,
    socketModeFor,
    socketStat,
    shareSocket,
    connect,
    brokerPin,
    pipeName,
    ensureIdentity,
  });
}

export const { assertBrokerSocket, assertPrivateBrokerCustody, checkBrokerCustody, removeStaleSocket, prepare, stop, listen, socketModeFor, socketStat, shareSocket, connect, brokerPin } = createLocalChannel();
