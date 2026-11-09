// Broker mode against the real HQ (ADR-0306; agent-bot-hq plan §9 row 13b
// exit evidence). HQ runs from agent-bot-hq at the vendored SDK's revision,
// with its own store, sockets, hq-admission and hq-tasks, and with this
// plugin serving broker.sock. A member binds by its channel binding and
// commits a task over the socket; a wrong, superseded or expired binding is
// refused; T05 holds over the socket.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { agentBotHq } from './hq-agent-bot-hq.mjs';
import { brokerPlugin } from '../lib/hq-plugin/broker.mjs';

const pkg = await import('../package.json', { with: { type: 'json' } }).then((m) => m.default);
const harness = await import(pathToFileURL(join(agentBotHq(), 'tests/hq-harness.mjs')).href);
const { hello, SOUL, startHQ } = harness;

async function setup(options) {
  const t = await startHQ({ plugins: [brokerPlugin(options)] });
  const entry = await t.entry();
  const admitted = async (over = {}) => {
    const r = (await entry.request('Hello', hello(over))).result;
    const rt = (role) => ({ ...r.admitted_runtimes.find((a) => a.role === role), epoch: r.installation_epoch, generation: r.lease_generation });
    return { lead: rt('lead'), spec: rt('specialist') };
  };
  const { lead, spec } = await admitted();
  const tasks = t.hq.host.provided('hq-tasks');
  let n = 0;
  const offer = async () => {
    n += 1;
    const r = await tasks.offer({ operation_id: `offer_${n}`, objective: 'Repair the seeded issue.', done_criteria: 'Checks pass.', accountable_soul: SOUL, write_scope: ['workspace:scratch'] }, { from: { kind: 'owner' } });
    return r.task_id;
  };
  const record = async (taskId) => (await tasks.get(taskId)).task;
  const request = (rt, task, transition, over = {}) => {
    n += 1;
    return { contract: 'task/v1', request_id: `req_${n}`, task_id: task.task_id, expected_revision: task.revision, installation_epoch: rt.epoch, runtime_id: rt.runtime_id, lease_generation: rt.generation, operation_id: `op_${n}`, transition, ...over };
  };
  const bound = async (rt) => {
    const m = await t.member();
    const res = await m.request('bind', { runtime_id: rt.runtime_id, channel_binding: rt.channel_binding });
    assert.equal(res.ok, true, JSON.stringify(res));
    return m;
  };
  return { ...t, broker: t.hq.host.provided(pkg.name), admitted, lead, spec, offer, record, request, bound };
}

test('HQ runs agent-comms as its broker plugin', async () => {
  const t = await setup();
  try {
    assert.deepEqual(t.hq.host.registrations().servers, [{ key: 'broker', plugin: pkg.name }]);
  } finally { await t.done(); }
});

test('a member bound by its channel binding commits a task over the broker socket; a specialist proposes', async () => {
  const t = await setup();
  try {
    const lead = await t.bound(t.lead);
    const spec = await t.bound(t.spec);
    const taskId = await t.offer();
    for (const to of ['accepted', 'running']) {
      const res = await lead.request('task.commit', t.request(t.lead, await t.record(taskId), to));
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.result.outcome, 'committed');
    }
    const proposed = await spec.request('task.commit', t.request(t.spec, await t.record(taskId), 'completed', { result_ref: 'artifact_spec' }));
    assert.equal(proposed.result.outcome, 'proposal');
    assert.equal((await t.record(taskId)).status, 'running');
    const done = await lead.request('task.commit', t.request(t.lead, await t.record(taskId), 'completed', { result_ref: 'artifact_final' }));
    assert.equal(done.result.status, 'completed');
    assert.equal((await t.record(taskId)).revision, 3);

    // Receipts name the bound runtime as the caller and never carry a binding.
    const commits = t.hq.core.receipts.filter((r) => r.kind === 'task.commit');
    assert.ok(commits.length > 0 && commits.every((r) => r.caller === `runtime:${r.runtime_id}`));
    for (const rt of [t.lead, t.spec]) assert.equal(JSON.stringify(t.hq.core.receipts).includes(rt.channel_binding), false);
  } finally { await t.done(); }
});

test('a frame before bind, a wrong binding, a second bind, a forged runtime and a member offer are refused', async () => {
  const t = await setup();
  try {
    const taskId = await t.offer();
    const m = await t.member();
    assert.equal((await m.request('task.commit', t.request(t.lead, await t.record(taskId), 'accepted'))).refusal.error, 'caller_mismatch');
    assert.equal((await m.request('bind', { runtime_id: t.lead.runtime_id, channel_binding: t.spec.channel_binding })).refusal.error, 'caller_mismatch');
    assert.equal((await m.request('bind', { runtime_id: 'rt_unknown', channel_binding: t.spec.channel_binding })).refusal.error, 'caller_mismatch');
    assert.equal((await m.request('bind', { runtime_id: t.lead.runtime_id })).host_refusal.code, 'host.invalid_request');

    assert.equal((await m.request('bind', { runtime_id: t.spec.runtime_id, channel_binding: t.spec.channel_binding })).ok, true);
    assert.equal((await m.request('bind', { runtime_id: t.lead.runtime_id, channel_binding: t.lead.channel_binding })).host_refusal.code, 'host.invalid_request');
    // Bound as the specialist, it cannot speak for the lead.
    assert.equal((await m.request('task.commit', t.request(t.lead, await t.record(taskId), 'accepted'))).refusal.error, 'caller_mismatch');
    assert.equal((await t.record(taskId)).status, 'offered');

    // An offer's source is the owner, HQ or a peer Soul, never a member.
    const offered = await m.request('task.offer', { operation_id: 'offer_m', objective: 'x', done_criteria: 'y', accountable_soul: SOUL, write_scope: ['workspace:scratch'] });
    assert.equal(offered.host_refusal.code, 'host.invalid_request');
    assert.equal((await m.request('notes.take', {})).host_refusal.code, 'host.unknown_kind');
  } finally { await t.done(); }
});

test('a superseded or expired runtime is refused, at bind and on a connection already bound', async () => {
  const t = await setup();
  try {
    const taskId = await t.offer();
    const lead = await t.bound(t.lead);
    const fresh = await t.admitted({ request_id: 'req_0002' });
    assert.equal((await lead.request('task.commit', t.request(t.lead, await t.record(taskId), 'accepted'))).refusal.error, 'lease_expired');
    const again = await t.member();
    assert.equal((await again.request('bind', { runtime_id: t.lead.runtime_id, channel_binding: t.lead.channel_binding })).refusal.error, 'lease_expired');
    assert.equal((await t.record(taskId)).status, 'offered');

    const now = await t.bound(fresh.lead);
    assert.equal((await now.request('task.commit', t.request(fresh.lead, await t.record(taskId), 'accepted'))).result.outcome, 'committed');
    t.clock.advance(60_001);
    assert.equal((await now.request('task.commit', t.request(fresh.lead, await t.record(taskId), 'running'))).refusal.error, 'lease_expired');
    const late = await t.member();
    assert.equal((await late.request('bind', { runtime_id: fresh.lead.runtime_id, channel_binding: fresh.lead.channel_binding })).refusal.error, 'lease_expired');
  } finally { await t.done(); }
});

test('T05 over the socket: one commit delivered repeatedly, on one connection or two, commits once with a stable receipt', async () => {
  const t = await setup();
  try {
    const taskId = await t.offer();
    const first = await t.bound(t.lead);
    const second = await t.bound(t.lead);
    const req = t.request(t.lead, await t.record(taskId), 'accepted');
    const answers = [];
    for (const m of [first, first, second, first]) answers.push(await m.request('task.commit', req));
    assert.ok(answers.every((a) => a.ok), JSON.stringify(answers));
    assert.equal(new Set(answers.map((a) => JSON.stringify(a.result))).size, 1);
    assert.equal((await t.record(taskId)).revision, 1);
    assert.equal(t.hq.core.receipts.filter((r) => r.kind === 'task.commit' && r.operation_id === req.operation_id).length, 1);
    const changed = await first.request('task.commit', { ...req, evidence_refs: ['check_x'] });
    assert.equal(changed.host_refusal.code, 'host.invalid_request');
    assert.equal((await t.record(taskId)).revision, 1);
  } finally { await t.done(); }
});

test('closing a connection drops its binding, including one that closes while its bind is in flight', async () => {
  let release;
  let held;
  const holding = new Promise((r) => { held = r; });
  let hold = false;
  const t = await setup({ beforeBind: () => (hold ? (held(), new Promise((r) => { release = r; })) : undefined) });
  try {
    const m = await t.bound(t.lead);
    assert.equal(t.broker.boundConnections(), 1);
    await m.close();
    for (let i = 0; i < 50 && t.broker.boundConnections() > 0; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(t.broker.boundConnections(), 0);

    hold = true;
    const late = await t.member();
    late.raw(`${JSON.stringify({ id: 1, op: 'bind', payload: { runtime_id: t.lead.runtime_id, channel_binding: t.lead.channel_binding } })}\n`);
    await holding;
    await late.close();
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    release();
    for (let i = 0; i < 100; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(t.hq.core.receipts.filter((r) => r.kind === 'hq.bind').length, 2, 'both binds ran');
    assert.equal(t.broker.boundConnections(), 0, 'and closed() ran after the second');
  } finally { await t.done(); }
});
