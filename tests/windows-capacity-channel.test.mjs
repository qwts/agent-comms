import assert from 'node:assert/strict';
import test from 'node:test';
import { probePinnedChannel } from '../tools/acceptance/windows-capacity-channel.mjs';

function fixture(failAt) {
  const paths = { socket: 'CANARY-private-main', admin: 'CANARY-private-admin', state: 'CANARY-private-state' };
  const calls = [], phases = [], fault = new Error('CANARY-secret-error');
  let cleanup, context;
  const load = async name => {
    if (name === 'lib/paths.mjs') return { brokerPaths: () => paths };
    assert.equal(name, 'lib/platform/local-channel.mjs');
    return {
      prepare(value) {
        assert.ok(cleanup, 'cleanup registered before prepare can acquire lock');
        assert.equal(value.paths, paths); assert.equal(value.mode, 'single-account');
        assert.deepEqual(Object.keys(value).sort(), ['accountWatchers','connections','mode','paths','servers','watchers']);
        assert.equal(value.servers.length, 0); assert.equal(value.connections.size, 0);
        context = value; calls.push('prepare'); if (failAt === 'prepare') throw fault;
      },
      async removeStaleSocket(file) { calls.push(file); if (failAt === file) throw fault; },
      async stop(value) { assert.equal(value, context); calls.push('stop'); },
    };
  };
  return { paths, calls, phases, fault, dispose: () => cleanup(),
    run: () => probePinnedChannel(load, phase => phases.push(phase), dispose => { cleanup = dispose; }) };
}

test('channel discriminant calls default prepare and both production stale APIs without Broker, listeners or reporting private values', async () => {
  const f = fixture(); const result = await f.run();
  assert.deepEqual(result, { ready: true, startupChannelChecks: 3 });
  assert.deepEqual(f.calls, ['prepare',f.paths.socket,f.paths.admin]);
  assert.equal(f.phases.at(-1), 'channel-ready');
  assert.equal(JSON.stringify({ result, phases: f.phases }).includes('CANARY'), false);
  await f.dispose(); assert.equal(f.calls.at(-1), 'stop');
});

test('every actual channel refusal stays original, prevents later calls and preserves registered owned cleanup', async () => {
  for (const [at, lastPhase, count] of [['prepare','channel-prepare',1],
    ['CANARY-private-main','channel-stale-main',2], ['CANARY-private-admin','channel-stale-admin',3]]) {
    const f = fixture(at);
    await assert.rejects(f.run(), error => error === f.fault);
    assert.equal(f.calls.length, count); assert.equal(f.phases.at(-1), lastPhase);
    assert.equal(f.phases.includes('channel-ready'), false);
    assert.equal(JSON.stringify(f.phases).includes('CANARY'), false);
    await f.dispose(); assert.equal(f.calls.at(-1), 'stop');
  }
});

test('pending actual stale probe cannot emit completion or begin the next probe early', async () => {
  let release, entered;
  const enteredProbe = new Promise(resolve => { entered = resolve; });
  const heldProbe = new Promise(resolve => { release = resolve; });
  const phases = [], calls = [];
  const result = probePinnedChannel(async name => name === 'lib/paths.mjs' ? { brokerPaths: () => ({ socket: 'main', admin: 'admin' }) } : {
    prepare() {}, stop() {}, async removeStaleSocket(file) { calls.push(file); if (file === 'main') { entered(); await heldProbe; } },
  }, phase => phases.push(phase), () => {});
  await enteredProbe;
  assert.deepEqual(calls, ['main']); assert.equal(phases.at(-1), 'channel-stale-main');
  release(); assert.deepEqual(await result, { ready: true, startupChannelChecks: 3 });
  assert.deepEqual(calls, ['main','admin']);
});
