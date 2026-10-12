import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { calculatePair, runPairedGroup } from '../tools/acceptance/diagnostic-mailbox-pairs.mjs';

const sample = (p95Ms = 1) => ({ outcomes: { send: 1200 }, watchOutcomes: { ready: 720 },
  phases: [{ p95Ms, p99Ms: p95Ms, throughput: 100,
    operations: { send: { count: 1200, p95Ms, p99Ms: p95Ms } } }],
  peakTotalRssKiB: 100, shutdownMs: 10 });

test('failed first pair is persisted after both cleaned runs and prevents run three or next mode', async () => {
  const events = [], pairs = [];
  await assert.rejects(async () => {
    for (const mode of ['failed', 'unread']) {
      await runPairedGroup(mode, async revision => {
        events.push(`cleaned:${revision}`);
        return sample(revision === 'new' ? 4 : 1);
      }, async () => events.push('run-retained'), async pair => {
        pairs.push(pair); events.push('pair-retained');
      });
    }
  }, { message: 'budget-failed' });
  assert.deepEqual(events, ['cleaned:old', 'run-retained', 'cleaned:new', 'run-retained', 'pair-retained']);
  assert.equal(pairs.length, 1); assert.equal(pairs[0].passes, false);
  assert.equal(pairs[0].mode, 'failed'); assert.equal(pairs[0].order, 'old-new');
});

test('healthy four runs retain original opposite-order pair results', async () => {
  const runs = [sample(1), sample(2), sample(1.5), sample(1.25)], revisions = [], retained = [];
  const pairs = await runPairedGroup('healthy', async revision => {
    revisions.push(revision); return runs[revisions.length - 1];
  }, async () => {}, async pair => retained.push(pair));
  assert.deepEqual(revisions, ['old', 'new', 'new', 'old']);
  assert.deepEqual(pairs, [calculatePair(runs[0], runs[1], 'healthy', 'old-new'),
    calculatePair(runs[3], runs[2], 'healthy', 'new-old')]);
  assert.deepEqual(retained, pairs); assert.ok(pairs.every(pair => pair.passes));
});

// Optional actual frozen healthy receipt parity, without starting any workload.
if (process.env.COMMS_HEALTHY_RECEIPT_DIR) test('retained healthy receipts reproduce both original pairs exactly', () => {
  const dir = process.env.COMMS_HEALTHY_RECEIPT_DIR;
  const runs = JSON.parse(readFileSync(`${dir}/runs.json`, 'utf8'));
  const result = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8'));
  assert.deepEqual([calculatePair(runs[0], runs[1], 'healthy', 'old-new'),
    calculatePair(runs[3], runs[2], 'healthy', 'new-old')], result.pairs);
});
