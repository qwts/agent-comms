// Broker mode as an HQ plugin (ADR-0306), on the vendored SDK's test host:
// the vendored SDK is byte-identical to its agent-bot-hq revision, the
// plugin passes the SDK conformance suite, and it binds, refuses and
// delivers as agent-bot-hq plan §4.9 specifies.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { agentBotHq, SOURCE, VENDOR } from './hq-agent-bot-hq.mjs';
import { brokerPlugin } from '../lib/hq-plugin/broker.mjs';
import plugin from '../lib/hq-plugin/plugin.mjs';
import { checkPlugin, createTestHost, definePlugin } from '../lib/vendor/agent-bot-sdk/index.mjs';
import { fail } from '../lib/vendor/agent-bot-sdk/errors.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const code = (c) => (e) => { assert.equal(e.code, c, e.message); return true; };
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

test('the vendored SDK is byte-identical to its agent-bot-hq revision, with nothing added', () => {
  const root = agentBotHq();
  const vendored = walk(VENDOR).map((p) => relative(VENDOR, p)).filter((p) => p !== 'source.json' && p !== 'LICENSE').sort();
  assert.deepEqual(vendored.map((p) => `sdk/${p}`), Object.keys(SOURCE.files).sort());
  assert.deepEqual(walk(join(root, 'sdk')).map((p) => relative(root, p)).sort(), Object.keys(SOURCE.files).sort(), 'every SDK file is vendored');
  for (const [path, digest] of Object.entries(SOURCE.files)) {
    const bytes = readFileSync(join(VENDOR, path.slice('sdk/'.length)));
    assert.equal(sha256(bytes), digest, `${path} hash`);
    assert.ok(bytes.equals(readFileSync(join(root, path))), `${path} equals agent-bot-hq ${SOURCE.commit}`);
  }
  assert.ok(readFileSync(join(VENDOR, 'LICENSE')).equals(readFileSync(join(root, 'LICENSE'))), 'the SDK ships with its MIT notice');
});

// A stand-in for hq-admission: two live runtimes and their bindings.
const RUNTIMES = {
  rt_lead: { channel_binding: 'cb_lead_0123456789abcdef', member_id: 'm_lead', role: 'lead' },
  rt_spec: { channel_binding: 'cb_spec_0123456789abcdef', member_id: 'm_spec', role: 'specialist' },
};
const admission = (calls = []) => definePlugin({
  name: 'hq-admission',
  version: '0.1.0',
  hostApi: 1,
  async init() {
    return { provides: { async verifyBinding(input) {
      calls.push(input);
      const rt = RUNTIMES[input?.runtime_id];
      if (!rt || rt.channel_binding !== input.channel_binding) fail('caller_mismatch', 'the channel binding does not match');
      return Object.freeze({ runtime_id: input.runtime_id, soul_id: 'agent_x', member_id: rt.member_id, role: rt.role, installation_epoch: 1, lease_generation: 1 });
    } } };
  },
});
const consumer = (seen) => definePlugin({
  name: 'consumer',
  version: '1.0.0',
  hostApi: 1,
  async init(ctx) {
    ctx.broker.registerKind({ kind: 'task.commit', consume: (message, meta) => { seen.push({ message, meta }); return { committed: message.n }; } });
  },
});
const bindAs = (id) => ({ runtime_id: id, channel_binding: RUNTIMES[id].channel_binding });

async function hostWith(options) {
  const seen = [];
  const calls = [];
  const host = createTestHost({ plugins: [admission(calls), consumer(seen), brokerPlugin(options)] });
  await host.start();
  return { host, seen, calls, broker: host.provided(pkg.name) };
}

test('the plugin is agent-comms at its package version, needs hq-admission, and passes SDK conformance', async () => {
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
  assert.deepEqual({ ...plugin.requires }, { 'hq-admission': '^0.1.0' });
  const r = await checkPlugin(plugin, { deps: [admission()] });
  assert.ok(r.ok, JSON.stringify(r.results.filter((x) => !x.ok)));
});

test('it serves the broker, binds a connection, and delivers with the runtime ID alone', async () => {
  const { host, seen, calls, broker } = await hostWith();
  assert.deepEqual(host.registrations().servers, [{ key: 'broker', plugin: pkg.name }]);
  assert.deepEqual(await host.brokerAccept('bind', bindAs('rt_lead'), { connection: 'bc_1' }), { runtime_id: 'rt_lead', member_id: 'm_lead', role: 'lead' });
  assert.deepEqual(calls, [bindAs('rt_lead')]);
  assert.equal(broker.boundConnections(), 1);
  assert.deepEqual(await host.brokerAccept('task.commit', { n: 1 }, { connection: 'bc_1' }), { committed: 1 });
  assert.deepEqual(seen.map((s) => ({ ...s.meta })), [{ runtime_id: 'rt_lead' }]);
  // The binding never travels past the plugin.
  assert.equal(JSON.stringify(seen).includes(RUNTIMES.rt_lead.channel_binding), false);
});

test('a frame before bind, a wrong binding, an unknown runtime and a second bind are refused', async () => {
  const { host, seen, broker } = await hostWith();
  await assert.rejects(host.brokerAccept('task.commit', { n: 1 }, { connection: 'bc_1' }), code('caller_mismatch'));
  await assert.rejects(host.brokerAccept('bind', { runtime_id: 'rt_lead', channel_binding: RUNTIMES.rt_spec.channel_binding }, { connection: 'bc_1' }), code('caller_mismatch'));
  await assert.rejects(host.brokerAccept('bind', { runtime_id: 'rt_unknown', channel_binding: RUNTIMES.rt_spec.channel_binding }, { connection: 'bc_1' }), code('caller_mismatch'));
  // A refused bind leaves the connection unbound, so it may bind again.
  await assert.rejects(host.brokerAccept('task.commit', { n: 1 }, { connection: 'bc_1' }), code('caller_mismatch'));
  await host.brokerAccept('bind', bindAs('rt_spec'), { connection: 'bc_1' });
  await assert.rejects(host.brokerAccept('bind', bindAs('rt_lead'), { connection: 'bc_1' }), code('host.invalid_request'));
  await host.brokerAccept('task.commit', { n: 2 }, { connection: 'bc_1' });
  assert.deepEqual(seen.map((s) => s.meta.runtime_id), ['rt_spec']);
  assert.equal(broker.boundConnections(), 1);
  await assert.rejects(host.brokerAccept('notes.take', {}, { connection: 'bc_1' }), code('host.unknown_kind'));
});

test('connections are independent, and closing one drops only its binding', async () => {
  const { host, seen, broker } = await hostWith();
  await host.brokerAccept('bind', bindAs('rt_lead'), { connection: 'bc_1' });
  await host.brokerAccept('bind', bindAs('rt_spec'), { connection: 'bc_2' });
  await host.brokerAccept('bind', bindAs('rt_lead'), { connection: 'bc_3' });
  assert.equal(broker.boundConnections(), 3);
  await host.brokerClosed('bc_1');
  assert.equal(broker.boundConnections(), 2);
  await assert.rejects(host.brokerAccept('task.commit', { n: 1 }, { connection: 'bc_1' }), code('caller_mismatch'));
  await host.brokerAccept('task.commit', { n: 2 }, { connection: 'bc_2' });
  await host.brokerAccept('task.commit', { n: 3 }, { connection: 'bc_3' });
  assert.deepEqual(seen.map((s) => s.meta.runtime_id), ['rt_spec', 'rt_lead']);
});

test('a second bind while the first is in flight is refused, and a close during bind leaves no binding', async () => {
  let release;
  let held;
  const holding = new Promise((r) => { held = r; });
  const { host, broker } = await hostWith({ beforeBind: () => { held(); return new Promise((r) => { release = r; }); } });
  const first = host.brokerAccept('bind', bindAs('rt_lead'), { connection: 'bc_1' });
  await holding;
  await assert.rejects(host.brokerAccept('bind', bindAs('rt_spec'), { connection: 'bc_1' }), code('host.invalid_request'));
  await assert.rejects(host.brokerAccept('task.commit', { n: 1 }, { connection: 'bc_1' }), code('caller_mismatch'));
  await host.brokerClosed('bc_1');
  release();
  await assert.rejects(first, code('host.invalid_request'));
  assert.equal(broker.boundConnections(), 0);
  await assert.rejects(host.brokerAccept('task.commit', { n: 1 }, { connection: 'bc_1' }), code('caller_mismatch'));
});
