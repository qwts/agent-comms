// The Windows branches of the account-isolation and local-channel seams
// (GeniusBar ADR-0046, decisions 1 and 2). Every external call is a fake that
// records what it was handed: nothing here runs whoami.exe, powershell.exe or
// icacls.exe, and no named pipe is opened. The handshake runs over in-memory
// streams and a loopback TCP pair with real Ed25519 keys from node:crypto.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { after, test } from 'node:test';

import { createAccountIsolation } from '../lib/platform/account-isolation.mjs';
import {
  answerHello, clientHandshake, createLocalChannel, handshakeMessage, IDENTITY_FILE, IDENTITY_KEY_FILE, pipeNameFor, serveConnection, STREAMING,
} from '../lib/platform/local-channel.mjs';
import { CommsError } from '../lib/errors.mjs';
import { lineReader, PROTOCOL_VERSION, writeLine } from '../lib/wire.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'ac-win32-channel-'));
after(() => rmSync(root, { recursive: true, force: true }));

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const LABEL = 'org.example.broker';

// whoami.exe answers one CSV line; powershell.exe answers the Get-Acl script
// from the real file system plus an `owners` map, and the NTAccount script
// from `accounts`; icacls.exe records its call. Each call is logged.
function fakeRunner({ sid = SID, owners = new Map(), accounts = { owner: SID }, whoami = null, icacls = null } = {}) {
  const calls = [];
  const unquote = (text) => text.replace(/''/g, "'");
  const run = (file, args, options = {}) => {
    calls.push({ file, args, input: options.input ?? null, stdio: options.stdio });
    if (file === 'whoami.exe') return whoami ?? { status: 0, stdout: `"DESK\\own""er","${sid}"\r\n`, stderr: '' };
    if (file === 'icacls.exe') return icacls ?? { status: 0, stdout: `processed file: ${args[0]}\r\n`, stderr: '' };
    if (file !== 'powershell.exe') return { status: 1, stdout: '', stderr: `'${file}' is not recognized` };
    const script = options.input;
    const lookup = /NTAccount\('((?:[^']|'')*)'\)/.exec(script);
    if (lookup) {
      const name = unquote(lookup[1]);
      return accounts[name] ? { status: 0, stdout: accounts[name], stderr: '' } : { status: 1, stdout: '', stderr: 'Some or all identity references could not be translated.' };
    }
    const list = /foreach \(\$p in @\((.*?)\)\) \{ try/.exec(script);
    if (!list) return { status: 1, stdout: '', stderr: 'no such script' };
    const paths = [...list[1].matchAll(/'((?:[^']|'')*)'/g)].map((match) => unquote(match[1]));
    const lines = paths.map((file) => {
      let stat;
      try {
        stat = lstatSync(file);
      } catch {
        return 'missing';
      }
      return `${owners.get(file) ?? sid}|${stat.isDirectory() ? 'directory' : 'file'}|${stat.isSymbolicLink() ? 'link' : 'real'}`;
    });
    return { status: 0, stdout: `${lines.join('\r\n')}\r\n`, stderr: '' };
  };
  return { run, calls, owners };
}

const powershellCalls = (calls) => calls.filter((call) => call.file === 'powershell.exe');

test('win32 isolation reads the SID from whoami once and refuses an answer it cannot parse', () => {
  const runner = fakeRunner();
  const isolation = createAccountIsolation('win32', { run: runner.run });
  assert.equal(isolation.currentUid(), SID);
  assert.equal(isolation.currentSid(), SID);
  assert.equal(isolation.currentUid(), SID);
  assert.deepEqual(runner.calls, [{ file: 'whoami.exe', args: ['/user', '/fo', 'csv', '/nh'], input: null, stdio: ['ignore', 'pipe', 'pipe'] }]);

  for (const bad of [{ status: 1, stdout: '', stderr: 'ERROR' }, { status: 0, stdout: 'User Name  SID\n', stderr: '' },
    { status: 0, stdout: '"DESK\\owner","not-a-sid"\n', stderr: '' }, { status: 0, stdout: `"S-1-5-21-1-2-3-4","x"\n`, stderr: '' }]) {
    const broken = createAccountIsolation('win32', { run: fakeRunner({ whoami: bad }).run });
    assert.throws(() => broken.currentUid(), { code: 'account-unresolved' });
  }
});

test('win32 isolation resolves an account name to its SID through NTAccount, quoted as a literal', () => {
  const runner = fakeRunner({ accounts: { owner: SID, "o'brien": OTHER, 'DESK\\owner': SID } });
  const isolation = createAccountIsolation('win32', { run: runner.run });
  assert.equal(isolation.uidOf('owner'), SID);
  assert.equal(isolation.sidOf("o'brien"), OTHER);
  assert.equal(isolation.systemUidOf('DESK\\owner'), SID);
  assert.equal(isolation.systemSidOf('nobody'), null);
  assert.throws(() => isolation.uidOf('nobody'), { code: 'usage', message: 'no account named nobody on this machine' });
  assert.throws(() => isolation.uidOf('two\nlines'), { code: 'usage' });
  const scripts = powershellCalls(runner.calls);
  assert.equal(scripts.length, 5);
  for (const call of scripts) {
    assert.deepEqual(call.args, ['-NoProfile', '-NonInteractive', '-Command', '-']);
    assert.ok(call.input.startsWith("$ErrorActionPreference = 'Stop'\n"));
    assert.ok(call.input.endsWith('\n\n'));
  }
  assert.ok(scripts[1].input.includes("NTAccount('o''brien')"), 'the quote is doubled, never a terminator');
  // An answer that is not a SID is not an account.
  const lying = createAccountIsolation('win32', { run: fakeRunner({ accounts: { owner: 'Administrator' } }).run });
  assert.equal(lying.systemUidOf('owner'), null);
});

test('win32 isolation has no groups: persona-accounts is not a Windows mode', () => {
  const isolation = createAccountIsolation('win32', { run: fakeRunner().run });
  for (const operation of ['assertGroupName', 'systemGroupId', 'groupId']) {
    assert.throws(() => isolation[operation]('agents'), { code: 'platform-not-implemented', message: /one-account mode is the only mode on Windows/ });
  }
  assert.equal(isolation.assertAncestors('/anything', OTHER, 'broker-untrusted'), undefined, 'the profile root is the boundary; no ancestor walk');
});

test('win32 isolation round-trips a credential and refuses a directory or file another SID owns', () => {
  const runner = fakeRunner();
  const isolation = createAccountIsolation('win32', { run: runner.run });
  const dir = path.join(root, "client o'dir");
  const paths = { dir, credential: path.join(dir, 'credential.json') };
  assert.throws(() => isolation.loadCredential(paths), { code: 'unpaired' });
  const credential = { account: 'owner', secret: 'secret', brokerUid: SID, brokerKey: 'AAAA', mode: 'single-account' };
  isolation.saveCredential(paths, credential);
  assert.equal(readFileSync(paths.credential, 'utf8'), `${JSON.stringify(credential, null, 2)}\n`);
  assert.deepEqual(isolation.loadCredential(paths), credential);
  // One Get-Acl pass covers the directory and the file, by literal path.
  const load = powershellCalls(runner.calls).at(-1).input;
  assert.ok(load.includes(`@('${dir.replace(/'/g, "''")}', '${paths.credential.replace(/'/g, "''")}')`));
  assert.ok(load.includes('Get-Acl -LiteralPath $p'));
  assert.ok(load.includes('GetOwner([System.Security.Principal.SecurityIdentifier])'));

  runner.owners.set(dir, OTHER);
  assert.throws(() => isolation.loadCredential(paths), { code: 'client-dir-untrusted', message: new RegExp(`owned by ${OTHER}`) });
  assert.throws(() => isolation.saveCredential(paths, credential), { code: 'client-dir-untrusted' });
  runner.owners.delete(dir);
  runner.owners.set(paths.credential, OTHER);
  assert.throws(() => isolation.loadCredential(paths), { code: 'client-dir-untrusted', message: /is not this account's file/ });
  runner.owners.delete(paths.credential);
  // A symlink in place of the directory is not a real directory.
  const linked = path.join(root, 'client-link');
  symlinkSync(dir, linked);
  assert.throws(() => isolation.loadCredential({ dir: linked, credential: path.join(linked, 'credential.json') }), { code: 'client-dir-untrusted', message: /not a real directory/ });
  // A credential that is not JSON reads as unpaired, as on macOS.
  writeFileSync(paths.credential, '{');
  assert.throws(() => isolation.loadCredential(paths), { code: 'unpaired' });
});

test('win32 isolation never trusts Get-Acl output it cannot parse', () => {
  const dir = path.join(root, 'garbled');
  mkdirSync(dir);
  for (const answer of [
    { status: 0, stdout: '', stderr: '' },
    { status: 1, stdout: `${SID}|directory|real\n`, stderr: 'Access denied' },
    { status: 0, stdout: `${SID}|directory|real\nextra line\n`, stderr: '' },
    { status: 0, stdout: 'DESK\\owner|directory|real\n', stderr: '' },
    { status: 0, stdout: `${SID}|folder|real\n`, stderr: '' },
  ]) {
    const isolation = createAccountIsolation('win32', { run: (file, args, options) => (file === 'powershell.exe' ? answer : fakeRunner().run(file, args, options)) });
    assert.throws(() => isolation.assertOwnedDir(dir, SID, { code: 'state-dir-untrusted' }), { code: 'state-dir-untrusted' });
  }
  const isolation = createAccountIsolation('win32', { run: fakeRunner().run });
  assert.deepEqual(isolation.assertOwnedDir(dir, SID), { owner: SID, kind: 'directory', link: false });
  assert.throws(() => isolation.assertOwnedDir(path.join(root, 'nowhere'), SID), { code: 'broker-untrusted', message: /does not exist/ });
  assert.throws(() => isolation.assertOwnedDir(dir, OTHER), { code: 'broker-untrusted', message: new RegExp(`owned by ${SID}, not the broker account ${OTHER}`) });
  assert.throws(() => isolation.assertOwnedDir(`${dir}\n`, SID), { code: 'broker-untrusted', message: /line break/ });
});

test('win32 isolation checks binding and log files by owner, with no mode to read', () => {
  const runner = fakeRunner();
  const isolation = createAccountIsolation('win32', { run: runner.run });
  const binding = path.join(root, 'agent-binding.json');
  writeFileSync(binding, '{}');
  isolation.assertBindingFile(lstatSync(binding), binding);
  runner.owners.set(binding, OTHER);
  assert.throws(() => isolation.assertBindingFile(lstatSync(binding), binding), { code: 'binding-untrusted' });
  assert.throws(() => isolation.assertBindingFile(lstatSync(root), root), { code: 'binding-untrusted' });

  const log = path.join(root, 'events.log');
  isolation.assertLogFile(log, SID); // not written yet: nothing to check
  writeFileSync(log, '');
  isolation.assertLogFile(log, SID);
  assert.throws(() => isolation.assertLogFile(log, OTHER), { code: 'state-dir-untrusted', message: /not the broker's own file/ });
  assert.throws(() => isolation.assertLogFile(root, SID), { code: 'state-dir-untrusted', message: /not a regular file/ });
});

test('win32 isolation consumes a pairing proof owned by the account, fresh, and holding the hash', () => {
  const runner = fakeRunner({ accounts: { owner: SID, guest: OTHER } });
  const isolation = createAccountIsolation('win32', { run: runner.run });
  const proofs = path.join(root, 'pairing');
  mkdirSync(proofs);
  const hash = 'a'.repeat(64);
  const broker = { uidOf: isolation.systemUidOf, now: () => Date.now(), limits: { proofMaxAgeMs: 60_000 } };
  const drop = (name, content = hash) => {
    const file = path.join(proofs, name);
    writeFileSync(file, content);
    return file;
  };
  const good = drop('good.proof');
  assert.equal(isolation.consumePairingProof(good, 'owner', broker, hash), SID);
  assert.ok(!existsSync(good), 'the proof is consumed');

  const foreign = drop('foreign.proof');
  runner.owners.set(foreign, OTHER);
  assert.throws(() => isolation.consumePairingProof(foreign, 'owner', broker, hash), { code: 'pairing-proof-invalid' });
  assert.ok(!existsSync(foreign), 'an invalid proof is removed too');

  const wrongAccount = drop('guest.proof');
  assert.throws(() => isolation.consumePairingProof(wrongAccount, 'guest', broker, hash), { code: 'pairing-proof-invalid' }, 'the file is this account\'s, the request names another');
  const unknown = drop('unknown.proof');
  assert.throws(() => isolation.consumePairingProof(unknown, 'nobody', broker, hash), { code: 'pairing-proof-invalid' });
  const wrongHash = drop('hash.proof', 'b'.repeat(64));
  assert.throws(() => isolation.consumePairingProof(wrongHash, 'owner', broker, hash), { code: 'pairing-proof-invalid' });
  const stale = drop('stale.proof');
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(stale, old, old);
  assert.throws(() => isolation.consumePairingProof(stale, 'owner', broker, hash), { code: 'pairing-proof-invalid' });
  assert.throws(() => isolation.consumePairingProof(path.join(proofs, 'missing.proof'), 'owner', broker, hash), { code: 'pairing-proof-invalid', message: /missing/ });
});

// ---- the local channel ------------------------------------------------------

const brokerPaths = (name) => {
  const base = path.join(root, name);
  return { shared: path.join(base, 'shared'), socket: path.join(base, 'shared', 'broker.sock'), proofs: path.join(base, 'shared', 'pairing'), state: path.join(base, 'broker'), admin: path.join(base, 'broker', 'admin.sock') };
};

const channelFor = (runner = fakeRunner(), options = {}) => createLocalChannel('win32', { run: runner.run, label: LABEL, ...options });

test('win32 channel derives the pipe name from the service label and the SID', () => {
  const paths = brokerPaths('names');
  assert.equal(pipeNameFor(paths.socket, { label: LABEL, sid: SID }), `\\\\.\\pipe\\${LABEL}.${SID}`);
  assert.equal(pipeNameFor(paths.admin, { label: LABEL, sid: SID }), `\\\\.\\pipe\\${LABEL}.admin.${SID}`);
  assert.equal(pipeNameFor('C:\\Users\\owner\\AppData\\Local\\x\\shared\\broker.sock'.split('\\').join(path.sep), { label: 'a.b', sid: 'S-1-5-18' }), '\\\\.\\pipe\\a.b.S-1-5-18');
  const channel = channelFor();
  assert.equal(channel.pipeName(paths.socket), `\\\\.\\pipe\\${LABEL}.${SID}`);
  assert.equal(channel.pipeName(paths.admin), `\\\\.\\pipe\\${LABEL}.admin.${SID}`);
});

// Two in-memory ends of one connection: what the client writes the server
// reads, and the other way round. `connect` is raised by hand, as net would.
function memoryPair() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const client = Duplex.from({ readable: toClient, writable: toServer });
  const server = Duplex.from({ readable: toServer, writable: toClient });
  // Destroying one end aborts the shared streams; a net socket would not
  // report that to the other end, and neither should these.
  server.on('error', () => {});
  client.on('error', () => {});
  return { client, server };
}

const identityPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, brokerKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
};

const request = (channel, body) => new Promise((resolve, reject) => {
  const lines = [];
  channel.on('error', reject);
  channel.on('connect', () => writeLine(channel, { v: PROTOCOL_VERSION, ...body }));
  lineReader(channel, (line) => lines.push(line), reject);
  channel.on('close', () => resolve(lines));
  channel.on('end', () => resolve(lines));
});

const fakeBroker = () => ({ connections: new Set(), servers: [], watchers: new Map(), accountWatchers: new Map(), lock: null });

test('win32 handshake: the broker signs the pipe name and the nonce, and a client with the pinned key is served', async () => {
  const pipe = `\\\\.\\pipe\\${LABEL}.${SID}`;
  const identity = identityPair();
  const { client, server } = memoryPair();
  const served = [];
  serveConnection(fakeBroker(), server, (body) => {
    served.push(body);
    return { pong: body.op };
  }, { pipe, privateKey: identity.privateKey });
  const nonce = randomBytes(32).toString('hex');
  const channel = clientHandshake(client, { pipe, brokerKey: identity.brokerKey, nonce });
  // The request goes out before the answer arrives and is held until it does.
  const answered = request(channel, { op: 'ping', auth: { account: 'owner', secret: 's' } });
  client.emit('connect');
  assert.deepEqual(await answered, [{ ok: true, pong: 'ping' }]);
  assert.deepEqual(served, [{ v: PROTOCOL_VERSION, op: 'ping', auth: { account: 'owner', secret: 's' } }]);

  // The signature covers exactly the tag, the pipe and the nonce.
  const answer = answerHello({ v: PROTOCOL_VERSION, hello: nonce }, { pipe, privateKey: identity.privateKey });
  assert.equal(answer.v, PROTOCOL_VERSION);
  const { verify, createPublicKey } = await import('node:crypto');
  const key = createPublicKey({ key: Buffer.from(identity.brokerKey, 'base64'), format: 'der', type: 'spki' });
  assert.ok(verify(null, handshakeMessage(pipe, nonce), key, Buffer.from(answer.proof, 'base64')));
  assert.ok(!verify(null, handshakeMessage(`${pipe}.other`, nonce), key, Buffer.from(answer.proof, 'base64')));
  assert.equal(handshakeMessage(pipe, nonce).toString(), `agent-comms broker handshake v1\n${pipe}\n${nonce}\n`);
  for (const bad of [{ v: PROTOCOL_VERSION, hello: 'short' }, { v: 2, hello: nonce }, { v: PROTOCOL_VERSION, op: 'ping' }, null]) {
    assert.throws(() => answerHello(bad, { pipe, privateKey: identity.privateKey }), { code: 'bad-request' });
  }
});

test('win32 handshake: a broker with another key, a tampered nonce, or no pinned key is broker-untrusted', async () => {
  const pipe = `\\\\.\\pipe\\${LABEL}.${SID}`;
  const pinned = identityPair();
  const impostor = identityPair();
  const untrusted = async (serve, trust) => {
    const { client, server } = memoryPair();
    serve(server);
    const channel = clientHandshake(client, { pipe, ...trust });
    const outcome = request(channel, { op: 'ping' }).then(() => null, (error) => error);
    client.emit('connect');
    const error = await outcome;
    assert.ok(error instanceof CommsError, 'a typed refusal');
    assert.equal(error.code, 'broker-untrusted');
    return error;
  };
  // Another key on the pinned pipe name: a squatter.
  const squatter = await untrusted((server) => serveConnection(fakeBroker(), server, () => ({}), { pipe, privateKey: impostor.privateKey }), { brokerKey: pinned.brokerKey });
  assert.match(squatter.message, /did not prove it holds the pinned key/);
  // The right key signing a different nonce: a replayed answer.
  await untrusted((server) => {
    lineReader(server, (line) => writeLine(server, answerHello({ ...line, hello: randomBytes(32).toString('hex') }, { pipe, privateKey: pinned.privateKey })), () => {});
  }, { brokerKey: pinned.brokerKey });
  // The right key signing for another pipe name.
  await untrusted((server) => serveConnection(fakeBroker(), server, () => ({}), { pipe: `${pipe}.admin`, privateKey: pinned.privateKey }), { brokerKey: pinned.brokerKey });
  // An answer that is not a handshake at all.
  await untrusted((server) => { server.write(`${JSON.stringify({ ok: false, error: { code: 'bad-request', message: 'x' } })}\n`); }, { brokerKey: pinned.brokerKey });
  // Nothing pinned: a credential from before the pipe transport, or none.
  const unpinned = await untrusted(() => {}, {});
  assert.match(unpinned.message, /no broker key is pinned for this client; pair again/);
  await untrusted(() => {}, { brokerKey: 'not a key' });

  // A broker that closes without answering is unreachable, not untrusted.
  const { client, server } = memoryPair();
  const channel = clientHandshake(client, { pipe, brokerKey: pinned.brokerKey });
  const closed = request(channel, { op: 'ping' });
  client.emit('connect');
  server.end();
  assert.deepEqual(await closed, []);

  // A client that skips the hello is told so, in the protocol's own shape.
  const direct = memoryPair();
  serveConnection(fakeBroker(), direct.server, () => ({}), { pipe, privateKey: pinned.privateKey });
  const refusal = request(direct.client, { op: 'ping' });
  direct.client.emit('connect');
  assert.deepEqual(await refusal, [{ ok: false, error: { code: 'bad-request', message: 'the first frame on this pipe must be a hello carrying a 32-byte hex nonce' } }]);
});

test('win32 prepare checks the directories through Get-Acl, takes the lock, and issues the broker identity once', async () => {
  const runner = fakeRunner();
  const channel = channelFor(runner);
  const paths = brokerPaths('prepare');
  const broker = { ...fakeBroker(), paths, mode: 'single-account' };
  assert.equal(channel.prepare(broker), SID);
  const identityFile = path.join(paths.state, IDENTITY_FILE);
  const keyFile = path.join(paths.state, IDENTITY_KEY_FILE);
  assert.ok(existsSync(paths.shared) && existsSync(paths.proofs) && existsSync(paths.state));
  assert.equal(broker.lock, path.join(paths.state, 'broker.lock'));
  assert.equal(readFileSync(broker.lock, 'utf8'), String(process.pid));
  const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
  assert.deepEqual(Object.keys(identity).sort(), ['algorithm', 'createdAt', 'publicKey', 'v']);
  assert.equal(identity.v, 1);
  assert.equal(identity.algorithm, 'ed25519');
  assert.equal(identity.publicKey, broker.identity.publicKey);
  assert.ok(readFileSync(keyFile, 'utf8').startsWith('-----BEGIN PRIVATE KEY-----'));
  // The private key's access list names this account alone.
  const icacls = runner.calls.filter((call) => call.file === 'icacls.exe');
  assert.deepEqual(icacls.map((call) => call.args), [[keyFile, '/inheritance:r', '/grant:r', `*${SID}:F`]]);
  // Three directories inspected, each by literal path.
  const inspected = powershellCalls(runner.calls).map((call) => /@\('((?:[^']|'')*)'\)/.exec(call.input)[1]);
  assert.deepEqual(inspected, [paths.shared, paths.proofs, paths.state]);
  assert.deepEqual(channel.brokerPin(paths), { brokerKey: identity.publicKey });

  // A second start keeps the identity.
  const lock = broker.lock;
  await channel.stop(broker);
  assert.equal(broker.lock, null);
  assert.ok(!existsSync(lock));
  channel.prepare(broker);
  assert.equal(JSON.parse(readFileSync(identityFile, 'utf8')).publicKey, identity.publicKey);
  assert.equal(runner.calls.filter((call) => call.file === 'icacls.exe').length, 1, 'no new key, no new icacls');
  // While it runs, another broker cannot take the lock.
  assert.throws(() => channel.prepare({ ...fakeBroker(), paths, mode: 'single-account' }), { code: 'broker-running' });
  await channel.stop(broker);

  // Half an identity is reported, never rotated quietly.
  rmSync(keyFile);
  assert.throws(() => channel.prepare(broker), { code: 'state-dir-untrusted', message: /must both exist or neither/ });
  await channel.stop(broker);
  rmSync(identityFile);
  channel.prepare(broker);
  assert.notEqual(JSON.parse(readFileSync(identityFile, 'utf8')).publicKey, identity.publicKey, 'a fresh pair once both are gone');
  await channel.stop(broker);
  // A key file that does not match the published half is reported too.
  writeFileSync(keyFile, identityPair().privateKey.export({ format: 'pem', type: 'pkcs8' }));
  assert.throws(() => channel.prepare(broker), { code: 'state-dir-untrusted', message: /does not match/ });
  await channel.stop(broker);
  rmSync(keyFile);
  rmSync(identityFile);

  // icacls refusing leaves no private key behind.
  const denied = channelFor(fakeRunner({ icacls: { status: 5, stdout: '', stderr: 'Access is denied.' } }));
  assert.throws(() => denied.prepare(broker), { code: 'state-dir-untrusted', message: /could not restrict .*Access is denied/ });
  assert.ok(!existsSync(keyFile) && !existsSync(identityFile));
  await channel.stop(broker);

  // A directory owned by another SID stops the broker before anything else.
  const foreign = fakeRunner();
  foreign.owners.set(paths.state, OTHER);
  assert.throws(() => channelFor(foreign).prepare(broker), { code: 'state-dir-untrusted' });
  foreign.owners.set(paths.shared, OTHER);
  assert.throws(() => channelFor(foreign).prepare(broker), { code: 'shared-dir-untrusted' });
  assert.throws(() => channel.prepare({ ...broker, mode: 'group' }), { code: 'platform-not-implemented' });
});

test('win32 custody before connecting is the pin: a SID, this account, one-account mode, and a broker identity to verify', () => {
  const channel = channelFor();
  const paths = brokerPaths('custody');
  mkdirSync(paths.state, { recursive: true });
  assert.throws(() => channel.checkBrokerCustody(paths, 501, 'single-account'), { code: 'broker-untrusted', message: /no broker account is pinned/ });
  assert.throws(() => channel.checkBrokerCustody(paths, undefined, 'single-account'), { code: 'broker-untrusted' });
  assert.throws(() => channel.checkBrokerCustody(paths, SID, 'group'), { code: 'platform-not-implemented' });
  assert.throws(() => channel.checkBrokerCustody(paths, OTHER, 'single-account'), { code: 'broker-untrusted', message: /not this account/ });
  assert.throws(() => channel.checkBrokerCustody(paths, SID, 'single-account'), { code: 'broker-unreachable', message: /no broker identity/ });
  assert.throws(() => channel.brokerPin(paths), { code: 'broker-unreachable' });
  writeFileSync(path.join(paths.state, IDENTITY_FILE), '{"v":1,"algorithm":"rsa","publicKey":"AAAA"}');
  channel.checkBrokerCustody(paths, SID, 'single-account');
  assert.throws(() => channel.brokerPin(paths), { code: 'broker-untrusted', message: /not a broker identity/ });
  const { brokerKey } = identityPair();
  writeFileSync(path.join(paths.state, IDENTITY_FILE), JSON.stringify({ v: 1, algorithm: 'ed25519', publicKey: brokerKey }));
  assert.deepEqual(channel.brokerPin(paths), { brokerKey });
  channel.checkBrokerCustody(paths, SID); // single-account is the default mode

  // The macOS names keep a meaning: no socket file, no group, no mode to set.
  assert.equal(channel.socketStat(paths.socket), null);
  assert.equal(channel.socketModeFor(null), 0o600);
  assert.throws(() => channel.socketModeFor(20), { code: 'platform-not-implemented' });
  assert.equal(channel.shareSocket(paths.socket, 0o600), null);
  assert.throws(() => channel.shareSocket(paths.socket, 0o660, { setGroup: () => 20 }), { code: 'platform-not-implemented', message: /one-account mode is the only mode on Windows/ });
  channel.assertBrokerSocket(paths.socket, SID);
  assert.throws(() => channel.assertBrokerSocket(paths.socket, OTHER), { code: 'broker-untrusted' });
  assert.throws(() => channel.assertBrokerSocket(paths.socket, 501, 'client-dir-untrusted'), { code: 'client-dir-untrusted' });
  mkdirSync(paths.proofs, { recursive: true });
  channel.assertPrivateBrokerCustody(paths, SID);
  assert.throws(() => channel.assertPrivateBrokerCustody(paths, OTHER), { code: 'broker-untrusted' });
});

// Nothing opens a real pipe: the server binds a loopback port and the client
// dials it, while the pipe name still travels through the seam as the address.
test('win32 listen and connect run the handshake end to end, and a live pipe stops a second broker', async () => {
  const runner = fakeRunner();
  const paths = brokerPaths('e2e');
  const broker = { ...fakeBroker(), paths, mode: 'single-account' };
  let port = null;
  const bound = [];
  const channel = channelFor(runner, {
    createServer: net.createServer,
    createConnection: () => {
      if (port !== null) return net.createConnection(port, '127.0.0.1');
      // No server yet: what net reports for a pipe nobody serves.
      const absent = new PassThrough();
      process.nextTick(() => absent.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      return absent;
    },
    bind: (server, address, callback) => {
      bound.push(address);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        callback();
      });
    },
  });
  channel.prepare(broker);
  try {
    const pipe = `\\\\.\\pipe\\${LABEL}.${SID}`;
    await channel.removeStaleSocket(paths.socket); // nothing answers yet
    const seen = [];
    const server = await channel.listen(broker, paths.socket, (body, socket) => {
      seen.push(body.op);
      if (body.op === 'watch') {
        writeLine(socket, { event: 'ready' });
        writeLine(socket, { event: 'wake', count: 1 });
        socket.end();
        return STREAMING;
      }
      return { pong: true };
    }, channel.socketModeFor(null), () => null);
    broker.servers.push(server);
    assert.deepEqual(bound, [pipe]);
    const pin = channel.brokerPin(paths);
    const credential = { account: 'owner', secret: 's', brokerUid: SID, ...pin, mode: 'single-account' };
    assert.deepEqual(await request(channel.connect(paths.socket, credential), { op: 'ping' }), [{ ok: true, pong: true }]);
    assert.deepEqual(await request(channel.connect(paths.socket, pin), { op: 'watch' }), [{ event: 'ready' }, { event: 'wake', count: 1 }]);
    const wrong = await request(channel.connect(paths.socket, { brokerKey: identityPair().brokerKey }), { op: 'ping' }).then(() => null, (error) => error);
    assert.equal(wrong?.code, 'broker-untrusted');
    const unpinned = await request(channel.connect(paths.socket, { account: 'owner', brokerUid: SID }), { op: 'ping' }).then(() => null, (error) => error);
    assert.equal(unpinned?.code, 'broker-untrusted');
    assert.deepEqual(seen, ['ping', 'watch'], 'an untrusted broker is never sent the request');
    // The broker is answering, so a second one must not be joined on its name.
    await assert.rejects(channel.removeStaleSocket(paths.socket), { code: 'broker-running', message: new RegExp(`answering on ${pipe.replace(/\\/g, '\\\\')}`) });
    await channel.stop(broker);
    // The sockets' close events land a few ticks after their destroy.
    for (let waited = 0; broker.connections.size > 0 && waited < 100; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(broker.connections.size, 0);
  } finally {
    await channel.stop(broker);
  }
});
