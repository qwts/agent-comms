import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionStage, MAX_IN_FLIGHT, REQUEST_DEADLINE_MS } from '../tools/acceptance/windows-capacity-policy.mjs';

function clock() {
  let time = 0;
  return { now: () => time, wait: async (ms) => { time += ms; }, advance: (ms) => { time += ms; } };
}

test('capacity pilot offers the fixed schedule with production request deadline', async () => {
  const timer = clock(), deadlines = [];
  const result = await admissionStage(100, (deadline) => {
    deadlines.push(deadline); return Promise.resolve({ messages: [] });
  }, timer);
  assert.equal(result.qualified, true);
  assert.equal(result.planned, 1000); assert.equal(result.offered, 1000);
  assert.equal(result.admitted, 1000); assert.equal(result.completed, 1000);
  assert.equal(result.elapsedMs, 10_000); assert.equal(result.notOffered, 0);
  assert.ok(deadlines.every((value) => value === REQUEST_DEADLINE_MS));
});

test('slow real calls reach the finite cap without queueing further work', async () => {
  const timer = clock(), release = [];
  let called = 0;
  const result = await admissionStage(100, () => {
    called += 1;
    if (called === 1) setImmediate(() => { for (const resolve of release) resolve({ messages: [] }); });
    return new Promise((resolve) => release.push(resolve));
  }, timer);
  assert.equal(called, MAX_IN_FLIGHT);
  assert.equal(result.peakInFlight, MAX_IN_FLIGHT);
  assert.equal(result.completed, MAX_IN_FLIGHT);
  assert.equal(result.capacityRejected, 1); assert.equal(result.qualified, false);
  assert.equal(result.failure, 'inflight-limit');
  assert.equal(result.notOffered, 1000 - MAX_IN_FLIGHT - 1);
});

test('synchronous custody cost cannot be hidden as queued admission or catch-up traffic', async () => {
  const timer = clock(); let calls = 0;
  const result = await admissionStage(10, () => {
    calls += 1; timer.advance(250); return { messages: [] };
  }, timer);
  assert.equal(calls, 1);
  assert.equal(result.missedOfferIntervals, 1);
  assert.equal(result.failure, 'offer-interval-missed');
  assert.equal(result.qualified, false);
});

test('actual deadline and wrong delivery outcomes stop higher-stage qualification', async () => {
  for (const [call, reason] of [
    [() => Promise.reject(Object.assign(new Error('secret canary'), { code: 'broker-timeout' })), 'request-deadline'],
    [() => ({ messages: [{ body: 'secret canary' }] }), 'unexpected-read-outcome'],
  ]) {
    const result = await admissionStage(1, call, clock());
    assert.equal(result.admitted, 1); assert.equal(result.qualified, false);
    assert.equal(result.failure, reason);
    assert.ok(!JSON.stringify(result).includes('secret canary'));
  }
});

test('unreviewed rate has no calls or waiting side effects', async () => {
  await assert.rejects(admissionStage(50, () => assert.fail(), { wait: () => assert.fail() }), /unsupported-offered-rate/);
});
