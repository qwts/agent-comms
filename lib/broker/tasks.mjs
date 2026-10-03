// Task claims use compare-and-set revisions and the mailbox event log.
import { randomUUID } from 'node:crypto';

import { fail } from '../errors.mjs';
import { covers } from './shared.mjs';

export const TRANSITIONS = Object.freeze({
  offered: ['accepted', 'rejected', 'canceled'],
  accepted: ['working', 'input-required', 'completed', 'failed', 'canceled'],
  working: ['input-required', 'completed', 'failed', 'canceled'],
  'input-required': ['working', 'completed', 'failed', 'canceled'],
  completed: [], failed: [], rejected: [], canceled: [],
});

const same = (a, b) => a.principal ? a.principal === b.principal
  : !b.principal && a.account === b.account && a.agentId === b.agentId;

export function createTasks(broker, commit, mailbox, pairing = null) {
  function visible(caller, task) {
    if (!same(caller, task.offerer) && !same(caller, task.assignee)) return false;
    if (!caller.principal) return true;
    const peer = same(caller, task.offerer) ? task.assignee : task.offerer;
    return !peer.principal && covers(caller.grant, peer);
  }

  function get(caller, id) {
    const task = broker.state.tasks.get(id);
    if (!task || !visible(caller, task)) fail('unknown-task', 'no task you may access has that id');
    return task;
  }

  function save(caller, task, previous) {
    const to = same(caller, task.offerer) ? task.assignee : task.offerer;
    if (Buffer.byteLength(JSON.stringify(task)) > 96 * 1024) fail('bad-request', 'task is too large once escaped');
    const event = mailbox.taskEvent(caller, to, task, previous);
    // One fsynced record owns both the revision and its event message.
    commit({ t: 'task-event', task, message: event.message, wake: event.wake });
    mailbox.remember(caller);
    event.notify();
    return { task: structuredClone(task) };
  }

  function offer(request) {
    const caller = mailbox.caller(request, { joined: true });
    const assignee = mailbox.resolve(request.to);
    if (!assignee || !mailbox.canSend(caller, assignee)) fail('unknown-recipient', 'no recipient you may offer work to has that address');
    const { acceptanceCriteria, parent = null, dependencies = [], relatedTask = null } = request;
    if (typeof acceptanceCriteria !== 'string' || !acceptanceCriteria.trim()
      || Buffer.byteLength(acceptanceCriteria) > broker.limits.bodyBytes) {
      fail('bad-request', 'acceptanceCriteria must be nonblank text of at most 32 KiB');
    }
    if (!Array.isArray(dependencies) || dependencies.length > broker.limits.refs
      || dependencies.some((id) => typeof id !== 'string') || new Set(dependencies).size !== dependencies.length) {
      fail('bad-request', 'dependencies must be a bounded list of distinct task ids');
    }
    for (const id of [parent, relatedTask, ...dependencies]) {
      if (id !== null) {
        if (typeof id !== 'string') fail('bad-request', 'task links must be task ids');
        get(caller, id);
      }
    }
    const at = broker.now();
    return save(caller, {
      id: `task_${randomUUID()}`, assignee: mailbox.endpoint(assignee), offerer: mailbox.endpoint(caller),
      parent, dependencies: [...dependencies], relatedTask, acceptanceCriteria,
      // Only the A2A gateway may attach wire metadata; a socket caller cannot.
      ...(request.a2a && pairing?.isInbound(request) ? { a2a: structuredClone(request.a2a) } : {}),
      resultReview: 'pending', state: 'offered', revision: 1, createdAt: at, updatedAt: at,
    }, null);
  }

  function transition(request) {
    const caller = mailbox.caller(request);
    const task = get(caller, request.taskId);
    const target = request.state === 'canceled' ? task.offerer : task.assignee;
    if (!same(caller, target)) fail('forbidden', 'only the task participant responsible for this transition may perform it');
    if (!Number.isSafeInteger(request.revision) || request.revision < 1) fail('bad-request', 'revision must be a positive integer');
    if (task.revision !== request.revision) fail('revision-mismatch', 'the task revision has changed; read it again');
    if (!TRANSITIONS[task.state].includes(request.state)) fail('invalid-transition', `cannot move a ${task.state} task to ${request.state}`);
    return save(caller, { ...task, state: request.state, revision: task.revision + 1, updatedAt: broker.now() }, task.state);
  }

  function show(request) {
    const caller = mailbox.caller(request);
    const task = get(caller, request.taskId);
    mailbox.remember(caller);
    return { task: structuredClone(task) };
  }

  function list(request) {
    const caller = mailbox.caller(request);
    const { after = 0, limit = 20, state } = request;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > broker.limits.readPage
      || (state !== undefined && !Object.hasOwn(TRANSITIONS, state))) fail('bad-request', 'invalid task list cursor, limit or state');
    const tasks = [...broker.state.tasks.values()].filter((task) => visible(caller, task) && (!state || task.state === state));
    const page = [];
    let bytes = 0;
    for (const task of tasks.slice(after, after + limit)) {
      const size = Buffer.byteLength(JSON.stringify(task));
      if (page.length && bytes + size > 96 * 1024) break;
      page.push(structuredClone(task));
      bytes += size;
    }
    mailbox.remember(caller);
    return { tasks: page, cursor: after + page.length, remaining: Math.max(0, tasks.length - after - page.length) };
  }

  return { offer, transition, show, list };
}
