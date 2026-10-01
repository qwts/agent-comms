// Census and health, read as the owner's human principal (ADR-0007 decisions 1
// and 9). The requests go straight to the sockets: the principal credential is
// the app's to hold, and no client helper carries one yet.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { Broker, sha256 } from '../lib/broker.mjs';
import { brokerPaths } from '../lib/paths.mjs';
import { PROTOCOL_VERSION } from '../lib/wire.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'ac-census-'));
const paths = brokerPaths({
  AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'),
  AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker'),
});
const luna = `agent_${randomUUID()}`;
const heron = `agent_${randomUUID()}`;
const guest = `agent_${randomUUID()}`;
// The broker runs as this account, so a proof file written here proves itself.
const uidOf = () => process.getuid();

let broker;
let owner;
let persona;
let principal;

// One request, one reply line. `keep` leaves a streaming socket open.
function request(file, payload, { keep = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, ...payload })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      if (!keep) socket.destroy();
      resolve({ reply: JSON.parse(buffer.slice(0, end)), socket });
    });
    socket.on('error', reject);
  });
}

async function pairAccount(account) {
  const secret = randomBytes(32).toString('hex');
  const secretHash = sha256(secret);
  const proof = `${randomBytes(16).toString('hex')}.proof`;
  writeFileSync(path.join(paths.proofs, proof), secretHash, { mode: 0o644, flag: 'wx' });
  const { reply } = await request(paths.socket, { op: 'pair-request', account, secretHash, proof });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const approved = await request(paths.admin, { op: 'approve', code: reply.code });
  assert.equal(approved.reply.state, 'approved');
  return { account, secret, code: reply.code };
}

async function pairPrincipal(name) {
  const secret = randomBytes(32).toString('hex');
  const { reply } = await request(paths.socket, {
    op: 'principal-pair-request', auth: owner, name, secretHash: sha256(secret),
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return { principal: reply.principal, secret, code: reply.code };
}

async function approvePrincipal(pending, { grant } = {}) {
  const { reply } = await request(paths.admin, {
    op: 'principal-approve', code: pending.code, ...(grant === undefined ? {} : { grant }),
  });
  assert.equal(reply.state, 'approved', JSON.stringify(reply));
  return { principal: pending.principal, secret: pending.secret };
}

async function join(auth, agentId, fields) {
  const { reply } = await request(paths.socket, { op: 'join', auth, agentId, ...fields });
  assert.equal(reply.ok, true, JSON.stringify(reply));
}

const census = async (auth = principal) => (await request(paths.socket, { op: 'census', auth })).reply;
const health = async (auth = principal) => (await request(paths.socket, { op: 'health', auth })).reply;
const rowOf = (reply, agentId) => reply.souls.find((row) => row.agentId === agentId);
const idsOf = (reply) => reply.souls.map((row) => row.agentId);

// Wait for the broker to see a watch close, so the next census does not race it.
function closeWatch(socket) {
  return new Promise((resolve) => {
    socket.once('close', resolve);
    socket.destroy();
  });
}

before(async () => {
  broker = await new Broker({ paths, uidOf }).start();
  owner = await pairAccount('owner');
  persona = await pairAccount('persona');
  await join(owner, luna, { name: 'luna', harness: 'codex' });
  await join(owner, heron, { name: 'quiet-heron-42', parent: luna });
  await join(persona, guest, { name: 'guest', harness: 'qwen' });
  principal = await approvePrincipal(await pairPrincipal('GeniusBar'));
});

after(async () => {
  await broker.stop();
  rmSync(root, { recursive: true, force: true });
});

test('a principal pairing waits for the owner on the admin socket', async () => {
  const pending = await pairPrincipal('GeniusBar');
  const early = await census({ principal: pending.principal, secret: pending.secret });
  assert.equal(early.error.code, 'not-approved');

  const { reply } = await request(paths.admin, { op: 'principals' });
  const { at, ...row } = reply.principals.find((entry) => entry.principal === pending.principal);
  assert.equal(typeof at, 'number');
  assert.deepEqual(row, {
    principal: pending.principal, name: 'GeniusBar', account: 'owner', grant: null, state: 'pending', code: pending.code,
  });

  // Neither code space approves the other kind of pairing.
  const crossed = await request(paths.admin, { op: 'principal-approve', code: owner.code });
  assert.equal(crossed.reply.error.code, 'unknown-code');
  const accountSide = await request(paths.admin, { op: 'approve', code: pending.code });
  assert.equal(accountSide.reply.error.code, 'unknown-code');

  // Nothing vouches for a request from an account that is not paired.
  const unvouched = await request(paths.socket, {
    op: 'principal-pair-request', auth: { account: 'nobody', secret: 'x' }, secretHash: sha256('y'),
  });
  assert.equal(unvouched.reply.error.code, 'unauthenticated');

  assert.equal((await census(await approvePrincipal(pending))).ok, true);
});

test('census reports one row per soul, subagents included', async () => {
  const reply = await census();
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(idsOf(reply), [luna, heron, guest]);
  assert.deepEqual(rowOf(reply, heron), {
    account: 'owner', agentId: heron, name: 'quiet-heron-42', harness: null,
    parent: luna, presence: 'joined', daemonWatching: false, unacked: 0, lastWake: null, hardened: false, verification: 'claimed',
  });
});

test('census carries presence, mailbox depth, and the last wake outcome', async () => {
  const send = (body) => request(paths.socket, {
    op: 'send', auth: persona, agentId: guest, to: `owner/${luna}`, body, key: `k-${randomUUID()}`,
  });
  assert.equal((await send('are you there')).reply.wake, 'waiting');
  let row = rowOf(await census(), luna);
  assert.deepEqual([row.presence, row.unacked, row.lastWake], ['joined', 1, 'waiting']);

  const { socket } = await request(paths.socket, { op: 'watch', auth: owner, agentId: luna }, { keep: true });
  try {
    assert.equal((await send('you there?')).reply.wake, 'warm');
    row = rowOf(await census(), luna);
    assert.deepEqual([row.presence, row.unacked, row.lastWake], ['watching', 2, 'warm']);
    assert.equal((await health()).watches, 1);
  } finally {
    await closeWatch(socket);
  }

  const read = await request(paths.socket, { op: 'read', auth: owner, agentId: luna });
  const acked = await request(paths.socket, {
    op: 'ack', auth: owner, agentId: luna, ids: read.reply.messages.map((message) => message.id),
  });
  assert.equal(acked.reply.acknowledged, 2);
  row = rowOf(await census(), luna);
  // Acknowledging empties the mailbox; the last wake stays the last delivery.
  assert.deepEqual([row.presence, row.unacked, row.lastWake], ['joined', 0, 'warm']);
});

test('rows are filtered by the principal grant', async () => {
  const byAccount = await approvePrincipal(await pairPrincipal('one account'), { grant: ['owner'] });
  assert.deepEqual(idsOf(await census(byAccount)).sort(), [heron, luna].sort());

  const byAddress = await approvePrincipal(await pairPrincipal('one address'), { grant: [`persona/${guest}`] });
  assert.deepEqual(idsOf(await census(byAddress)), [guest]);

  const bySoul = await approvePrincipal(await pairPrincipal('one soul'), { grant: [heron] });
  assert.deepEqual(idsOf(await census(bySoul)), [heron]);

  const nobody = await approvePrincipal(await pairPrincipal('nobody'), { grant: [] });
  assert.deepEqual((await census(nobody)).souls, []);

  const invalid = await pairPrincipal('invalid grant');
  const refused = await request(paths.admin, { op: 'principal-approve', code: invalid.code, grant: 'owner' });
  assert.equal(refused.reply.error.code, 'bad-request');
});

test('account credentials cannot read the census and principal credentials cannot send', async () => {
  assert.equal((await census(owner)).error.code, 'unauthenticated');
  assert.equal((await census(persona)).error.code, 'unauthenticated');
  assert.equal((await census({ principal: principal.principal, secret: 'wrong' })).error.code, 'unauthenticated');
  assert.equal((await census()).ok, true);

  for (const payload of [
    { op: 'join', agentId: luna },
    { op: 'send', agentId: luna, to: `owner/${heron}`, body: 'as the human', key: `k-${randomUUID()}` },
    { op: 'read', agentId: luna },
    { op: 'ack', agentId: luna, ids: ['msg_none'] },
    { op: 'peers', agentId: luna },
    { op: 'watch', agentId: luna },
  ]) {
    const { reply } = await request(paths.socket, { ...payload, auth: principal });
    assert.equal(reply.error?.code, 'unauthenticated', JSON.stringify(reply));
  }
});

test('health reports uptime, log size, pairing counts, and watches', async () => {
  assert.equal((await health(owner)).error.code, 'unauthenticated');
  const reply = await health();
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(Object.keys(reply).sort(), ['eventLogBytes', 'ok', 'pairings', 'uptimeMs', 'watches']);
  assert.deepEqual(Object.keys(reply.pairings).sort(), ['accounts', 'principals']);
  assert.equal(reply.pairings.accounts, 2);
  assert.ok(reply.pairings.principals >= 2);
  assert.equal(reply.watches, 0);
  assert.ok(reply.uptimeMs >= 0);
  assert.ok(reply.eventLogBytes > 0);
});

test('a soul that left, or whose account was revoked, is present as left', async () => {
  const left = await request(paths.socket, { op: 'leave', auth: persona, agentId: guest });
  assert.equal(left.reply.joined, false);
  assert.equal(rowOf(await census(), guest).presence, 'left');

  const revoked = await request(paths.admin, { op: 'revoke', account: 'persona' });
  assert.equal(revoked.reply.state, 'revoked');
  assert.equal(rowOf(await census(), guest).presence, 'left');
  assert.equal(rowOf(await census(), luna).presence, 'joined');
  assert.equal((await health()).pairings.accounts, 1);
});

test('a principal and its grant survive a restart, and revoking ends them', async () => {
  const narrow = await approvePrincipal(await pairPrincipal('narrow'), { grant: ['owner'] });
  await broker.stop();
  broker = await new Broker({ paths, uidOf }).start();

  assert.deepEqual(idsOf(await census(narrow)).sort(), [heron, luna].sort());
  const { reply } = await request(paths.admin, { op: 'principals' });
  const row = reply.principals.find((entry) => entry.principal === narrow.principal);
  assert.equal(row.state, 'approved');
  assert.deepEqual(row.grant, ['owner']);
  // A code is shown only while the owner still has to act on it.
  assert.equal(row.code, undefined);

  const revoked = await request(paths.admin, { op: 'principal-revoke', principal: narrow.principal });
  assert.equal(revoked.reply.state, 'revoked');
  assert.equal((await census(narrow)).error.code, 'unauthenticated');
  const again = await request(paths.admin, { op: 'principal-revoke', principal: narrow.principal });
  assert.equal(again.reply.error.code, 'unknown-principal');
  assert.equal((await census()).ok, true);
});
