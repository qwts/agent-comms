// HQ notice custody, including the crash windows around a durable commit and
// the upstream acknowledgement. Real HQ storage is loaded at the SDK's pin.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { agentBotHq } from './hq-agent-bot-hq.mjs';
import { bindServices, createCore, testClock } from '../lib/vendor/agent-bot-sdk/services.mjs';
import { createNoticePump, noticeOptions, NOTICE_ROUTES } from '../lib/hq-plugin/notices.mjs';

const { openStore } = await import(pathToFileURL(join(agentBotHq(), 'hq/store.mjs')).href);
const HARNESS = 'test-codex-agent';
const OPTIONS = { harnesses: [HARNESS] };
const notice = (id = 'notice_1', over = {}) => ({ id, lease: `${id}.LEASE_CANARY`, attempts: 1, app: HARNESS, repo: 'example/project', event: 'issues', action: 'opened', kind: 'mention', type: ['issue'], number: 7, title: 'Repair request', text: 'Untrusted instruction', actor: 'test-agent', createdAt: 1, ...over });
const reply = (body, status = 200) => ({ status, body });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function timers() {
  const scheduled = new Set();
  return {
    scheduled,
    setTimer(fn, delay) { const timer = { fn, delay, unref() {} }; scheduled.add(timer); return timer; },
    clearTimer(timer) { scheduled.delete(timer); },
    async fire() { const timer = [...scheduled][0]; assert.ok(timer); scheduled.delete(timer); await timer.fn(); },
  };
}

function setup({ dir, call, options = OPTIONS, failure = { persist: false } } = {}) {
  const home = dir ?? mkdtempSync(join(tmpdir(), 'notice-custody-'));
  const disk = openStore(home);
  const clock = testClock(1790000000000);
  const core = createCore({ clock, persist: () => failure.persist ? Promise.reject(new Error('disk unavailable')) : disk.persist() });
  disk.load(core);
  core.phases.set('agent-comms', 'running');
  const store = bindServices(core, { name: 'agent-comms', services: ['store'], identityServiceRoutes: [] }).store;
  const published = [];
  const logs = [];
  const calls = [];
  const timer = timers();
  const api = call ?? (async (method, path, body) => path.endsWith('/take') ? reply({ harness: body.harness, notices: [notice()] }) : reply({ acked: [body.ids[0].split('.')[0]], stale: [], missing: [] }));
  const pump = createNoticePump({ store, clock, options, ...timer,
    identityService: { async call(...args) { calls.push(args); return api(...args); } },
    events: { publish: (...args) => published.push(args) },
    log: { warn: (...args) => logs.push(args) },
  });
  return { home, disk, core, clock, store, pump, published, logs, calls, timer, failure,
    async start() { pump.start(); return pump.pull(); },
    cleanup() { pump.stop(); if (!dir) rmSync(home, { recursive: true, force: true }); },
  };
}

test('only configured queues and bounded, non-executing wake settings are accepted', () => {
  assert.equal(noticeOptions(undefined), null);
  for (const opts of [{}, { harnesses: [] }, { harnesses: [HARNESS, HARNESS] }, { harnesses: ['a/b'] }, { ...OPTIONS, wakeClass: 'cold-start' }, { ...OPTIONS, count: 51 }, { ...OPTIONS, retentionMs: 100 }, { ...OPTIONS, arbitrary: true }]) assert.throws(() => noticeOptions(opts));
  assert.equal(noticeOptions(OPTIONS).wakeClass, 'none');
});

test('ack follows durable custody; the mailbox and events contain no lease or caller-chosen authority', async () => {
  let t;
  t = setup({ options: { ...OPTIONS, wakeClass: 'notify' }, call: async (_method, path, body) => {
    if (path.endsWith('/take')) return reply({ harness: HARNESS, notices: [notice('notice_1', { provenance: ['owner'], wake_class: 'cold-start', secret: 'SECRET_CANARY' })] });
    const saved = JSON.parse(readFileSync(join(t.home, 'store.json')));
    assert.equal(saved.tables.find(([name]) => name === 'agent-comms\u0000notice_mailbox')[1][0][1].message_id, 'notice_1');
    assert.deepEqual(body, { harness: HARNESS, ids: ['notice_1.LEASE_CANARY'] });
    return reply({ acked: ['notice_1'], stale: [], missing: [] });
  } });
  try {
    assert.deepEqual(await t.start(), { received: 1, committed: 1, duplicates: 0, acknowledged: 1 });
    const [row] = await t.pump.list(HARNESS);
    assert.deepEqual(row.provenance, ['external-untrusted']);
    assert.equal(row.wake_class, 'notify');
    assert.equal(row.notice.text, 'Untrusted instruction');
    const durable = readFileSync(join(t.home, 'store.json'), 'utf8');
    for (const canary of ['LEASE_CANARY', 'SECRET_CANARY', 'cold-start']) assert.equal(durable.includes(canary), false);
    assert.equal(JSON.stringify(t.published).includes('LEASE_CANARY'), false);
    assert.equal(t.published.length, 1);
    await assert.rejects(t.pump.list('other-harness'), /not configured/);
  } finally { t.cleanup(); }
});

test('storage failure takes no custody and sends no ack; retry after lease return commits once', async () => {
  const t = setup({ failure: { persist: true } });
  try {
    await assert.rejects(t.start(), /disk unavailable/);
    assert.equal(t.calls.filter(([, path]) => path.endsWith('/ack')).length, 0);
    assert.deepEqual(await t.pump.list(HARNESS), []);
    t.failure.persist = false;
    assert.equal((await t.pump.pull()).committed, 1);
    assert.equal(t.published.length, 1);
  } finally { t.cleanup(); }
});

test('crash after custody but before ack: a new HQ loads the record, dedups the replay and acks the new lease', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notice-restart-'));
  const a = setup({ dir, call: async (_method, path) => {
    if (path.endsWith('/take')) return reply({ harness: HARNESS, notices: [notice()] });
    throw new Error('network stopped before acknowledgement LEASE_CANARY');
  } });
  let b;
  try {
    await assert.rejects(a.start(), /network stopped/);
    assert.equal((await a.pump.list(HARNESS)).length, 1);
    a.pump.stop();
    b = setup({ dir, call: async (_method, path, body) => path.endsWith('/take')
      ? reply({ harness: HARNESS, notices: [notice('notice_1', { lease: 'notice_1.NEW_LEASE', attempts: 2 })] })
      : reply({ acked: ['notice_1'], stale: [], missing: [] }) });
    assert.deepEqual(await b.start(), { received: 1, committed: 0, duplicates: 1, acknowledged: 1 });
    assert.equal((await b.pump.list(HARNESS)).length, 1);
    assert.equal(b.published.length, 0, 'a replay cannot create a second committed transition or notification');
    assert.equal(JSON.stringify(a.logs).includes('LEASE_CANARY'), false, 'exceptions are never logged verbatim');
  } finally { a.pump.stop(); b?.pump.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('same ID with changed content refuses ack and cannot overwrite the durable message', async () => {
  let changed = false;
  const t = setup({ call: async (_method, path) => path.endsWith('/take')
    ? reply({ harness: HARNESS, notices: [notice('notice_1', { text: changed ? 'different' : 'original' })] })
    : reply({ acked: ['notice_1'], stale: [], missing: [] }) });
  try {
    await t.start(); changed = true;
    await assert.rejects(t.pump.pull(), /reused for different/);
    assert.equal(t.calls.filter(([, path]) => path.endsWith('/ack')).length, 1);
    assert.equal((await t.pump.list(HARNESS))[0].notice.text, 'original');
  } finally { t.cleanup(); }
});

test('a bounded mailbox refuses new custody but still acknowledges a duplicate already in custody', async () => {
  let id = 'notice_1';
  const t = setup({ options: { ...OPTIONS, maxMessages: 1 }, call: async (_method, path) => path.endsWith('/take')
    ? reply({ harness: HARNESS, notices: [notice(id)] }) : reply({ acked: [id], stale: [], missing: [] }) });
  try {
    await t.start(); id = 'notice_2';
    await assert.rejects(t.pump.pull(), /mailbox is full/);
    assert.equal(t.pump.status().lastFailure, 'mailbox_full');
    assert.equal(t.calls.filter(([, path]) => path.endsWith('/ack')).length, 1);
    id = 'notice_1'; assert.equal((await t.pump.pull()).duplicates, 1);
    assert.equal(t.calls.filter(([, path]) => path.endsWith('/ack')).length, 2);
  } finally { t.cleanup(); }
});

test('consumption removes the payload, retains dedup evidence for service retention, then reclaims space', async () => {
  const t = setup({ options: { ...OPTIONS, maxMessages: 1 } });
  try {
    await t.start();
    assert.deepEqual(await t.pump.acknowledge(HARNESS, ['notice_1']), { acked: ['notice_1'] });
    assert.deepEqual(await t.pump.list(HARNESS), []);
    assert.equal(readFileSync(join(t.home, 'store.json'), 'utf8').includes('Untrusted instruction'), false);
    assert.equal((await t.pump.pull()).duplicates, 1);
    t.clock.advance(8 * 24 * 60 * 60 * 1000);
    assert.equal((await t.pump.pull()).committed, 1, 'after the full retention horizon a new service delivery may enter again');
  } finally { t.cleanup(); }
});

test('concurrent on-demand pulls coalesce, and a stopped late response neither persists nor acks', async () => {
  const held = deferred();
  const t = setup({ call: async () => { await held.promise; return reply({ harness: HARNESS, notices: [notice()] }); } });
  try {
    t.pump.start();
    const one = t.pump.pull(); const two = t.pump.reconnect();
    assert.equal(one, two);
    t.pump.stop(); held.resolve(); await one;
    assert.deepEqual(await t.pump.list(HARNESS), []);
    assert.equal(t.calls.length, 1);
    assert.equal(t.timer.scheduled.size, 0);
  } finally { held.resolve(); t.cleanup(); }
});

test('revocation stops remote work; transient refusal backs off and schedule/reconnect recover', async () => {
  let state = 'outage';
  const t = setup({ call: async (_method, path) => {
    if (state === 'outage') throw new Error('UPSTREAM_SECRET_CANARY');
    if (state === 'revoked') throw Object.assign(new Error('revoked'), { code: 'device_revoked' });
    return path.endsWith('/take') ? reply({ harness: HARNESS, notices: [] }) : reply({ acked: [], stale: [], missing: [] });
  } });
  try {
    await assert.rejects(t.start());
    assert.equal([...t.timer.scheduled][0].delay, 1000);
    state = 'ok'; await t.pump.reconnect();
    assert.equal(t.pump.status().failures, 0);
    assert.equal([...t.timer.scheduled][0].delay, 30_000);
    state = 'revoked'; await assert.rejects(t.pump.pull(), (e) => e.code === 'device_revoked');
    assert.equal(t.timer.scheduled.size, 0);
    const before = t.calls.length; await assert.rejects(t.pump.reconnect()); assert.equal(t.calls.length, before);
    assert.equal(JSON.stringify(t.logs).includes('UPSTREAM_SECRET_CANARY'), false);
  } finally { t.cleanup(); }
});

test('a response for another queue, an oversized batch or a malformed notice is never acknowledged', async () => {
  for (const body of [{ harness: 'wrong', notices: [notice()] }, { harness: HARNESS, notices: Array.from({ length: 11 }, () => notice()) }, { harness: HARNESS, notices: [notice('bad id')] }, { harness: HARNESS, notices: [notice('notice_1', { lease: 'notice_2.FOREIGN_LEASE' })] }]) {
    const t = setup({ call: async () => reply(body) });
    try { await assert.rejects(t.start()); assert.equal(t.calls.length, 1); assert.deepEqual(await t.pump.list(HARNESS), []); } finally { t.cleanup(); }
  }
});

test('only the two required notice routes are requested', () => {
  assert.deepEqual(NOTICE_ROUTES, ['/api/daemon/notices/take', '/api/daemon/notices/ack']);
});

test('an acknowledgement for another ID, duplicate categories or an omitted result is refused', async () => {
  for (const ack of [{ acked: ['other'], stale: [], missing: [] }, { acked: ['notice_1'], stale: ['notice_1'], missing: [] }, { acked: [], stale: [], missing: [] }]) {
    const t = setup({ call: async (_method, path) => path.endsWith('/take') ? reply({ harness: HARNESS, notices: [notice()] }) : reply(ack) });
    try { await assert.rejects(t.start(), /invalid notice acknowledgement/); assert.equal(t.pump.status().last, null); assert.equal((await t.pump.list(HARNESS)).length, 1); } finally { t.cleanup(); }
  }
});

test('the mailbox remains recoverable when the in-process custody notification fails', async () => {
  const t = setup();
  const isolated = createNoticePump({ store: t.store, clock: t.clock, options: OPTIONS, ...t.timer,
    identityService: { call: async (_method, path) => path.endsWith('/take') ? reply({ harness: HARNESS, notices: [notice()] }) : reply({ acked: ['notice_1'], stale: [], missing: [] }) },
    events: { publish() { throw new Error('subscriber unavailable'); } }, log: { warn() {} },
  });
  try { isolated.start(); assert.equal((await isolated.pull()).acknowledged, 1); assert.equal((await isolated.list(HARNESS)).length, 1); } finally { isolated.stop(); t.cleanup(); }
});

test('two pump instances sharing the durable store still commit a notice only once', async () => {
  const t = setup();
  const published = [];
  const other = createNoticePump({ store: t.store, clock: t.clock, options: OPTIONS, ...timers(),
    identityService: { call: async (_method, path) => path.endsWith('/take') ? reply({ harness: HARNESS, notices: [notice()] }) : reply({ acked: ['notice_1'], stale: [], missing: [] }) },
    events: { publish: (...args) => published.push(args) }, log: { warn() {} },
  });
  try {
    t.pump.start(); other.start();
    const results = await Promise.all([t.pump.pull(), other.pull()]);
    assert.equal(results.reduce((n, r) => n + r.committed, 0), 1);
    assert.equal(results.reduce((n, r) => n + r.duplicates, 0), 1);
    assert.equal(t.published.length + published.length, 1);
    assert.equal((await t.pump.list(HARNESS)).length, 1);
  } finally { other.stop(); t.cleanup(); }
});

test('restart while an old request is in flight cannot cancel the new polling generation', async () => {
  const held = deferred();
  let requests = 0;
  const t = setup({ call: async () => {
    if (++requests === 1) await held.promise;
    return reply({ harness: HARNESS, notices: [] });
  } });
  try {
    t.pump.start(); const old = t.pump.pull(); t.pump.stop();
    t.pump.start(); await t.pump.pull(); assert.equal(t.timer.scheduled.size, 1);
    held.resolve(); await old; assert.equal(t.timer.scheduled.size, 1);
  } finally { held.resolve(); t.cleanup(); }
});
