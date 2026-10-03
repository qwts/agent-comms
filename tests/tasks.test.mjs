import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Broker } from '../lib/broker.mjs';
import { createMailbox } from '../lib/broker/mailbox.mjs';
import { createPairing } from '../lib/broker/pairing.mjs';
import { createTasks } from '../lib/broker/tasks.mjs';
import { sha256 } from '../lib/broker/shared.mjs';
import { apply, EventLog } from '../lib/state.mjs';
import { admin, call, loadCredential, pairPrincipal } from '../lib/client.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { createPrincipalClient } from '../lib/principal-client.mjs';
import { withBroker } from './helpers/broker.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-tasks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const broker = new Broker({ paths: {}, mode: 'single-account' });
  const log = new EventLog(root);
  const commit = (record) => { log.append(record); apply(broker.state, record); };
  commit({ t: 'pair-request', account: 'owner', hash: sha256('secret') });
  commit({ t: 'pair-approve', account: 'owner' });
  const ids = Array.from({ length: 3 }, () => `agent_${randomUUID()}`);
  for (const agentId of ids) commit({ t: 'join', account: 'owner', agentId });
  const notices = [];
  const watches = { delivery: () => ({ wake: 'waiting', notify: (message) => notices.push(message) }) };
  const pairing = createPairing(broker, commit, watches);
  const mailbox = createMailbox(broker, commit, pairing, watches);
  const tasks = createTasks(broker, commit, mailbox);
  const [offerer, assignee, stranger] = ids.map((agentId) => ({ auth: { account: 'owner', secret: 'secret' }, agentId }));
  const offer = (extra = {}) => tasks.offer({ ...offerer, to: ids[1], acceptanceCriteria: 'Pass the checks', ...extra }).task;
  const move = (task, state, who = state === 'canceled' ? offerer : assignee) =>
    tasks.transition({ ...who, taskId: task.id, revision: task.revision, state }).task;
  return { broker, log, commit, tasks, mailbox, notices, offerer, assignee, stranger, offer, move };
}

const paths = {
  offered: [], accepted: ['accepted'], working: ['accepted', 'working'],
  'input-required': ['accepted', 'working', 'input-required'],
  completed: ['accepted', 'working', 'completed'], failed: ['accepted', 'failed'],
  rejected: ['rejected'], canceled: ['canceled'],
};
const allowed = {
  offered: ['accepted', 'rejected', 'canceled'], accepted: ['working', 'input-required', 'completed', 'failed', 'canceled'],
  working: ['input-required', 'completed', 'failed', 'canceled'], 'input-required': ['working', 'completed', 'failed', 'canceled'],
  completed: [], failed: [], rejected: [], canceled: [],
};

for (const from of Object.keys(paths)) {
  test(`all allowed and refused transitions from ${from}`, (t) => {
    const f = fixture(t);
    for (const to of [...Object.keys(paths), 'unknown', '__proto__']) {
      let task = f.offer();
      for (const state of paths[from]) task = f.move(task, state);
      const before = f.broker.state.messages.size;
      if (allowed[from].includes(to)) {
        const next = f.move(task, to);
        assert.equal(next.state, to);
        assert.equal(next.revision, task.revision + 1);
        assert.equal(f.broker.state.messages.size, before + 1);
      } else {
        assert.throws(() => f.move(task, to), { code: 'invalid-transition' });
        assert.equal(f.broker.state.messages.size, before);
      }
    }
  });
}

test('authorization, stale revisions and authentication refuse without events', (t) => {
  const f = fixture(t);
  const task = f.offer();
  for (const state of ['accepted', 'rejected', 'working', 'input-required', 'completed', 'failed']) {
    assert.throws(() => f.move(task, state, f.offerer), { code: 'forbidden' });
    assert.throws(() => f.move(task, state, f.stranger), { code: 'unknown-task' });
  }
  assert.throws(() => f.move(task, 'canceled', f.assignee), { code: 'forbidden' });
  assert.throws(() => f.move(task, 'canceled', f.stranger), { code: 'unknown-task' });
  assert.throws(() => f.move(task, 'accepted', { ...f.assignee, auth: { account: 'owner', secret: 'wrong' } }), { code: 'unauthenticated' });
  assert.throws(() => f.tasks.offer({ ...f.offerer, sender: f.assignee.agentId, to: f.assignee.agentId }), { code: 'bad-request' });
  const accepted = f.move(task, 'accepted');
  assert.throws(() => f.move(task, 'working'), { code: 'revision-mismatch' });
  assert.throws(() => f.tasks.transition({ ...f.assignee, taskId: task.id, state: 'working' }), { code: 'bad-request' });
  assert.equal(f.tasks.show({ ...f.assignee, taskId: task.id }).task.revision, accepted.revision);
  assert.equal(f.broker.state.messages.size, 2);
  assert.deepEqual(f.tasks.list(f.stranger).tasks, []);
});

test('task metadata, streams and receipts survive replay; retry creates a linked record', (t) => {
  const f = fixture(t);
  const first = f.offer();
  const done = f.move(f.move(first, 'accepted'), 'completed');
  const retry = f.offer({ parent: done.id, dependencies: [done.id], relatedTask: done.id });
  assert.deepEqual(retry.assignee, { account: 'owner', agentId: f.assignee.agentId });
  assert.equal(retry.resultReview, 'pending');
  assert.equal(retry.parent, done.id);
  assert.equal(retry.relatedTask, done.id);
  assert.deepEqual(retry.dependencies, [done.id]);
  const inbox = f.mailbox.read(f.assignee).messages;
  assert.equal(inbox[0].kind, 'task-event');
  assert.equal(inbox[0].correlation, done.id);
  assert.equal(JSON.parse(inbox[0].body).state, 'offered');
  f.mailbox.ack({ ...f.assignee, ids: [inbox[0].id] });
  const replay = f.log.replay();
  assert.deepEqual(replay.tasks, f.broker.state.tasks);
  assert.deepEqual(replay.taskStreams, f.broker.state.taskStreams);
  assert.deepEqual(replay.messages, f.broker.state.messages);
  assert.equal(replay.taskStreams.get(done.id).length, 3);
  assert.equal(replay.acked.get(f.assignee.agentId).has(inbox[0].id), true);
  assert.equal(f.notices.length, 4);
  assert.throws(() => f.offer({ parent: 'task_missing' }), { code: 'unknown-task' });
  assert.throws(() => f.offer({ acceptanceCriteria: '' }), { code: 'bad-request' });
  assert.throws(() => f.offer({ dependencies: [done.id, done.id] }), { code: 'bad-request' });
});

test('a failed durable write or full mailbox changes neither task nor stream', (t) => {
  const f = fixture(t);
  const task = f.offer();
  const before = f.log.replay();
  const append = f.log.append;
  f.log.append = () => { throw new Error('write failed'); };
  assert.throws(() => f.move(task, 'accepted'), /write failed/);
  f.log.append = append;
  assert.deepEqual(f.broker.state.tasks, before.tasks);
  assert.deepEqual(f.broker.state.messages, before.messages);
  f.broker.limits = { ...f.broker.limits, unackedPerMailbox: 0 };
  assert.throws(() => f.move(task, 'accepted'), { code: 'mailbox-full' });
  assert.equal(f.broker.state.tasks.get(task.id).revision, 1);
});

test('CLI lifecycle and principal client task operations use authenticated broker routes', async () => {
  await withBroker(async ({ cli, env, paths, accounts }) => {
    const offered = await cli(['task', 'offer', accounts.bob, '--criteria', 'Ship it', '--json']);
    assert.equal(offered.exit, 0);
    const task = offered.json.task;
    const accept = await cli(['task', 'accept', task.id, '--revision', '1'], accounts.bob);
    assert.equal(accept.json.task.state, 'accepted');
    assert.equal((await cli(['task', 'update', task.id, 'working', '--revision', '1'], accounts.bob)).json.error.code, 'revision-mismatch');
    assert.equal((await cli(['task', 'update', task.id, 'working', '--revision', '2'], accounts.bob)).json.task.state, 'working');
    assert.equal((await cli(['task', 'show', task.id])).json.task.revision, 3);
    assert.equal((await cli(['task', 'list', '--state', 'working'])).json.tasks.length, 1);
    const hostEnv = { ...env, AGENT_COMMS_NO_KEYCHAIN: '1' };
    const pending = await pairPrincipal(paths, clientPaths(hostEnv), 'Task host', hostEnv);
    await admin(paths, { op: 'principal-approve', code: pending.code });
    const client = createPrincipalClient({ env: hostEnv });
    const second = (await client.offerTask({ to: accounts.bob, acceptanceCriteria: 'Review' })).task;
    assert.equal((await client.showTask(second.id)).task.state, 'offered');
    assert.equal((await client.listTasks()).tasks.length, 1);
    await assert.rejects(client.acceptTask(second.id, 1), { code: 'forbidden' });
    await assert.rejects(client.rejectTask(second.id, 1), { code: 'forbidden' });
    await assert.rejects(client.updateTask(second.id, 1, 'working'), { code: 'forbidden' });
    assert.equal((await client.cancelTask(second.id, 1)).task.state, 'canceled');
    const credential = loadCredential(clientPaths(env));
    const third = (await call(paths, credential, { op: 'task-offer', agentId: accounts.bob,
      to: client.principal, acceptanceCriteria: 'Owner review' })).task;
    assert.equal((await client.acceptTask(third.id, 1)).task.state, 'accepted');
    assert.equal((await client.updateTask(third.id, 2, 'completed')).task.state, 'completed');
    const fourth = (await call(paths, credential, { op: 'task-offer', agentId: accounts.bob,
      to: client.principal, acceptanceCriteria: 'Another review' })).task;
    assert.equal((await client.rejectTask(fourth.id, 1)).task.state, 'rejected');
    const fifth = (await cli(['task', 'offer', accounts.bob, '--criteria', 'Optional'])).json.task;
    assert.equal((await cli(['task', 'cancel', fifth.id, '--revision', '1'])).json.task.state, 'canceled');
    const sixth = (await cli(['task', 'offer', accounts.bob, '--criteria', 'Optional'])).json.task;
    assert.equal((await cli(['task', 'reject', sixth.id, '--revision', '1'], accounts.bob)).json.task.state, 'rejected');
  }, { brokerOptions: { mode: 'single-account' } });
});

test('principal task roles, grants, revocation and impersonation use mailbox authority', (t) => {
  const f = fixture(t);
  const principal = `principal_${randomUUID()}`;
  f.commit({ t: 'principal-request', principal, hash: sha256('host-secret') });
  const host = { auth: { principal, secret: 'host-secret' } };
  assert.throws(() => f.tasks.offer({ ...host, to: f.assignee.agentId, acceptanceCriteria: 'Check' }), { code: 'not-approved' });
  f.commit({ t: 'principal-approve', principal, grant: [f.assignee.agentId] });
  assert.throws(() => f.tasks.offer({ ...host, to: f.offerer.agentId, acceptanceCriteria: 'Check' }), { code: 'unknown-recipient' });
  assert.throws(() => f.tasks.list({ ...host, agentId: f.assignee.agentId }), { code: 'unauthenticated' });
  assert.throws(() => f.tasks.offer({ ...host, sender: principal }), { code: 'unauthenticated' });
  const offered = f.tasks.offer({ ...host, to: f.assignee.agentId, acceptanceCriteria: 'Check', op: 'join' }).task;
  assert.deepEqual(offered.offerer, { principal });
  assert.throws(() => f.move(offered, 'accepted', host), { code: 'forbidden' });
  const canceled = f.move(offered, 'canceled', host);
  assert.equal(canceled.state, 'canceled');
  const assigned = f.tasks.offer({ ...f.assignee, to: principal, acceptanceCriteria: 'Owner check' }).task;
  const accepted = f.move(assigned, 'accepted', host);
  assert.equal(f.move(accepted, 'completed', host).state, 'completed');
  const rejected = f.tasks.offer({ ...f.assignee, to: principal, acceptanceCriteria: 'Owner check' }).task;
  assert.equal(f.move(rejected, 'rejected', host).state, 'rejected');
  assert.equal(f.mailbox.read(host).messages.every((message) => message.to.principal === principal), true);
  f.commit({ t: 'principal-approve', principal, grant: [] });
  assert.throws(() => f.tasks.show({ ...host, taskId: offered.id }), { code: 'unknown-task' });
  assert.deepEqual(f.tasks.list(host).tasks, []);
  f.commit({ t: 'principal-revoke', principal });
  assert.throws(() => f.tasks.list(host), { code: 'unauthenticated' });
});

test('offer policy, account ownership, bounded pages and detached response records', (t) => {
  const f = fixture(t);
  const soul = f.broker.state.souls.get(f.assignee.agentId);
  soul.allow = [];
  assert.throws(() => f.offer(), { code: 'unknown-recipient' });
  soul.allow = null;
  const task = f.offer();
  task.state = 'completed';
  task.assignee.agentId = f.stranger.agentId;
  assert.equal(f.tasks.show({ ...f.offerer, taskId: task.id }).task.state, 'offered');
  f.commit({ t: 'pair-request', account: 'other', hash: sha256('other-secret') });
  f.commit({ t: 'pair-approve', account: 'other' });
  assert.throws(() => f.tasks.show({ auth: { account: 'other', secret: 'other-secret' },
    agentId: f.assignee.agentId, taskId: task.id }), { code: 'not-joined' });
  f.offer();
  const page = f.tasks.list({ ...f.offerer, limit: 1 });
  assert.equal(page.remaining, 1);
  assert.equal(f.tasks.list({ ...f.offerer, after: page.cursor }).tasks.length, 1);
  assert.throws(() => f.tasks.list({ ...f.offerer, state: 'unknown' }), { code: 'bad-request' });
  assert.throws(() => f.offer({ acceptanceCriteria: '\u0000'.repeat(32768) }), { code: 'bad-request' });
  f.commit({ t: 'pair-revoke', account: 'owner' });
  assert.throws(() => f.tasks.show({ ...f.offerer, taskId: task.id }), { code: 'unauthenticated' });
});
