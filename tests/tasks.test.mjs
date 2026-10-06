import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// Each call moves the clock 3 s, so long transition walks stay under the
// per-pair send rate; pass a fixed clock to exercise the limit itself.
function fixture(t, { now = ((at) => () => (at += 3_000))(1_000_000) } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-tasks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const broker = new Broker({ paths: {}, mode: 'single-account', now });
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
    // bob joined under that name, and send resolves it the same way.
    const byName = await cli(['task', 'offer', 'bob', '--criteria', 'By name', '--json']);
    assert.equal(byName.json.task.assignee.agentId, accounts.bob);
    assert.equal((await cli(['task', 'offer', 'nobody', '--criteria', 'Nobody'])).json.error.code, 'unknown-recipient');
    const event = (await cli(['inbox', 'read'], accounts.bob)).json.messages.find((message) => message.correlation === task.id);
    const brief = (await cli(['task', 'brief', event.id], accounts.bob)).json;
    assert.equal(brief.turn, true);
    assert.equal(brief.linked, true);
    assert.match(brief.prompt, /state offered/);
    const invocationId = `invocation_${randomUUID()}`;
    assert.equal((await cli(['task', 'invocation', task.id, '--id', invocationId, '--phase', 'started'], accounts.bob)).json.duplicate, false);
    assert.equal((await cli(['task', 'invocation', task.id, '--id', invocationId, '--phase', 'ended', '--outcome', 'completed'], accounts.bob)).json.duplicate, false);
    assert.equal((await cli(['task', 'show', task.id])).json.invocations[0].outcome, 'completed');
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
    assert.equal((await client.showTask(third.id)).events.length, 1);
    const hostInvocation = `invocation_${randomUUID()}`;
    await client.reportInvocation(third.id, hostInvocation, 'started');
    assert.equal((await client.acceptTask(third.id, 1)).task.state, 'accepted');
    assert.equal((await client.updateTask(third.id, 2, 'completed')).task.state, 'completed');
    await client.reportInvocation(third.id, hostInvocation, 'ended', 'completed');
    assert.equal((await client.showTask(third.id)).invocations[0].outcome, 'completed');
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

test('an offer names its assignee by peer name, agent id or address, and refuses the rest', (t) => {
  const f = fixture(t);
  f.commit({ t: 'join', account: 'owner', agentId: f.assignee.agentId, name: 'codex-r8' });
  f.commit({ t: 'join', account: 'owner', agentId: f.offerer.agentId, name: 'claude' });
  f.commit({ t: 'join', account: 'owner', agentId: f.stranger.agentId, name: 'roaming' });
  const byName = f.offer({ to: 'codex-r8' });
  assert.deepEqual(byName.assignee, { account: 'owner', agentId: f.assignee.agentId });
  assert.deepEqual(f.offer({ to: f.assignee.agentId }).assignee, byName.assignee);
  assert.deepEqual(f.offer({ to: `owner/${f.assignee.agentId}` }).assignee, byName.assignee);
  assert.throws(() => f.offer({ to: 'nobody' }), { code: 'unknown-recipient' });
  assert.throws(() => f.offer({ to: 'owner/nobody' }), { code: 'unknown-recipient' });
  // A name two souls share names nobody, as an unknown address names nobody.
  f.commit({ t: 'join', account: 'owner', agentId: f.stranger.agentId, name: 'codex-r8' });
  assert.throws(() => f.offer({ to: 'codex-r8' }), { code: 'unknown-recipient' });
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

test('task events spend the same per-pair send clock as messages', (t) => {
  const f = fixture(t, { now: () => 1_000_000 });
  for (let i = 0; i < f.broker.limits.sendsPerPairPerMinute; i += 1) f.offer();
  const before = f.broker.state.messages.size;
  assert.throws(() => f.offer(), { code: 'rate-limited' });
  assert.equal(f.broker.state.messages.size, before);
});

test('invocation facts are assignee-only, idempotent and independent of claims', (t) => {
  const f = fixture(t);
  const task = f.offer();
  const request = { taskId: task.id, invocationId: `invocation_${randomUUID()}`, phase: 'started' };
  assert.throws(() => f.tasks.invocation({ ...f.offerer, ...request }), { code: 'forbidden' });
  assert.throws(() => f.tasks.invocation({ ...f.stranger, ...request }), { code: 'unknown-task' });
  const before = f.log.replay();
  assert.deepEqual(f.tasks.invocation({ ...f.assignee, ...request }), { duplicate: false });
  assert.deepEqual(f.tasks.invocation({ ...f.assignee, ...request }), { duplicate: true });
  const ended = { ...f.assignee, ...request, phase: 'ended', outcome: 'completed' };
  assert.deepEqual(f.tasks.invocation(ended), { duplicate: false });
  assert.deepEqual(f.tasks.invocation({ ...ended, outcome: 'failed' }), { duplicate: true });
  const records = readFileSync(f.log.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.t === 'task-invocation');
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => [record.taskId, record.invocationId, record.agentId, record.phase]), [
    [task.id, request.invocationId, f.assignee.agentId, 'started'],
    [task.id, request.invocationId, f.assignee.agentId, 'ended'],
  ]);
  assert.deepEqual(f.broker.state.tasks, before.tasks);
  assert.deepEqual(f.broker.state.taskStreams, before.taskStreams);
  assert.deepEqual(f.broker.state.messages, before.messages);
  assert.equal(f.notices.length, 1);
  const shown = f.tasks.show({ ...f.assignee, taskId: task.id });
  assert.equal(shown.invocations.length, 1);
  assert.equal(shown.invocations[0].agentId, f.assignee.agentId);
  assert.equal(shown.invocations[0].outcome, 'completed');
  assert.ok(shown.invocations[0].startedAt < shown.invocations[0].endedAt);
  assert.deepEqual(shown.events, [{ revision: 1, previous: null, state: 'offered', at: f.notices[0].at }]);
  shown.invocations[0].outcome = 'failed';
  assert.equal(f.tasks.show({ ...f.assignee, taskId: task.id }).invocations[0].outcome, 'completed');
  f.broker.state = f.log.replay();
  assert.deepEqual(f.tasks.invocation(ended), { duplicate: true });
  assert.deepEqual(f.broker.state.taskInvocations, f.log.replay().taskInvocations);
});

test('invocation validation, terminal claims and cap survive replay', (t) => {
  const f = fixture(t);
  let task = f.offer();
  const report = (extra) => f.tasks.invocation({ ...f.assignee, taskId: task.id,
    invocationId: 'invocation_12345678', phase: 'started', ...extra });
  for (const extra of [{ invocationId: 'bad' }, { invocationId: `invocation_${'x'.repeat(65)}` },
    { phase: 'other' }, { outcome: 'completed' }, { phase: 'ended' }, { phase: 'ended', outcome: 'canceled' }]) {
    assert.throws(() => report(extra), { code: 'bad-request' });
  }
  report({});
  task = f.move(f.move(task, 'accepted'), 'completed');
  assert.deepEqual(report({}), { duplicate: true });
  assert.throws(() => report({ invocationId: 'invocation_87654321' }), { code: 'invalid-transition' });
  report({ phase: 'ended', outcome: 'completed' });
  assert.equal(f.tasks.show({ ...f.assignee, taskId: task.id }).invocations[0].outcome, 'completed');
  task = f.offer();
  for (let i = 0; i < 256; i += 1) report({ invocationId: `invocation_${String(i).padStart(8, '0')}` });
  assert.throws(() => report({ invocationId: 'invocation_overflow' }), { code: 'bad-request' });
  report({ invocationId: 'invocation_00000000', phase: 'ended', outcome: 'interrupted' });
  f.broker.state = f.log.replay();
  assert.equal(f.tasks.show({ ...f.assignee, taskId: task.id }).invocations.length, 256);
  assert.throws(() => report({ invocationId: 'invocation_overflow', phase: 'ended', outcome: 'failed' }), { code: 'bad-request' });
});

test('task show returns only the last five stream events, including acknowledged ones', (t) => {
  const f = fixture(t);
  let task = f.offer();
  for (const state of ['accepted', 'working', 'input-required', 'working', 'completed']) task = f.move(task, state);
  const messages = f.mailbox.read(f.offerer).messages;
  f.mailbox.ack({ ...f.offerer, ids: messages.map((message) => message.id) });
  const shown = f.tasks.show({ ...f.offerer, taskId: task.id });
  assert.deepEqual(shown.events.map((event) => event.revision), [2, 3, 4, 5, 6]);
  assert.deepEqual(shown.events.at(-1), { revision: 6, previous: 'working', state: 'completed', at: messages.at(-1).at });
  assert.deepEqual(shown.invocations, []);
  assert.deepEqual(f.tasks.list(f.offerer).tasks, [task]);
});


test('each terminal state refuses a new invocation start but accepts an end fact', (t) => {
  const f = fixture(t);
  for (const state of ['completed', 'failed', 'rejected', 'canceled']) {
    let task = f.offer();
    for (const next of paths[state]) task = f.move(task, next);
    const request = { ...f.assignee, taskId: task.id, invocationId: `invocation_${randomUUID()}` };
    assert.throws(() => f.tasks.invocation({ ...request, phase: 'started' }), { code: 'invalid-transition' });
    assert.deepEqual(f.tasks.invocation({ ...request, phase: 'ended', outcome: 'cancelled' }), { duplicate: false });
  }
});
