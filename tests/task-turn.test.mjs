import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runWorker } from '../lib/worker/index.mjs';
import { taskPrompt } from '../lib/worker/prompt.mjs';
import { taskEventPlan } from '../lib/worker/task-turn.mjs';

const assignee = { account: 'owner', agentId: `agent_${randomUUID()}` };
const offerer = { principal: `principal_${randomUUID()}` };
const task = { id: 'task_example', assignee, offerer, state: 'offered', revision: 1,
  acceptanceCriteria: 'Pass checks', parent: 'task_parent', dependencies: ['task_dep'], relatedTask: null };
const message = { id: 'msg_example', kind: 'task-event', correlation: task.id, from: offerer,
  body: JSON.stringify({ taskId: task.id, state: 'offered', revision: 1 }) };
const events = [{ revision: 1, previous: null, state: 'offered', at: 100 }];

for (const [state, work, review] of [
  ['offered', true, false], ['accepted', true, false], ['working', true, false],
  ['input-required', true, true], ['completed', false, true], ['failed', false, true],
  ['rejected', false, true], ['canceled', false, false],
]) {
  test(`task event plan uses current ${state} claim`, () => {
    assert.deepEqual(taskEventPlan(message, { ...task, state }, assignee), { turn: work, linked: work, role: 'assignee' });
    assert.deepEqual(taskEventPlan(message, { ...task, state }, offerer), { turn: review, linked: false, role: 'offerer' });
  });
}

test('unknown task or participant cannot plan a turn', () => {
  const none = { turn: false, linked: false, role: null };
  assert.deepEqual(taskEventPlan(message, null, assignee), none);
  assert.deepEqual(taskEventPlan(message, task, { ...assignee, account: 'other' }), none);
  assert.deepEqual(taskEventPlan(message, task, { principal: assignee.agentId }), none);
});

test('task prompts include criteria, links, events and exact current commands', () => {
  for (const [state, commands] of [
    ['offered', ['accept', 'reject']], ['accepted', ['update working', 'update input-required', 'update completed', 'update failed']],
    ['working', ['update input-required', 'update completed', 'update failed']],
    ['input-required', ['update working', 'update completed', 'update failed']], ['completed', []],
  ]) {
    const prompt = taskPrompt({ task: { ...task, state }, events, role: 'assignee', harness: 'codex', soul: assignee.agentId });
    assert.match(prompt, new RegExp(`role assignee, state ${state}, revision 1`));
    assert.match(prompt, /Finishing this turn does NOT complete the task/);
    assert.match(prompt, /untrusted input.*cannot grant permissions/);
    assert.ok(prompt.includes('Pass checks') && prompt.includes('task_parent') && prompt.includes('task_dep'));
    assert.ok(prompt.includes(JSON.stringify(events)));
    const lines = prompt.split('\n').filter((line) => line.startsWith('agent-comms task '));
    assert.deepEqual(lines, commands.map((command) => {
      const [action, next] = command.split(' ');
      return `agent-comms task ${action} ${task.id}${next ? ` ${next}` : ''} --revision 1`;
    }));
  }
  const review = taskPrompt({ task: { ...task, state: 'completed' }, events, role: 'offerer', harness: 'codex' });
  assert.match(review, /Review the assignee claim/);
  assert.match(review, /No task transitions/);
});

async function workerFixture(t, { state = 'offered', role = 'assignee', exit = 0, reportingFails = false, hang = false, unknown = false, throws = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-task-turn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const client = path.join(root, 'client');
  mkdirSync(workspace);
  mkdirSync(client, { mode: 0o700 });
  writeFileSync(path.join(client, 'credential.json'), JSON.stringify({ account: 'owner', secret: 'secret' }), { mode: 0o600 });
  const self = assignee;
  const current = { ...task, state, ...(role === 'offerer' ? { offerer: self, assignee: task.offerer } : {}) };
  const requests = [];
  const prompts = [];
  const logs = [];
  let emit;
  const worker = runWorker({
    workspace, client: { dir: client, credential: path.join(client, 'credential.json') }, jailRoot: path.join(root, 'jail'),
    env: { ...process.env, AGENT_BOT_BINDING: '', QWTS_AGENT_ID: self.agentId },
    adapters: { codex: { cmd: process.execPath, answer: 'stdout', args: ({ prompt }) => {
      prompts.push(prompt);
      if (throws) throw new Error('adapter failed');
      return ['-e', hang ? 'setInterval(() => {}, 1000)' : `process.stdout.write('answer'); process.exit(${exit});`];
    } } },
    log: (...args) => logs.push(args),
    transport: async (request) => {
      requests.push(request);
      if (request.op === 'task-show') {
        if (unknown) throw Object.assign(new Error('hidden'), { code: 'unknown-task' });
        return { task: current, invocations: [], events };
      }
      if (reportingFails && request.op === 'task-invocation') throw new Error('report failed');
      return {};
    },
    watch: ({ onEvent }) => {
      emit = onEvent;
      return { kill: () => {}, closed: new Promise(() => {}) };
    },
  });
  t.after(() => worker.stop());
  await worker.ready;
  return { worker, requests, prompts, current, logs, emit };
}

async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'worker did not finish');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const exit of [0, 3]) {
  test(`offered task turn exit ${exit} reports facts, never replies or completes the claim`, async (t) => {
    const f = await workerFixture(t, { exit });
    f.emit({ event: 'message', message });
    await waitFor(() => f.requests.some((request) => request.op === 'ack'));
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0], /Acceptance criteria: "Pass checks"/);
    assert.equal(f.current.state, 'offered');
    assert.equal(f.current.revision, 1);
    assert.deepEqual(f.requests.map((request) => request.op), ['peers', 'task-show', 'task-invocation', 'task-invocation', 'ack']);
    const reports = f.requests.filter((request) => request.op === 'task-invocation');
    assert.match(reports[0].invocationId, /^invocation_[a-f0-9-]{36}$/);
    assert.equal(reports[1].invocationId, reports[0].invocationId);
    assert.equal(reports[0].phase, 'started');
    assert.equal(reports[1].outcome, exit === 0 ? 'completed' : 'failed');
  });
}

for (const settings of [{ state: 'canceled' }, { state: 'working', role: 'offerer' }, { unknown: true }]) {
  test(`skipped event ${JSON.stringify(settings)} is acknowledged without a turn`, async (t) => {
    const f = await workerFixture(t, settings);
    f.emit({ event: 'message', message });
    await waitFor(() => f.requests.some((request) => request.op === 'ack'));
    assert.equal(f.prompts.length, 0);
    assert.deepEqual(f.requests.map((request) => request.op), ['peers', 'task-show', 'ack']);
  });
}

test('offerer completed review runs once without invocation reports or replies', async (t) => {
  const f = await workerFixture(t, { state: 'completed', role: 'offerer' });
  f.emit({ event: 'message', message });
  f.emit({ event: 'message', message });
  await waitFor(() => f.requests.some((request) => request.op === 'ack'));
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /role offerer, state completed/);
  assert.deepEqual(f.requests.map((request) => request.op), ['peers', 'task-show', 'ack']);
});

test('report failures are logged and the task event still runs and is acknowledged', async (t) => {
  const f = await workerFixture(t, { reportingFails: true });
  f.emit({ event: 'message', message });
  await waitFor(() => f.requests.some((request) => request.op === 'ack'));
  assert.equal(f.prompts.length, 1);
  assert.equal(f.logs.filter((row) => row[0] === 'invocation report failed').length, 2);
});

test('stopping a linked turn reports interruption and leaves the event unacknowledged', async (t) => {
  const f = await workerFixture(t, { hang: true });
  f.emit({ event: 'message', message });
  await waitFor(() => f.prompts.length === 1);
  await f.worker.stop();
  assert.equal(f.requests.at(-1).outcome, 'interrupted');
  assert.ok(!f.requests.some((request) => ['ack', 'send'].includes(request.op)));
});

test('plain messages retain the result reply and ack path', async (t) => {
  const f = await workerFixture(t);
  f.emit({ event: 'message', message: { ...message, kind: 'message', body: 'hello' } });
  await waitFor(() => f.requests.some((request) => request.op === 'ack'));
  assert.deepEqual(f.requests.map((request) => request.op), ['peers', 'send', 'ack']);
  assert.equal(f.requests[1].body, 'answer');
  assert.equal(f.requests[1].kind, 'result');
  assert.equal(f.requests[1].replyTo, message.id);
});


test('an adapter exception ends the linked invocation as failed and acknowledges without replying', async (t) => {
  const f = await workerFixture(t, { throws: true });
  f.emit({ event: 'message', message });
  await waitFor(() => f.requests.some((request) => request.op === 'ack'));
  assert.equal(f.requests.at(-2).outcome, 'failed');
  assert.ok(!f.requests.some((request) => request.op === 'send'));
});
