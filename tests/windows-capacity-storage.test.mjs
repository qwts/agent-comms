import assert from 'node:assert/strict';
import test from 'node:test';
import { probePinnedStorage } from '../tools/acceptance/windows-capacity-storage.mjs';

function inputs(failedCall, state = { seq: 0 }) {
  const calls = [], phases = []; let dispose, cleanupRegistered = false;
  function call(name) {
    calls.push(name);
    if (name === failedCall) throw new Error('CANARY-private-source-body');
  }
  const paths = { state: 'CANARY-private-state' };
  class Broker {
    constructor(options) { assert.deepEqual(options, { paths, mode: 'single-account' }); call('broker'); }
    maintain(options) { assert.equal(this.state, state); assert.equal(this.log.file, 'CANARY-event-file'); assert.deepEqual(options, { compact: true }); call('maintain'); }
    async stop() { call('stop'); }
  }
  class EventLog {
    constructor(dir) { assert.equal(dir, paths.state); this.file = 'CANARY-event-file'; call('log'); }
    replay() { call('replay'); return state; }
  }
  const modules = {
    'lib/broker.mjs': { Broker }, 'lib/state.mjs': { EventLog },
    'lib/paths.mjs': { brokerPaths: () => paths }, 'lib/retention.mjs': { nextExpiry: () => Infinity },
    'lib/platform/account-isolation.mjs': { assertLogFile(file, uid) { assert.equal(file, 'CANARY-event-file'); assert.equal(uid, 'CANARY-private-SID'); call('custody'); } },
    'lib/platform/local-channel.mjs': { prepare(broker) { assert.equal(broker instanceof Broker, true); assert.equal(cleanupRegistered, true); call('prepare'); return 'CANARY-private-SID'; } },
  };
  return { calls, phases, load: async name => { assert.ok(Object.hasOwn(modules, name)); return modules[name]; },
    phase: value => phases.push(value), registerCleanup(fn) { cleanupRegistered = true; dispose = fn; }, cleanup: () => dispose() };
}
test('fresh storage prefix uses actual API order and brackets all calls without starting broker, listeners or workload', async () => {
  const args = inputs();
  const result = await probePinnedStorage(args.load, args.phase, args.registerCleanup);
  assert.deepEqual(args.calls, ['broker','prepare','log','custody','replay','maintain']);
  assert.deepEqual(args.phases, ['storage-imports','storage-broker-construct','storage-broker-constructed',
    'storage-prepare','storage-prepared','storage-log-construct','storage-log-constructed',
    'storage-log-custody','storage-log-custody-checked','storage-replay','storage-replayed',
    'storage-maintain','storage-maintained','storage-ready']);
  assert.deepEqual(result, { ready: true, startupStorageChecks: 6 });
  assert.equal(JSON.stringify({ result, phases: args.phases }).includes('CANARY'), false);
  await args.cleanup(); assert.equal(args.calls.at(-1), 'stop');
});
test('every storage boundary preserves failure and registered cleanup without reporting later success', async () => {
  for (const [failedCall, lastPhase] of [['prepare','storage-prepare'], ['log','storage-log-construct'],
    ['custody','storage-log-custody'], ['replay','storage-replay'], ['maintain','storage-maintain']]) {
    const args = inputs(failedCall);
    await assert.rejects(probePinnedStorage(args.load, args.phase, args.registerCleanup), { message: 'CANARY-private-source-body' });
    assert.equal(args.phases.at(-1), lastPhase); assert.equal(args.phases.includes('storage-ready'), false);
    assert.equal(JSON.stringify(args.phases).includes('CANARY'), false);
    await args.cleanup(); assert.equal(args.calls.at(-1), 'stop');
  }
});
test('storage prefix refuses nonfresh replay before maintenance instead of pretending private expiry equivalence', async () => {
  const args = inputs(undefined, { seq: 1 });
  await assert.rejects(probePinnedStorage(args.load, args.phase, args.registerCleanup), { code: 'ERR_ASSERTION' });
  assert.equal(args.calls.includes('maintain'), false);
  await args.cleanup(); assert.equal(args.calls.at(-1), 'stop');
});
