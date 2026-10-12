import assert from 'node:assert/strict';

export function calculatePair(old, current, mode, order) {
  assert.deepEqual(old.outcomes, current.outcomes);
  assert.deepEqual(old.watchOutcomes, current.watchOutcomes);
  const deltas = current.phases.map((phase, i) => ({ p95Ms: phase.p95Ms - old.phases[i].p95Ms, p99Ms: phase.p99Ms - old.phases[i].p99Ms,
        throughputRatio: phase.throughput / old.phases[i].throughput,
        operations: Object.fromEntries(Object.entries(phase.operations).map(([name, metric]) => {
          const baseline = old.phases[i].operations[name]; assert.equal(metric.count, baseline.count);
          return [name, { count: metric.count, p95Ms: metric.p95Ms - baseline.p95Ms, p99Ms: metric.p99Ms - baseline.p99Ms }];
        })) }));
  const additionalRssKiB = current.peakTotalRssKiB - old.peakTotalRssKiB;
  return { mode, order, deltas, additionalRssKiB, passes: deltas.every((d) => d.p95Ms <= 2 && d.p99Ms <= 5 && d.throughputRatio >= 0.98
          && Object.values(d.operations).every(metric => metric.p95Ms <= 2 && metric.p99Ms <= 5))
        && additionalRssKiB <= 64 * 1024 && old.shutdownMs <= 2000 && current.shutdownMs <= 2000 };
}

export async function runPairedGroup(mode, run, retainRun, retainPair) {
  const group = [], pairs = [];
  for (const revision of ['old', 'new', 'new', 'old']) {
    const result = await run(revision); // run owns exit, helper cleanup and stdio closure.
    group.push(result);
    await retainRun(result);
    if (group.length !== 2 && group.length !== 4) continue;
    const pair = group.length === 2
      ? calculatePair(group[0], group[1], mode, 'old-new')
      : calculatePair(group[3], group[2], mode, 'new-old');
    pairs.push(pair);
    await retainPair(pair); // Persist the failed receipt before refusing further runs.
    if (!pair.passes) throw new Error('budget-failed');
  }
  return pairs;
}
