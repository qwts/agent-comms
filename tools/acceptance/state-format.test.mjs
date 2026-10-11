// Disposable format acceptance. Sources are exact git archives, never owner state.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const root = path.dirname(fileURLToPath(import.meta.url));
const versions = JSON.parse(readFileSync(path.join(root, 'versions.json')));
const code = {};
for (const name of Object.keys(versions)) {
  const base = new URL(`./${name}/`, import.meta.url);
  code[name] = {
    ...await import(new URL('lib/state.mjs', base)),
    ...await import(new URL('lib/broker.mjs', base)),
    ...await import(new URL('lib/paths.mjs', base)),
    ...await import(new URL('tests/helpers/broker.mjs', base)),
    ...await import(new URL('lib/client.mjs', base)),
  };
}
const fixtures = path.join(root, 'fixtures'); mkdirSync(fixtures, { recursive: true });
const brokerRoot = mkdtempSync(path.join(os.tmpdir(), 'ac-format-broker-'));
const paths = code.released.brokerPaths({ AGENT_COMMS_SHARED_DIR: path.join(brokerRoot, 'shared'),
  AGENT_COMMS_BROKER_STATE_DIR: path.join(brokerRoot, 'broker') });
const at = Date.now(), owner = os.userInfo().username;
const alice = `agent_${randomUUID()}`, bob = `agent_${randomUUID()}`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const evidence = { versions, environment: { node: process.version, platform: process.platform, arch: process.arch }, cases: [] };
let active, credential, original, acknowledged, v1Added, channel, posted, postRequest, ownCopy, bobCopy;
const payload = { to: bob, key: 'released-retry', body: 'released durable ☃ message', refs: ['opaque:reference'], correlation: 'format-acceptance' };
const save = (name) => { const bytes = readFileSync(path.join(paths.state, 'events.jsonl')); writeFileSync(path.join(fixtures, name), bytes); return bytes; };
const request = (name, agentId, op, fields = {}) => code[name].call(paths, credential, { op, agentId, ...fields });
async function start(name) {
  active = await new code[name].Broker({ paths, mode: 'single-account', now: () => at }).start();
  return active;
}
async function stop() { if (active) { await active.stop(); active = undefined; } }
function fixtureCopy(name, suffix = Buffer.alloc(0)) {
  const dir = mkdtempSync(path.join(root, 'probe-'));
  const log = new code.v2.EventLog(dir);
  const prefix = readFileSync(path.join(fixtures, name)), bytes = Buffer.concat([prefix, suffix]);
  writeFileSync(log.file, bytes, { mode: 0o600 });
  return { dir, file: log.file, prefix, bytes };
}
function validateDirect(state) {
  const message = state.messages.get(original.messageId);
  assert.equal(message.body, payload.body); assert.equal(message.seq, original.seq);
  assert.deepEqual(message.refs, payload.refs); assert.equal(message.correlation, payload.correlation);
  assert.equal(state.acked.get(bob).has(acknowledged.messageId), true);
  assert.deepEqual(state.idempotency.get(`${owner} ${payload.key}`).outcome,
    { messageId: original.messageId, seq: original.seq, wake: original.wake });
}
function validateChannels(state) {
  validateDirect(state);
  assert.equal(state.channels.get(channel).address, channel);
  const entry = state.idempotency.get(`${owner} ${postRequest.key}`);
  assert.deepEqual(entry.outcome, { postId: posted.postId, accepted: true });
  assert.deepEqual(entry.snapshot.map((item) => item.id), [ownCopy.id, bobCopy.id]);
  assert.equal(state.messages.get(ownCopy.id).body, postRequest.body);
  assert.equal(state.messages.get(bobCopy.id).body, postRequest.body);
  assert.equal(state.acked.get(alice).has(ownCopy.id), true);
  assert.equal(state.acked.get(bob).has(bobCopy.id), false);
  assert.equal(Object.hasOwn(entry, 'body'), false);
}
after(async () => {
  await stop(); rmSync(brokerRoot, { recursive: true, force: true });
  writeFileSync(path.join(root, 'results.json'), `${JSON.stringify(evidence, null, 2)}\n`);
});

test('actual released broker outcomes migrate through actual PR141 v1 writer and reader', async () => {
  await start('released');
  const paired = await code.released.pairAccount(paths, owner, process.getuid());
  credential = paired.credential;
  await code.released.admin(paths, { op: 'approve', code: paired.code });
  await request('released', alice, 'join', { name: 'format-alice', harness: 'format-acceptance' });
  await request('released', bob, 'join', { name: 'format-bob', harness: 'format-acceptance' });
  original = await request('released', alice, 'send', payload);
  acknowledged = await request('released', alice, 'send', { to: bob, key: 'released-ack', body: 'retained but acknowledged' });
  await request('released', bob, 'ack', { ids: [acknowledged.messageId] });
  await stop(); const released = save('released.jsonl');
  assert.notEqual(JSON.parse(released.toString().split('\n')[0]).t, 'checkpoint');
  await start('v1');
  assert.deepEqual(await request('v1', alice, 'send', payload), { ...original, duplicate: true });
  const page = await request('v1', bob, 'read');
  assert.deepEqual(page.messages.map((message) => message.id), [original.messageId]);
  assert.equal(page.messages[0].body, payload.body);
  v1Added = await request('v1', alice, 'send', { to: bob, key: 'v1-tail', body: 'actual v1 writer tail' });
  validateDirect(active.state);
  await stop(); const bytes = save('v1-checkpoint-tail.jsonl');
  assert.equal(JSON.parse(bytes.toString().split('\n')[0]).version, 1);
  assert.equal(JSON.parse(bytes.toString().trimEnd().split('\n').at(-1)).t, 'message');
  evidence.cases.push({ name: 'released to PR141 actual broker migration', status: 'pass', fixtureSha256: hash(bytes), originalMessageId: original.messageId });
});

test('actual PR145 v2 broker recovers v1 message/retry and durable channel copies/outcome', async () => {
  await start('v2');
  assert.deepEqual(await request('v2', alice, 'send', payload), { ...original, duplicate: true });
  assert.equal(active.state.messages.get(v1Added.messageId).body, 'actual v1 writer tail');
  ({ channel } = await request('v2', alice, 'channel-create', { name: 'format acceptance channel' }));
  for (const member of [alice, bob]) {
    await request('v2', alice, 'channel-invite', { channel, to: member });
    await request('v2', member, 'channel-subscribe', { channel });
  }
  postRequest = { channel, key: 'channel-retry', body: 'actual channel copy ☃', refs: ['opaque:channel-reference'] };
  posted = await request('v2', alice, 'channel-post', postRequest);
  ownCopy = (await request('v2', alice, 'read', { channel })).messages[0];
  bobCopy = (await request('v2', bob, 'read', { channel })).messages[0];
  assert.notEqual(ownCopy.id, bobCopy.id);
  await request('v2', alice, 'ack', { ids: [ownCopy.id] });
  validateChannels(active.state);
  await stop(); const tail = save('v2-checkpoint-channel-tail.jsonl');
  assert.equal(JSON.parse(tail.toString().split('\n')[0]).version, 2);
  assert.ok(tail.toString().includes('"t":"channel-post"'));
  await start('v2');
  assert.deepEqual(await request('v2', alice, 'channel-post', postRequest), { ...posted, duplicate: true });
  assert.deepEqual(await request('v2', alice, 'send', payload), { ...original, duplicate: true });
  validateChannels(active.state);
  await stop(); const checkpoint = save('v2-checkpoint.jsonl');
  assert.equal(checkpoint.toString().trimEnd().split('\n').length, 1);
  evidence.cases.push({ name: 'PR141 to PR145 actual broker migration and restart', status: 'pass', fixtureSha256: hash(checkpoint), postId: posted.postId });
});

test('actual released reader refuses intact v1 and v2 histories without changing any bytes', () => {
  for (const name of ['v1-checkpoint-tail.jsonl', 'v2-checkpoint-channel-tail.jsonl', 'v2-checkpoint.jsonl']) {
    const f = fixtureCopy(name);
    try {
      assert.throws(() => new code.released.EventLog(f.dir).replay(), /unknown log record type checkpoint/);
      assert.deepEqual(readFileSync(f.file), f.bytes);
      evidence.cases.push({ name: `released refuses intact ${name}`, status: 'pass', beforeSha256: hash(f.bytes), afterSha256: hash(readFileSync(f.file)) });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('actual PR141 reader refuses v2 checkpoint and channel tail intact or torn without modification', () => {
  const suffix = Buffer.from('{"t":"channel-post","body":"uncommitted ☃').subarray(0, -1);
  for (const name of ['v2-checkpoint-channel-tail.jsonl', 'v2-checkpoint.jsonl']) {
    for (const extra of [Buffer.alloc(0), suffix]) {
      const f = fixtureCopy(name, extra);
      try {
        assert.throws(() => new code.v1.EventLog(f.dir).replay(), /unsupported checkpoint version 2/);
        assert.deepEqual(readFileSync(f.file), f.bytes);
        evidence.cases.push({ name: `PR141 refuses ${name}${extra.length ? ' with torn suffix' : ''}`, status: 'pass', beforeSha256: hash(f.bytes), afterSha256: hash(readFileSync(f.file)) });
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    }
  }
});

test('released downgrade limitation trims only an uncommitted suffix before refusing the newer committed prefix', () => {
  const suffix = Buffer.from('{"t":"channel-post","body":"uncommitted ☃').subarray(0, -1);
  for (const name of ['v1-checkpoint-tail.jsonl', 'v2-checkpoint-channel-tail.jsonl', 'v2-checkpoint.jsonl']) {
    const f = fixtureCopy(name, suffix);
    try {
      assert.throws(() => new code.released.EventLog(f.dir).replay(), /unknown log record type checkpoint/);
      const after = readFileSync(f.file);
      assert.notDeepEqual(after, f.bytes);
      assert.deepEqual(after, f.prefix, 'every complete checkpoint/event byte survives; only torn suffix is removed');
      const recovered = new code.v2.EventLog(f.dir).replay();
      if (name.startsWith('v2')) validateChannels(recovered); else validateDirect(recovered);
      assert.deepEqual(readFileSync(f.file), f.prefix);
      evidence.cases.push({ name: `released torn-suffix limitation ${name}`, status: 'confirmed limitation', removedBytes: suffix.length, beforeSha256: hash(f.bytes), committedPrefixSha256: hash(f.prefix), afterSha256: hash(after), compatibleRecovery: 'pass' });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('compatible readers recover original outcomes and trim valid torn suffixes only after successful validation', () => {
  const suffix = Buffer.from('{"t":"uncommitted');
  for (const [reader, name] of [['v1', 'v1-checkpoint-tail.jsonl'], ['v2', 'v1-checkpoint-tail.jsonl'], ['v2', 'v2-checkpoint-channel-tail.jsonl'], ['v2', 'v2-checkpoint.jsonl']]) {
    const f = fixtureCopy(name, suffix);
    try {
      const state = new code[reader].EventLog(f.dir).replay();
      if (name.startsWith('v2')) validateChannels(state); else validateDirect(state);
      assert.deepEqual(readFileSync(f.file), f.prefix);
      evidence.cases.push({ name: `${reader} compatible recovery ${name}`, status: 'pass', recoveredSeq: state.seq, afterSha256: hash(readFileSync(f.file)) });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('actual broker startup refuses incompatible state, releases custody, and compatible restart returns original outcomes', async () => {
  const suffix = Buffer.from('{"t":"uncommitted');
  const cases = [['released', 'v1-checkpoint-tail.jsonl', false], ['released', 'v2-checkpoint-channel-tail.jsonl', false],
    ['v1', 'v2-checkpoint-channel-tail.jsonl', false], ['v1', 'v2-checkpoint-channel-tail.jsonl', true],
    ['released', 'v2-checkpoint-channel-tail.jsonl', true]];
  for (const [reader, name, torn] of cases) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-format-startup-'));
    const probePaths = code.v2.brokerPaths({ AGENT_COMMS_SHARED_DIR: path.join(dir, 'shared'), AGENT_COMMS_BROKER_STATE_DIR: path.join(dir, 'broker') });
    mkdirSync(probePaths.state, { recursive: true, mode: 0o700 });
    const file = path.join(probePaths.state, 'events.jsonl'), prefix = readFileSync(path.join(fixtures, name));
    const bytes = torn ? Buffer.concat([prefix, suffix]) : prefix;
    writeFileSync(file, bytes, { mode: 0o600 });
    let compatible;
    try {
      const old = new code[reader].Broker({ paths: probePaths, mode: 'single-account', now: () => at });
      await assert.rejects(old.start(), reader === 'released' ? /unknown log record type checkpoint/ : /unsupported checkpoint version 2/);
      const modified = reader === 'released' && torn;
      assert.deepEqual(readFileSync(file), modified ? prefix : bytes);
      assert.equal(existsSync(path.join(probePaths.state, 'broker.lock')), false, 'incompatible startup releases custody');
      compatible = await new code.v2.Broker({ paths: probePaths, mode: 'single-account', now: () => at }).start();
      if (name.startsWith('v2')) {
        validateChannels(compatible.state);
        assert.deepEqual(await code.v2.call(probePaths, credential, { op: 'channel-post', agentId: alice, ...postRequest }), { ...posted, duplicate: true });
      } else validateDirect(compatible.state);
      assert.deepEqual(await code.v2.call(probePaths, credential, { op: 'send', agentId: alice, ...payload }), { ...original, duplicate: true });
      evidence.cases.push({ name: `${reader} actual startup refuses ${name}${torn ? ' plus torn suffix' : ''}`, status: modified ? 'confirmed limitation' : 'pass', beforeSha256: hash(bytes), afterRefusalSha256: hash(modified ? prefix : bytes), compatibleBrokerRestart: 'pass' });
    } finally { await compatible?.stop(); rmSync(dir, { recursive: true, force: true }); }
  }
});
