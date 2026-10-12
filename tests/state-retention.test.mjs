import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { apply, EventLog } from '../lib/state.mjs';
import { CommsError, publicError } from '../lib/errors.mjs';
import { LEGACY_MESSAGE_MS, LEGACY_DEDUPE_MS, serializedBytes } from '../lib/retention.mjs';
import { call as clientCall, loadCredential } from '../lib/client.mjs';
import { clientPaths } from '../lib/paths.mjs';
import { Broker, LIMITS } from '../lib/broker.mjs';
import { call, withBroker } from './helpers/broker.mjs';

const policy = { messageRetentionMs: 10, dedupeRetentionMs: 20, referenceRetentionMs: 30,
  expiredPerMailbox: 2, expiredBytesPerMailbox: 2048 };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-retention-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = new EventLog(root);
  const state = log.replay();
  const commit = (record) => { log.append(record); apply(state, record); };
  commit({ t: 'join', account: 'receiver', agentId: 'agent_receiver', at: 100 });
  function send(at, body = 'retained ☃', options = {}) {
    const seq = state.seq + 1;
    const message = { id: `msg_${seq}`, seq, at, expiresAt: at + 10,
      from: { account: 'sender', agentId: 'agent_sender' },
      to: { account: 'receiver', agentId: 'agent_receiver' },
      kind: 'message', body, refs: [], correlation: null, replyTo: null, depth: 0, ...options };
    commit({ t: 'message', message, key: `key_${seq}`, fingerprint: 'a'.repeat(64), wake: 'waiting', dedupeExpiresAt: at + 20 });
    return message;
  }
  return { root, log, state, commit, send };
}

for (const phase of ['before-temp-fsync', 'after-temp-fsync', 'before-replace', 'after-replace',
  ...(process.platform === 'win32' ? [] : ['before-directory-fsync', 'after-directory-fsync'])]) {
  test(`checkpoint interruption at ${phase} preserves retained state and refuses further writes`, (t) => {
    const f = fixture(t);
    const first = f.send(100);
    f.send(101, 'still unread');
    f.commit({ t: 'ack', agentId: 'agent_receiver', ids: [first.id], at: 102 });
    const expected = structuredClone(f.state);
    f.log.fault = (point) => { if (point === phase) throw new Error(`interrupted ${point}`); };
    assert.throws(() => f.log.compact(f.state), /interrupted/);
    assert.throws(() => f.log.append({ t: 'leave', agentId: 'agent_receiver' }), /poisoned/);
    const recovered = new EventLog(f.root);
    assert.deepEqual(recovered.replay(), expected);
    recovered.append({ t: 'leave', agentId: 'agent_receiver' });
    assert.equal(recovered.replay().souls.get('agent_receiver').joined, false);
  });
}

test('writes handle short progress and poison a partial append until torn-tail recovery', (t) => {
  const f = fixture(t);
  const baseline = structuredClone(f.state);
  let calls = 0;
  f.log.io = { ...fs, writeSync(fd, bytes, offset, length) {
    calls += 1;
    if (calls === 1) return fs.writeSync(fd, bytes, offset, Math.min(7, length));
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  } };
  assert.throws(() => f.send(100), /disk full/);
  assert.deepEqual(f.state, baseline);
  assert.throws(() => f.log.append({ t: 'leave', agentId: 'agent_receiver' }), /poisoned/);
  const recovered = new EventLog(f.root);
  assert.deepEqual(recovered.replay(), baseline);
  recovered.io = { ...fs, writeSync(fd, bytes, offset, length) {
    return fs.writeSync(fd, bytes, offset, Math.min(3, length));
  } };
  recovered.append({ t: 'leave', agentId: 'agent_receiver' });
  assert.equal(recovered.replay().souls.get('agent_receiver').joined, false);
});

test('an ambiguous fsync failure never permits more appends; recovery retains a complete line', (t) => {
  const f = fixture(t);
  f.log.io = { ...fs, fsyncSync() { throw new Error('fsync failed'); } };
  assert.throws(() => f.send(100), /fsync failed/);
  assert.throws(() => f.send(101), /poisoned/);
  const recovered = new EventLog(f.root).replay();
  assert.equal(recovered.seq, 1);
  assert.equal(recovered.messages.get('msg_1').body, 'retained ☃');
  assert.equal(recovered.idempotency.get('sender key_1').outcome.messageId, 'msg_1');
});

test('checkpoint corruption, unsupported formats and attempted rewind fail visibly', (t) => {
  const f = fixture(t);
  f.send(100);
  f.log.compact(f.state);
  const valid = fs.readFileSync(f.log.file, 'utf8');
  const mutate = (edit, pattern, checksum = true) => {
    const record = JSON.parse(valid);
    edit(record);
    if (checksum) record.checksum = createHash('sha256').update(JSON.stringify(record.snapshot)).digest('hex');
    fs.writeFileSync(f.log.file, `${JSON.stringify(record)}\n`);
    assert.throws(() => new EventLog(f.root).replay(), pattern);
  };
  mutate((record) => { record.version = 4; }, /unsupported checkpoint/);
  mutate((record) => { record.snapshot.seq = 0; }, /checksum/, false);
  mutate((record) => { record.snapshot.mailboxMeta[0][1].highWater = 0; }, /mailbox position/);
  mutate((record) => { record.snapshot.mailboxMeta[0][1].totalLoss = 1; }, /loss notice/);
  mutate((record) => { record.snapshot.idempotency[0][1].outcome.seq = 2; }, /dedupe outcome/);
  mutate((record) => { record.snapshot.acked[0][1].push('msg_missing'); }, /receipt reference/);
  fs.writeFileSync(f.log.file, valid + valid);
  assert.throws(() => new EventLog(f.root).replay(), /checkpoint must be the first/);
  fs.writeFileSync(f.log.file, `${valid}{"t":"future-format"}\n`);
  assert.throws(() => new EventLog(f.root).replay(), /unknown log record/);
  fs.writeFileSync(f.log.file, `${valid}{invalid committed line}\n`);
  assert.throws(() => new EventLog(f.root).replay(), /is corrupt/);
  for (const prefix of [`${valid}{invalid committed line}\n`, `${valid}{"t":"future-format"}\n`]) {
    const invalid = `${prefix}{"t":"torn`;
    fs.writeFileSync(f.log.file, invalid);
    assert.throws(() => new EventLog(f.root).replay());
    assert.equal(fs.readFileSync(f.log.file, 'utf8'), invalid, 'committed refusal must not modify the suffix');
  }
});

test('repeated expiry/receipt/checkpoint cycles bound mailbox state, evidence and replay input', (t) => {
  const f = fixture(t);
  const sizes = [];
  for (let index = 0; index < 35; index += 1) {
    const at = 100 + index * 10;
    const message = f.send(at, 'x'.repeat(100));
    if (index % 2 === 0) f.commit({ t: 'ack', agentId: 'agent_receiver', ids: [message.id], at });
    f.commit({ t: 'maintenance', at: at + 10, policy });
    f.log.compact(f.state);
    const replayed = new EventLog(f.root).replay();
    assert.deepEqual(replayed, f.state);
    assert.equal(replayed.messages.size, 0);
    assert.equal(replayed.acked.get('agent_receiver').size, 0);
    assert.ok(replayed.expired.size <= 2);
    assert.ok(replayed.idempotency.size <= 1);
    assert.equal(replayed.seq, index + 1);
    if (index > 5) sizes.push(fs.statSync(f.log.file).size);
  }
  assert.ok(Math.max(...sizes) - Math.min(...sizes) < 200, 'fixed namespaces reach a bounded checkpoint size');
  assert.equal(f.state.mailboxMeta.get('agent_receiver').gap.count, 17);
});

test('legacy records receive approved retention windows without losing retry outcomes', (t) => {
  const f = fixture(t);
  const message = f.send(100);
  const records = fs.readFileSync(f.log.file, 'utf8').trim().split('\n').map(JSON.parse);
  delete records[1].message.expiresAt;
  delete records[1].dedupeExpiresAt;
  fs.writeFileSync(f.log.file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const replay = new EventLog(f.root).replay();
  assert.equal(replay.messages.get(message.id).expiresAt, 100 + LEGACY_MESSAGE_MS);
  assert.equal(replay.idempotency.get('sender key_1').expiresAt, 100 + LEGACY_DEDUPE_MS);
  assert.deepEqual(replay.idempotency.get('sender key_1').outcome, { messageId: message.id, seq: 1, wake: 'waiting' });
});

test('expired-ID count, exact byte capacity and age eviction preserve aggregate unread-loss evidence', (t) => {
  const f = fixture(t);
  const messages = [f.send(100), f.send(101), f.send(102)];
  f.commit({ t: 'maintenance', at: 112, policy });
  assert.equal(f.state.expired.has(messages[0].id), false, 'oldest ID evidence is evicted at count capacity');
  assert.deepEqual([...f.state.expired.keys()], messages.slice(1).map((message) => message.id));
  const notice = structuredClone(f.state.mailboxMeta.get('agent_receiver'));
  assert.deepEqual(notice.gap, { count: 3, firstSeq: 1, lastSeq: 3 });
  const latest = f.state.expired.get(messages[2].id);
  const bytes = serializedBytes(latest);
  f.commit({ t: 'maintenance', at: 112, policy: { ...policy, expiredBytesPerMailbox: bytes } });
  assert.deepEqual([...f.state.expired.keys()], [messages[2].id], 'exact newest evidence fits its byte budget');
  assert.deepEqual(f.state.mailboxMeta.get('agent_receiver'), notice);
  f.log.compact(f.state);
  assert.deepEqual(f.log.replay(), f.state);
  f.commit({ t: 'maintenance', at: latest.expiresAt - 1, policy });
  assert.equal(f.state.expired.size, 1);
  f.commit({ t: 'maintenance', at: latest.expiresAt, policy });
  assert.equal(f.state.expired.size, 0, 'reference horizon is inclusive');
  assert.deepEqual(f.state.mailboxMeta.get('agent_receiver'), notice, 'loss proof outlives all individually expired IDs');
  f.log.compact(f.state);
  assert.deepEqual(f.log.replay().mailboxMeta, f.state.mailboxMeta);
});

test('evicted expired IDs become unknown without clearing the mailbox loss notice', async () => {
  let clock = 1000;
  await withBroker(async ({ broker, paths, env, accounts }) => {
    const credential = loadCredential(clientPaths(env));
    const sent = [];
    for (const key of ['older', 'newer']) sent.push(await call(paths, credential, { op: 'send', agentId: accounts.alice, to: accounts.bob, body: key, key }));
    clock += 10;
    broker.maintain();
    const ack = (id) => call(paths, credential, { op: 'ack', agentId: accounts.bob, ids: [id] });
    await assert.rejects(ack(sent[0].messageId), { code: 'unknown-message' });
    await assert.rejects(ack(sent[1].messageId), { code: 'message-expired' });
    broker.limits.expiredBytesPerMailbox = 1;
    broker.maintain({ compact: true });
    await assert.rejects(ack(sent[1].messageId), { code: 'unknown-message' });
    const page = await call(paths, credential, { op: 'read', agentId: accounts.bob });
    assert.deepEqual(page.gap, { through: 2, count: 2, firstSeq: sent[0].seq, lastSeq: sent[1].seq });
  }, { brokerOptions: { mode: 'single-account', now: () => clock,
    limits: { ...LIMITS, messageRetentionMs: 10, expiredPerMailbox: 1 } } });
});

test('public errors allow only bounded cursor metadata and preserve existing errors', () => {
  assert.deepEqual(publicError(new CommsError('message-expired', 'expired', { secret: 'no' })), { code: 'message-expired', message: 'expired' });
  const details = { earliestAvailableSeq: 4, resumeAfter: 3, gap: { through: 3, count: 2, firstSeq: 1, lastSeq: 2, secret: 'no' }, secret: 'no' };
  assert.deepEqual(publicError(new CommsError('cursor-expired', 'expired', details)).details, {
    earliestAvailableSeq: 4, resumeAfter: 3, gap: { through: 3, count: 2, firstSeq: 1, lastSeq: 2 },
  });
  for (const invalid of [{ ...details, resumeAfter: Infinity }, { ...details, gap: { ...details.gap, count: 4 } }, { ...details, earliestAvailableSeq: '4' }]) {
    assert.equal(publicError(new CommsError('cursor-expired', 'expired', invalid)).details, undefined);
  }
});

test('requests without due maintenance do not append or fsync the log, including refusals', async () => {
  await withBroker(async ({ broker, paths, env, accounts }) => {
    const credential = loadCredential(clientPaths(env));
    const bytes = fs.statSync(broker.log.file).size;
    let fsyncs = 0;
    broker.log.io = { ...fs, fsyncSync(fd) { fsyncs += 1; return fs.fsyncSync(fd); } };
    for (let index = 0; index < 5; index += 1) {
      await call(paths, credential, { op: 'read', agentId: accounts.bob });
      await assert.rejects(call(paths, { ...credential, secret: 'invalid' }, { op: 'read', agentId: accounts.bob }), { code: 'unauthenticated' });
    }
    assert.equal(fs.statSync(broker.log.file).size, bytes);
    assert.equal(fsyncs, 0);
  }, { brokerOptions: { mode: 'single-account', now: () => 1000 } });
});

test('retained count/bytes apply to acknowledged bodies and atomic task events', async () => {
  await withBroker(async ({ broker, paths, env, accounts }) => {
    const credential = loadCredential(clientPaths(env));
    const request = { op: 'send', agentId: accounts.alice, to: accounts.bob, body: '☃'.repeat(8), key: 'first' };
    const sent = await call(paths, credential, request);
    await call(paths, credential, { op: 'ack', agentId: accounts.bob, ids: [sent.messageId] });
    broker.limits.retainedPerMailbox = 1;
    await assert.rejects(call(paths, credential, { ...request, key: 'count-full' }), { code: 'mailbox-full' });
    const seq = broker.state.seq;
    await assert.rejects(call(paths, credential, { op: 'task-offer', agentId: accounts.alice, to: accounts.bob, acceptanceCriteria: 'work' }), { code: 'mailbox-full' });
    assert.equal(broker.state.tasks.size, 0);
    assert.equal(broker.state.seq, seq);
    broker.limits.retainedPerMailbox = LIMITS.retainedPerMailbox;
    broker.limits.mailboxBytes = serializedBytes(broker.state.messages.get(sent.messageId));
    await assert.rejects(call(paths, credential, { ...request, key: 'bytes-full' }), { code: 'mailbox-full' });
    assert.equal((await call(paths, credential, request)).messageId, sent.messageId, 'protected retries bypass new-admission capacity');
  }, { brokerOptions: { mode: 'single-account', now: () => 1000 } });
});

test('dedupe is independent of body expiry and rejects capacity without evicting a guarantee', async () => {
  let clock = 1000;
  await withBroker(async ({ broker, paths, env, accounts }) => {
    const credential = loadCredential(clientPaths(env));
    const request = { op: 'send', agentId: accounts.alice, to: accounts.bob, body: 'expires first', key: 'first' };
    const sent = await call(paths, credential, request);
    clock += 10;
    broker.maintain();
    assert.equal(broker.state.messages.size, 0);
    assert.deepEqual(await call(paths, credential, request), { ok: true, messageId: sent.messageId, seq: sent.seq, wake: sent.wake, duplicate: true });
    await assert.rejects(call(paths, credential, { ...request, body: 'different' }), { code: 'conflict' });
    await assert.rejects(call(paths, credential, { ...request, key: 'new-key' }), { code: 'dedupe-full' });
    broker.limits.dedupeRetentionMs = 1;
    clock += 1;
    assert.equal((await call(paths, credential, request)).duplicate, true, 'a new override cannot shorten an accepted retry guarantee');
    clock = 900;
    assert.equal(broker.now(), 1010, 'committed maintenance time survives clock rollback');
    clock = 1100;
    const reused = await call(paths, credential, request);
    assert.equal(reused.duplicate, false);
    assert.notEqual(reused.messageId, sent.messageId);
  }, { brokerOptions: { mode: 'single-account', now: () => clock,
    limits: { ...LIMITS, messageRetentionMs: 10, dedupeRetentionMs: 100, dedupeEntriesPerSender: 1 } } });
});

test('task summaries and invocation facts survive event-body expiry while task brief refuses the expired ID', async () => {
  let clock = 1000;
  await withBroker(async ({ broker, paths, env, accounts, cli }) => {
    const credential = loadCredential(clientPaths(env));
    let { task } = await call(paths, credential, { op: 'task-offer', agentId: accounts.alice, to: accounts.bob, acceptanceCriteria: 'kept task' });
    const offered = (await call(paths, credential, { op: 'read', agentId: accounts.bob })).messages[0];
    ({ task } = await call(paths, credential, { op: 'task-accept', agentId: accounts.bob, taskId: task.id, revision: task.revision }));
    await call(paths, credential, { op: 'task-invocation', agentId: accounts.bob, taskId: task.id, invocationId: 'invocation_12345678', phase: 'started' });
    const before = await call(paths, credential, { op: 'task-show', agentId: accounts.bob, taskId: task.id });
    clock += 10;
    broker.maintain();
    assert.equal(broker.state.messages.size, 0);
    assert.equal(broker.state.taskStreams.get(task.id).length, 0, 'retained ID streams cannot dangle');
    const after = await call(paths, credential, { op: 'task-show', agentId: accounts.bob, taskId: task.id });
    assert.deepEqual(after, before);
    const brief = await cli(['task', 'brief', offered.id], accounts.bob);
    assert.equal(brief.json.error.code, 'message-expired');
    assert.deepEqual(broker.log.replay().taskEvents, broker.state.taskEvents);
    assert.deepEqual(broker.log.replay().taskInvocations, broker.state.taskInvocations);
  }, { brokerOptions: { mode: 'single-account', now: () => clock, limits: { ...LIMITS, messageRetentionMs: 10 } } });
});

test('cursor recovery details survive real client and CLI serialization and the suggested resume works', async () => {
  let clock = 1000;
  await withBroker(async ({ broker, paths, env, accounts, cli }) => {
    const credential = loadCredential(clientPaths(env));
    for (const key of ['one', 'two']) await call(paths, credential, { op: 'send', agentId: accounts.alice, to: accounts.bob, body: key, key });
    clock += 10;
    broker.maintain();
    const live = await call(paths, credential, { op: 'send', agentId: accounts.alice, to: accounts.bob, body: 'live', key: 'three' });
    let details;
    await assert.rejects(clientCall(paths, credential, { op: 'read', agentId: accounts.bob, after: 1 }), (error) => {
      assert.equal(error.code, 'cursor-expired'); details = error.details; return true;
    });
    const refused = await cli(['inbox', 'read', '--after', '1'], accounts.bob);
    assert.equal(refused.json.error.code, 'cursor-expired');
    assert.deepEqual(refused.json.error.details, details);
    const resumed = await cli(['inbox', 'read', '--after', String(details.resumeAfter)], accounts.bob);
    assert.deepEqual(resumed.json.messages.map((message) => message.id), [live.messageId]);
    const acked = await cli(['inbox', 'gap-ack', String(details.gap.through)], accounts.bob);
    assert.equal(acked.json.acknowledged, 2);
  }, { brokerOptions: { mode: 'single-account', now: () => clock, limits: { ...LIMITS, messageRetentionMs: 10 } } });
});

test('prospective deadline changes preserve actionable recovery and paging across out-of-order expiry and restart', async () => {
  let clock = 1000;
  await withBroker(async ({ broker, paths, env, accounts }) => {
    const credential = loadCredential(clientPaths(env));
    const send = (key) => call(paths, credential, { op: 'send', agentId: accounts.alice, to: accounts.bob, body: key, key });
    await send('old-one'); await send('old-two');
    clock += 10;
    broker.maintain();
    broker.limits.messageRetentionMs = 100;
    const first = await send('long-lived-before');
    broker.limits.messageRetentionMs = 10;
    await send('short-lived-middle');
    broker.limits.messageRetentionMs = 100;
    const last = await send('long-lived-after');
    clock += 10;
    broker.maintain();
    await broker.stop();
    const restarted = await new Broker({ paths, mode: 'single-account', now: () => clock, limits: broker.limits }).start();
    try {
      let details;
      await assert.rejects(clientCall(paths, credential, { op: 'read', agentId: accounts.bob, after: 1 }), (error) => {
        assert.equal(error.code, 'cursor-expired'); details = error.details; return true;
      });
      assert.equal(details.resumeAfter, first.seq - 1);
      assert.equal(details.gap.count, 3);
      const page = await clientCall(paths, credential, { op: 'read', agentId: accounts.bob, after: details.resumeAfter, limit: 1 });
      assert.deepEqual(page.messages.map((message) => message.id), [first.messageId]);
      const next = await clientCall(paths, credential, { op: 'read', agentId: accounts.bob, after: page.cursor, limit: 1 });
      assert.deepEqual(next.messages.map((message) => message.id), [last.messageId]);
      assert.deepEqual(next.gap, page.gap);
      restarted.limits.messageRetentionMs = Number.MAX_SAFE_INTEGER;
      const seq = restarted.state.seq;
      await assert.rejects(send('unsafe-timestamp'), { code: 'usage' });
      assert.equal(restarted.state.seq, seq);
      assert.equal(restarted.log.poisoned, false);
    } finally { await restarted.stop(); }
  }, { brokerOptions: { mode: 'single-account', now: () => clock, limits: { ...LIMITS, messageRetentionMs: 10 } } });
});
