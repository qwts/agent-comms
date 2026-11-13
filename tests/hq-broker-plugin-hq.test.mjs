// Broker mode against the real HQ (ADR-0306; agent-bot-hq plan §9 row 13b
// exit evidence). HQ runs from agent-bot-hq at the vendored SDK's revision,
// with its own store, sockets, hq-admission and hq-tasks, and with this
// plugin serving broker.sock. A member binds by its channel binding and
// commits a task over the socket; a wrong, superseded or expired binding is
// refused; T05 holds over the socket.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { agentBotHq } from './hq-agent-bot-hq.mjs';
import { brokerPlugin } from '../lib/hq-plugin/broker.mjs';

const pkg = await import('../package.json', { with: { type: 'json' } }).then((m) => m.default);
const harness = await import(pathToFileURL(join(agentBotHq(), 'tests/hq-harness.mjs')).href);
const { DIGEST, hello, SOUL, startHQ } = harness;
const { bindProof } = await import(pathToFileURL(join(agentBotHq(), 'hq/admission.mjs')).href);

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

// agent-bot-hq plan §9 row 16a, through this plugin. Two endpoint
// directories stand in for two member accounts: HQ identifies the caller by
// the endpoint a connection arrives on. (HQ's own CI proves the kernel side
// on real accounts.)
async function withAccounts(run) {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  chmodSync(dir, 0o755);
  const accounts = { hqm_a: 61001, hqm_b: 61002 };
  const gids = {};
  for (const account of Object.keys(accounts)) {
    mkdirSync(join(dir, account));
    chmodSync(join(dir, account), 0o2750);
    gids[account] = statSync(join(dir, account)).gid;
  }
  const t = await startHQ({
    platform: 'linux',
    accounts: (name) => ({ uid: accounts[name], gid: gids[name], groupMembers: [] }),
    config: { acceptedDefinitions: { [SOUL]: [DIGEST] }, members: { dir, accounts: { [SOUL]: { m_lead: 'hqm_a', m_spec: 'hqm_b' } } } },
    plugins: [brokerPlugin()],
  });
  try {
    const entry = await t.entry();
    const r = (await entry.request('Hello', hello())).result;
    const rt = (role) => ({ ...r.admitted_runtimes.find((a) => a.role === role), epoch: r.installation_epoch, generation: r.lease_generation });
    const on = (account) => t.member(account ? t.status.hq.sockets.members.find((m) => m.account === account).path : undefined);
    const bind = async (conn, runtime, key = runtime.channel_binding) => {
      const challenge = await conn.request('bind.challenge', { runtime_id: runtime.runtime_id });
      assert.equal(challenge.ok, true, JSON.stringify(challenge));
      return conn.request('bind', { runtime_id: runtime.runtime_id, proof: bindProof(key, challenge.result.nonce, runtime.runtime_id) });
    };
    await run({ ...t, lead: rt('lead'), spec: rt('specialist'), on, bind });
  } finally {
    await t.done();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a member with its own account binds by keyed proof from its own endpoint and commits a task', () => withAccounts(async (t) => {
  const lead = await t.on('hqm_a');
  const bound = await t.bind(lead, t.lead);
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.deepEqual(bound.result, { runtime_id: t.lead.runtime_id, member_id: 'm_lead', role: 'lead' });
  const tasks = t.hq.host.provided('hq-tasks');
  const { task_id: taskId } = await tasks.offer({ operation_id: 'offer_1', objective: 'Repair the seeded issue.', done_criteria: 'Checks pass.', accountable_soul: SOUL, write_scope: ['workspace:scratch'] }, { from: { kind: 'owner' } });
  const task = (await tasks.get(taskId)).task;
  const res = await lead.request('task.commit', { contract: 'task/v1', request_id: 'req_1', task_id: taskId, expected_revision: task.revision, installation_epoch: t.lead.epoch, runtime_id: t.lead.runtime_id, lease_generation: t.lead.generation, operation_id: 'op_1', transition: 'accepted' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.outcome, 'committed');
  const receipt = t.hq.core.receipts.find((x) => x.kind === 'hq.bind');
  assert.equal(receipt.caller_account, 'hqm_a');
  assert.equal(JSON.stringify(t.hq.core.receipts).includes(t.lead.channel_binding), false);
}));

test('T01 through the plugin: a copied binding is refused from another account and from the shared socket', () => withAccounts(async (t) => {
  const mismatch = (res) => assert.equal(res.refusal?.error, 'caller_mismatch', JSON.stringify(res));
  // The specialist's account presents the lead's runtime and the lead's binding.
  const other = await t.on('hqm_b');
  mismatch(await t.bind(other, t.lead));
  // The shared socket, with the proof or with the binding in the clear.
  mismatch(await t.bind(await t.on(), t.lead));
  mismatch(await (await t.on()).request('bind', { runtime_id: t.lead.runtime_id, channel_binding: t.lead.channel_binding }));
  // The lead's own endpoint with the binding in the clear, or the wrong key.
  mismatch(await (await t.on('hqm_a')).request('bind', { runtime_id: t.lead.runtime_id, channel_binding: t.lead.channel_binding }));
  mismatch(await t.bind(await t.on('hqm_a'), t.lead, t.spec.channel_binding));
  // A refused connection is not bound, and can still bind as itself.
  mismatch(await other.request('task.directives', {}));
  assert.equal((await t.bind(other, t.spec)).ok, true);
  assert.equal(t.hq.host.provided(pkg.name).boundConnections(), 1);
}));

// Notice custody on the same pinned HQ host/admission/store. Sharing this
// test file also shares one contract-pin verification rather than racing
// separate shallow fetches against HQ's cache.
const root = agentBotHq();
const load = (path) => import(pathToFileURL(join(root, path)).href);
const { createHost } = await load('sdk/host.mjs');
const { createCore, fakeIdentityService, testClock } = await load('sdk/services.mjs');
const { openStore } = await load('hq/store.mjs');
const { admissionPlugin } = await load('hq/admission.mjs');
const { schemas } = harness;
const HARNESS = 'test-codex-agent';
const ID = 'notice-host-restart';

function open(home, { ackFails = false, persistFails = false } = {}) {
  const disk = openStore(home);
  let acks = 0;
  const identity = fakeIdentityService({ routes: {
    'POST /api/daemon/notices/take': () => ({ body: { harness: HARNESS, notices: [{ id: ID, lease: `${ID}.LEASE_CANARY`, type: ['issue'], title: 'Review request' }] } }),
    'POST /api/daemon/notices/ack': () => {
      acks += 1;
      const saved = readFileSync(join(home, 'store.json'), 'utf8');
      assert.ok(saved.includes(ID), 'the real HQ store committed before the identity call');
      assert.equal(saved.includes('LEASE_CANARY'), false);
      if (ackFails) throw new Error('upstream disconnected after custody');
      return { body: { acked: [ID], stale: [], missing: [] } };
    },
  } });
  const core = createCore({ clock: testClock(), identity,
    config: { 'agent-comms': { notices: { harnesses: [HARNESS] } } },
    persist: () => persistFails ? Promise.reject(new Error('durable storage unavailable')) : disk.persist(),
  });
  disk.load(core);
  const host = createHost({ core, plugins: [admissionPlugin({ schemas }), brokerPlugin()] });
  return { core, host, acks: () => acks, pump: () => host.provided('agent-comms').notices };
}

test('plugin reconstruction after durable custody preserves one mailbox sequence and retries only the ack', async () => {
  const home = mkdtempSync(join(tmpdir(), 'notices-host-'));
  const a = open(home, { ackFails: true });
  let b;
  try {
    await a.host.start();
    await assert.rejects(a.pump().pull(), /upstream disconnected/);
    const [original] = await a.pump().list(HARNESS);
    assert.equal(original.sequence, 1);
    await a.host.stop();
    b = open(home); await b.host.start();
    const result = await b.pump().pull();
    assert.deepEqual(result, { received: 1, committed: 0, duplicates: 1, acknowledged: 1 });
    assert.deepEqual(await b.pump().list(HARNESS), [original]);
    assert.equal(b.acks(), 1);
    assert.equal(b.host.status().plugins.find((p) => p.name === 'agent-comms').state, 'running');
  } finally {
    if (a.host.mode !== 'stopped') await a.host.stop().catch(() => {});
    if (b && b.host.mode !== 'stopped') await b.host.stop().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test('the actual plugin sends no ack when HQ cannot commit custody', async () => {
  const home = mkdtempSync(join(tmpdir(), 'notices-host-failure-'));
  const t = open(home, { persistFails: true });
  try {
    await t.host.start();
    await assert.rejects(t.pump().pull(), /durable storage unavailable/);
    assert.equal(t.acks(), 0);
    assert.deepEqual(await t.pump().list(HARNESS), []);
  } finally { await t.host.stop().catch(() => {}); rmSync(home, { recursive: true, force: true }); }
});
