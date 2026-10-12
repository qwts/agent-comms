import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Broker } from '../lib/broker.mjs';
import { brokerPaths } from '../lib/paths.mjs';
import { EventLog } from '../lib/state.mjs';
import { loadCredential, watch } from '../lib/client.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { withBroker } from './helpers/broker.mjs';

const CANARY = 'CANARY-private-startup-path-secret';
function fixture(t, diagnostic) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = brokerPaths({ AGENT_COMMS_SHARED_DIR: path.join(root, 'shared'), AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'state') });
  return { root, paths, broker: new Broker({ paths, mode: 'single-account', diagnostic }) };
}
function assertDurations(events) {
  assert.ok(events.every(([, duration]) => Number.isSafeInteger(duration) && duration >= 0));
  assert.ok(!JSON.stringify(events).includes(CANARY));
}

test('broker lifecycle reports actual ready and completed stop once, with no durable diagnostics', async (t) => {
  const events = [];
  const { broker } = fixture(t, (...args) => events.push(args));
  await broker.start();
  t.after(() => broker.stop());
  assert.deepEqual(events.map(([event]) => event), ['broker-started']);
  assert.equal(broker.servers.length, 2);
  assert.ok(!readFileSync(broker.log.file, 'utf8').includes('broker.started'));
  await broker.stop();
  await broker.stop();
  assert.deepEqual(events.map(([event]) => event), ['broker-started', 'broker-stopped']);
  assert.equal(broker.servers.length, 0);
  assertDurations(events);
});

test('overlapping stops report one completed established lifecycle', async (t) => {
  const events = [];
  const { broker } = fixture(t, (...args) => events.push(args));
  await broker.start();
  t.after(() => broker.stop());
  await Promise.all([broker.stop(), broker.stop()]);
  assert.deepEqual(events.map(([event]) => event), ['broker-started', 'broker-stopped']);
  assertDurations(events);
});

test('early startup refusal and replay failure do not masquerade as normal shutdown', async (t) => {
  const events = [];
  const early = fixture(t, (...args) => events.push(args));
  writeFileSync(early.paths.shared, CANARY);
  await assert.rejects(early.broker.start());
  assert.deepEqual(events.map(([event]) => event), ['broker-start-failed']);
  const later = fixture(t, (...args) => events.push(args));
  const failure = new Error(CANARY);
  const replay = t.mock.method(EventLog.prototype, 'replay', () => { throw failure; });
  await assert.rejects(later.broker.start(), (error) => error === failure);
  replay.mock.restore();
  assert.equal(later.broker.lock, null, 'existing startup cleanup must release its lock');
  await later.broker.stop();
  assert.deepEqual(events.map(([event]) => event), ['broker-start-failed', 'broker-start-failed']);
  assertDurations(events);
});

test('failed normal shutdown preserves the original error and can be retried', async (t) => {
  const events = [];
  const { broker } = fixture(t, (...args) => events.push(args));
  await broker.start();
  t.after(() => broker.stop());
  const failure = new Error(CANARY);
  const close = t.mock.method(broker.servers[0], 'close', () => { throw failure; });
  await assert.rejects(broker.stop(), (error) => error === failure);
  close.mock.restore();
  await broker.stop();
  assert.deepEqual(events.map(([event]) => event), ['broker-started', 'broker-stop-failed', 'broker-stopped']);
  assertDurations(events);
});

test('throwing lifecycle observer cannot replace startup or shutdown outcomes', async (t) => {
  const { broker } = fixture(t, () => { throw new Error(CANARY); });
  await broker.start();
  await broker.stop();
  const early = fixture(t, () => { throw new Error('observer'); });
  writeFileSync(early.paths.shared, CANARY);
  await assert.rejects(early.broker.start(), (error) => error.message !== 'observer');
});


test('real authenticated watch reports initial readiness and readiness after broker restart, never refusal', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  await withBroker(async ({ broker, paths, env, accounts }) => {
    const credential = loadCredential(clientPaths(env));
    const reports = [];
    const controller = new AbortController();
    let notifyReady;
    let notifyDisconnected;
    let ready = new Promise((resolve) => { notifyReady = resolve; });
    const disconnected = new Promise((resolve) => { notifyDisconnected = resolve; });
    const watching = watch(paths, credential, { op: 'watch', agentId: accounts.alice }, (event) => {
      if (event.event === 'ready') notifyReady();
      if (event.event === 'disconnected') notifyDisconnected();
    }, { signal: controller.signal, diagnostic: (...args) => reports.push(args) });
    const deadline = new AbortController();
    const expired = delay(5000, undefined, { signal: deadline.signal }).then(() => {
      throw new Error('authenticated watch lifecycle fixture exceeded its owned deadline');
    });
    const completed = watching.then(() => { throw new Error('watch ended before expected readiness'); });
    const waitFor = (event) => Promise.race([event, completed, expired]);
    try {
      await waitFor(ready);
      ready = new Promise((resolve) => { notifyReady = resolve; });
      await broker.stop();
      await waitFor(disconnected);
      await broker.start();
      await waitFor(ready);
      assert.deepEqual(reports.filter(([event]) => ['transport-ready', 'transport-reconnected'].includes(event)).map(([event]) => event),
        ['transport-ready', 'transport-reconnected']);
    } finally {
      controller.abort();
      deadline.abort();
      await Promise.allSettled([watching, expired, completed]);
    }
    const refused = [];
    await assert.rejects(watch(paths, { ...credential, secret: CANARY }, { op: 'watch', agentId: accounts.alice }, () => {
      assert.fail('unauthenticated watch cannot become ready');
    }, { diagnostic: (...args) => refused.push(args) }), { code: 'unauthenticated' });
    assert.deepEqual(refused, []);
  }, { brokerOptions: { mode: 'single-account', diagnostic: () => {} } });
});
