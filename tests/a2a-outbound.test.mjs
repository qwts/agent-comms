import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Broker } from '../lib/broker.mjs';
import { createA2AOutbound } from '../lib/broker/a2a-outbound.mjs';
import { wireTask } from '../lib/broker/a2a.mjs';
import { createMailbox } from '../lib/broker/mailbox.mjs';
import { createPairing } from '../lib/broker/pairing.mjs';
import { createTasks } from '../lib/broker/tasks.mjs';
import { sha256 } from '../lib/broker/shared.mjs';
import { apply, EventLog } from '../lib/state.mjs';
import { withBroker } from './helpers/broker.mjs';

const sender = 'agent_00000000-0000-0000-0000-000000000001';
const other = 'agent_00000000-0000-0000-0000-000000000002';

function fixture(t, transport, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-outbound-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const broker = new Broker({ paths: { state: root }, mode: 'single-account' });
  const log = new EventLog(root);
  const commit = (record) => { log.append(record); apply(broker.state, record); };
  commit({ t: 'pair-request', account: 'owner', hash: sha256('secret') });
  commit({ t: 'pair-approve', account: 'owner' });
  for (const agentId of [sender, other]) commit({ t: 'join', account: 'owner', agentId, allow: null });
  const watches = { delivery: () => ({ wake: 'waiting', notify: () => {} }) };
  const pairing = createPairing(broker, commit, watches);
  const mailbox = createMailbox(broker, commit, pairing, watches);
  const tasks = createTasks(broker, commit, mailbox, pairing);
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    // The request and attempt are durable before a transport sees any bytes.
    const durable = log.replay().outbound.get([...broker.state.outbound.keys()].at(-1));
    assert.ok(durable);
    if (body.method === 'SendMessage') assert.ok(durable.attempts > 0);
    assert.equal(init.headers['A2A-Version'], '1.0');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.redirect, 'error');
    calls.push({ url, ...body });
    const result = await transport(body, calls);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
  };
  const token = 'private-bearer-'.repeat(4);
  const credentialFile = path.join(root, 'credential');
  writeFileSync(credentialFile, token, { mode: 0o600 });
  const make = () => createA2AOutbound(broker, commit, mailbox, tasks, { fetch, sleep: async () => {}, ...options });
  const gateway = make();
  const route = { name: 'review', url: 'https://remote.example/a2a', tenant: 'tenant-one',
    credentialFile, allowedSouls: [`owner/${sender}`] };
  gateway.admin({ op: 'a2a-route-add', route });
  const auth = { auth: { account: 'owner', secret: 'secret' }, agentId: sender };
  const send = (extra = {}) => gateway.send({ ...auth, route: 'review', text: 'Review work', ...extra }).request;
  return { root, broker, log, commit, gateway, make, auth, route, calls, token, credentialFile, send, tasks };
}
const remoteTask = (message, state = 'submitted', id = 'opaque/task:1') => ({ kind: 'task', id,
  contextId: message.contextId, status: { state }, history: [message] });

test('pre-connection retry uses one durable logical message; namespace and replay survive', async (t) => {
  let created = 0;
  const f = fixture(t, (body, calls) => {
    if (calls.length === 1) throw Object.assign(new Error('connection refused'), { cause: { code: 'ECONNREFUSED' } });
    created += 1;
    return remoteTask(body.params.message);
  });
  const entry = f.send();
  assert.equal(entry.status, 'pending');
  assert.equal(entry.attempts, 0);
  await f.gateway.drain();
  const sent = f.gateway.show({ ...f.auth, id: entry.id }).request;
  assert.equal(sent.status, 'sent');
  assert.equal(sent.attempts, 2);
  assert.equal(created, 1);
  assert.deepEqual(f.calls[0].params, f.calls[1].params);
  assert.equal(sent.messageId, f.calls[0].params.message.messageId);
  assert.deepEqual(sent.remote, { server: 'https://remote.example/a2a', tenant: 'tenant-one', route: 'review',
    taskId: 'opaque/task:1', contextId: entry.contextId, state: 'offered', originalState: 'submitted' });
  f.broker.state = f.log.replay();
  const restarted = f.make();
  restarted.load();
  assert.deepEqual(restarted.show({ ...f.auth, id: entry.id }).request, sent);
  assert.equal(statSync(path.join(f.root, 'a2a-routes.json')).mode & 0o777, 0o600);
});

test('timeout after submission stays uncertain until ListTasks matches message identity', async (t) => {
  let accepted;
  let discoverable = false;
  const f = fixture(t, (body) => {
    if (body.method === 'SendMessage') {
      accepted = remoteTask(body.params.message);
      return new Promise(() => {}); // Server accepted; response never arrived.
    }
    assert.equal(body.method, 'ListTasks');
    assert.equal(body.params.contextId, accepted.contextId);
    return { tasks: discoverable ? [accepted] : [], nextPageToken: '' };
  }, { timeoutMs: 10 });
  const entry = f.send();
  await f.gateway.drain();
  assert.equal(f.gateway.show({ ...f.auth, id: entry.id }).request.status, 'uncertain');
  f.gateway.tick(); await f.gateway.drain();
  assert.equal(f.gateway.show({ ...f.auth, id: entry.id }).request.status, 'uncertain');
  discoverable = true;
  f.gateway.tick(); await f.gateway.drain();
  assert.equal(f.gateway.show({ ...f.auth, id: entry.id }).request.status, 'sent');
  assert.equal(f.calls.filter((call) => call.method === 'SendMessage').length, 1);
});

test('connection drop and malformed reply are uncertain, never blind retries', async (t) => {
  for (const transport of [() => { throw Object.assign(new Error('drop'), { cause: { code: 'ECONNRESET' } }); }, () => ({})]) {
    const f = fixture(t, transport);
    const entry = f.send();
    await f.gateway.drain();
    assert.equal(f.gateway.show({ ...f.auth, id: entry.id }).request.status, 'uncertain');
    assert.equal(f.calls.length, 1);
  }
});

test('remote states map explicitly with original claim; GetTask and explicit cancel use opaque ID', async (t) => {
  let state = 'submitted';
  const f = fixture(t, (body) => {
    if (body.method === 'SendMessage') return remoteTask(body.params.message);
    assert.equal(body.params.id, 'opaque/task:1');
    if (body.method === 'CancelTask') state = 'canceled';
    return { kind: 'task', id: body.params.id, contextId, status: { state } };
  });
  const entry = f.send();
  const contextId = entry.contextId;
  await f.gateway.drain();
  for (const [claim, local] of [['working', 'working'], ['input-required', 'input-required'],
    ['auth-required', 'auth-required'], ['unknown', 'unknown'], ['future-state', 'unknown']]) {
    state = claim; f.gateway.tick(); await f.gateway.drain();
    const remote = f.gateway.show({ ...f.auth, id: entry.id }).request.remote;
    assert.equal(remote.state, local);
    assert.equal(remote.originalState, claim);
  }
  assert.equal(f.calls.some((call) => call.method === 'CancelTask'), false);
  f.gateway.cancel({ ...f.auth, id: entry.id }); await f.gateway.drain();
  assert.equal(f.gateway.show({ ...f.auth, id: entry.id }).request.status, 'done');
  for (const state of ['completed', 'failed', 'rejected', 'canceled']) {
    const terminal = fixture(t, (body) => remoteTask(body.params.message, state));
    const done = terminal.send(); await terminal.gateway.drain();
    assert.equal(terminal.gateway.show({ ...terminal.auth, id: done.id }).request.remote.originalState, state);
    assert.equal(terminal.gateway.show({ ...terminal.auth, id: done.id }).request.status, 'done');
  }
  // Same local wire mapping used by the inbound gateway.
  assert.equal(wireTask({ id: 'x', state: 'offered', updatedAt: 0 }).status.state, 'submitted');
});

test('route and soul policy deny by default; reads and links retain sender authority', async (t) => {
  const f = fixture(t, (body) => remoteTask(body.params.message));
  assert.throws(() => f.send({ route: 'unconfigured' }), { code: 'forbidden' });
  assert.throws(() => f.send({ agentId: other }), { code: 'forbidden' });
  assert.throws(() => f.send({ relatedTask: 'hidden' }), { code: 'unknown-task' });
  const entry = f.send(); await f.gateway.drain();
  assert.throws(() => f.gateway.show({ ...f.auth, agentId: other, id: entry.id }), { code: 'unknown-request' });
  assert.throws(() => f.gateway.cancel({ ...f.auth, agentId: other, id: entry.id }), { code: 'unknown-request' });
  assert.deepEqual(f.gateway.list({ ...f.auth, agentId: other }).requests, []);
  f.commit({ t: 'leave', agentId: sender });
  assert.throws(() => f.send(), { code: 'not-joined' });
});

test('credentials and remote errors never enter logs or sender errors; unsafe files refused', async (t) => {
  const f = fixture(t, () => { throw new Error(f.token); });
  const entry = f.send(); await f.gateway.drain();
  assert.ok(!readFileSync(f.log.file, 'utf8').includes(f.token));
  assert.ok(!readFileSync(path.join(f.root, 'a2a-routes.json'), 'utf8').includes(f.token));
  assert.ok(!JSON.stringify(f.gateway.show({ ...f.auth, id: entry.id })).includes(f.token));
  chmodSync(f.credentialFile, 0o644);
  assert.throws(() => f.gateway.admin({ op: 'a2a-route-add', route: f.route }), { code: 'unsafe-config' });
  chmodSync(f.credentialFile, 0o600);
  const link = path.join(f.root, 'link'); symlinkSync(f.credentialFile, link);
  assert.throws(() => f.gateway.admin({ op: 'a2a-route-add', route: { ...f.route, credentialFile: link } }), { code: 'unsafe-config' });
  for (const url of ['file:///tmp/task', 'https://token@remote.example/a2a', 'https://remote.example/a2a?token=secret']) {
    assert.throws(() => f.gateway.admin({ op: 'a2a-route-add', route: { ...f.route, url } }), { code: 'bad-request' });
  }
});

test('restart reconciles attempted pending entries; untouched entries resume safely', async (t) => {
  const f = fixture(t, (body) => body.method === 'ListTasks' ? { tasks: [], nextPageToken: '' } : remoteTask(body.params.message));
  const entry = f.send(); await f.gateway.drain();
  // Simulate a crash between fsynced attempt intent and its outcome.
  f.commit({ t: 'a2a-outbound', request: { ...entry, attempts: 1 } });
  f.broker.state = f.log.replay();
  const restarted = f.make(); restarted.start();
  t.after(() => restarted.stop());
  await restarted.drain();
  assert.equal(restarted.show({ ...f.auth, id: entry.id }).request.status, 'uncertain');
  assert.equal(f.calls.filter((call) => call.method === 'SendMessage').length, 1);
  f.commit({ t: 'a2a-outbound', request: { ...entry, id: 'never-sent', messageId: 'stable' } });
  restarted.tick(); await restarted.drain();
  assert.equal(restarted.show({ ...f.auth, id: 'never-sent' }).request.status, 'sent');
});

test('bounded retries, pagination, unrelated context results and route removal', async (t) => {
  const f = fixture(t, () => { throw Object.assign(new Error('no server'), { code: 'ECONNREFUSED' }); });
  const entry = f.send(); await f.gateway.drain();
  assert.equal(f.calls.length, 3);
  assert.equal(f.gateway.show({ ...f.auth, id: entry.id }).request.status, 'failed');
  f.gateway.admin({ op: 'a2a-route-remove', name: 'review' });
  assert.deepEqual(f.gateway.admin({ op: 'a2a-route-list' }).routes, []);
  assert.throws(() => f.send(), { code: 'forbidden' });
  const g = fixture(t, (body) => {
    if (body.method === 'SendMessage') throw new Error('ambiguous');
    if (!body.params.pageToken) return { tasks: [remoteTask({ messageId: 'other', contextId: contextId })], nextPageToken: 'next' };
    return { tasks: [remoteTask(message)], nextPageToken: '' };
  });
  const uncertain = g.send(); const contextId = uncertain.contextId;
  const message = { messageId: uncertain.messageId, contextId };
  await g.gateway.drain(); g.gateway.tick(); await g.gateway.drain();
  assert.equal(g.gateway.show({ ...g.auth, id: uncertain.id }).request.status, 'sent');
  assert.equal(g.calls.at(-1).params.pageToken, 'next');
});

test('message response completes request, unsupported parts fail visibly as uncertain', async (t) => {
  for (const [parts, status] of [[[{ text: 'Result' }], 'done'], [[{ data: { work: 'result' } }], 'uncertain']]) {
    const f = fixture(t, () => ({ kind: 'message', messageId: 'reply', parts }));
    const entry = f.send(); await f.gateway.drain();
    assert.equal(f.gateway.show({ ...f.auth, id: entry.id }).request.status, status);
  }
});

test('CLI owns routes and soul-facing outbox commands', async () => {
  await withBroker(async ({ cli, root, owner, accounts }) => {
    const credentialFile = path.join(root, 'outbound-token');
    writeFileSync(credentialFile, 'bearer-token', { mode: 0o600 });
    const added = await cli(['a2a', 'route', 'add', 'review', '--url', 'https://remote.example/a2a',
      '--credential-file', credentialFile, '--souls', `${owner}/${accounts.alice}`]);
    assert.equal(added.exit, 0);
    assert.equal((await cli(['a2a', 'route', 'list'])).json.routes[0].name, 'review');
    const sent = await cli(['a2a', 'send', 'review', '--text', 'Review'], accounts.alice);
    assert.equal(sent.exit, 0);
    const id = sent.json.request.id;
    assert.equal((await cli(['a2a', 'outbound-show', id], accounts.alice)).json.request.id, id);
    assert.equal((await cli(['a2a', 'outbound-list'], accounts.alice)).json.requests.length, 1);
    assert.equal((await cli(['a2a', 'send', 'review', '--text', 'Review'], accounts.bob)).exit, 1);
    assert.equal((await cli(['a2a', 'route', 'remove', 'review'])).exit, 0);
  }, { brokerOptions: { mode: 'single-account', a2aOutbound: { fetch: async () => { throw new Error('drop'); } } } });
});

test('an outcome log failure cannot turn a delivered attempt into a new send', async (t) => {
  const f = fixture(t, (body) => body.method === 'SendMessage' ? remoteTask(body.params.message) : { tasks: [], nextPageToken: '' });
  let rejectOutcome = true;
  const gateway = createA2AOutbound(f.broker, (record) => {
    if (record.request.status === 'sent' && rejectOutcome) { rejectOutcome = false; throw new Error('disk failure'); }
    f.commit(record);
  }, {
    caller: () => ({ account: 'owner', agentId: sender }),
    endpoint: (soul) => soul,
  }, f.tasks, {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body); f.calls.push(body);
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id,
        result: body.method === 'SendMessage' ? remoteTask(body.params.message) : { tasks: [], nextPageToken: '' } }) };
    },
  });
  gateway.load();
  const entry = gateway.send({ ...f.auth, route: 'review', text: 'Review' }).request;
  await assert.rejects(gateway.drain(), /disk failure/);
  gateway.tick(); await gateway.drain();
  assert.equal(gateway.show({ ...f.auth, id: entry.id }).request.status, 'uncertain');
  assert.equal(f.calls.filter((call) => call.method === 'SendMessage').length, 1);
});

test('related tasks convey context and route permission is checked again before delivery', async (t) => {
  const f = fixture(t, (body) => remoteTask(body.params.message));
  const task = f.tasks.offer({ ...f.auth, to: `owner/${other}`, acceptanceCriteria: 'Review work' }).task;
  const linked = f.send({ relatedTask: task.id }); await f.gateway.drain();
  assert.equal(f.calls[0].params.message.metadata.relatedTask, task.id);
  assert.equal(f.broker.state.tasks.get(task.id).state, 'offered');
  const blocked = f.send();
  f.gateway.admin({ op: 'a2a-route-remove', name: 'review' });
  await f.gateway.drain();
  assert.equal(f.gateway.show({ ...f.auth, id: blocked.id }).request.status, 'failed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.gateway.list(f.auth).requests[0].id, linked.id);
});

test('timer-driven reconciliation backs off per request instead of polling every interval', async (t) => {
  let now = 1_000_000;
  const f = fixture(t, async (body) => {
    if (body.method === 'SendMessage') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return { tasks: [] };
  });
  f.broker.now = () => now;
  f.send();
  await f.gateway.drain();
  const lists = () => f.calls.filter((call) => call.method === 'ListTasks').length;
  const paced = () => { f.gateway.tick({ paced: true }); return f.gateway.drain(); };
  await paced(); // first check is due immediately
  assert.equal(lists(), 1);
  await paced(); // same instant: not due again
  assert.equal(lists(), 1);
  now += 10_000; await paced();
  assert.equal(lists(), 2);
  now += 10_000; await paced(); // delay doubled to 20 s
  assert.equal(lists(), 2);
  now += 10_000; await paced();
  assert.equal(lists(), 3);
});
