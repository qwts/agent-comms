import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOriginalRetry, assertRetainedMessage, taskQueryProvesAbsence, safeFailure } from '../scripts/windows-upgrade-evidence.mjs';

test('upgrade evidence requires the exact original retry outcome', () => {
  const original = { messageId: 'msg_original', seq: 17, wake: 'waiting' };
  assertOriginalRetry(original, { ...original, duplicate: true });
  for (const changed of [{ messageId: 'msg_new' }, { seq: 18 }, { wake: 'queued' }, { duplicate: false }]) {
    assert.throws(() => assertOriginalRetry(original, { ...original, duplicate: true, ...changed }));
  }
});
test('upgrade evidence requires retained content and envelope, not just mailbox presence', () => {
  const original = { messageId: 'msg_original', seq: 17 };
  const payload = { body: 'synthetic ☃ body', refs: ['opaque:reference'], correlation: 'upgrade' };
  const message = { id: original.messageId, seq: original.seq, ...payload, from: 'principal', to: 'account/soul', kind: 'message', at: 123, replyTo: null, depth: 0 };
  assertRetainedMessage([message], original, payload, message);
  for (const changed of [{ id: 'msg_other' }, { seq: 18 }, { body: 'changed' }, { refs: [] }, { correlation: null }, ...['from', 'to', 'kind', 'at', 'replyTo', 'depth'].map(field => ({ [field]: 'changed' }))]) {
    assert.throws(() => assertRetainedMessage([{ ...message, ...changed }], original, payload, message), { name: 'AssertionError' });
  }
});
test('upgrade cleanup rejects arbitrary task query failures and diagnostics exclude raw errors', () => {
  assert.equal(taskQueryProvesAbsence({ exit: 1, stderr: 'ERROR: The system cannot find the file specified.\r\n' }), true);
  for (const response of [{ exit: -1, stderr: '' }, { exit: 0, stderr: '' }, { exit: 1, stderr: 'ERROR: Access is denied.' }]) assert.equal(taskQueryProvesAbsence(response), false);
  assert.deepEqual(safeFailure({ code: 'broker-unreachable', message: 'credential', stdout: 'secret', stderr: 'private' }, 'historical-ready-timeout'), { code: 'broker-unreachable', stage: 'historical-ready-timeout' });
  assert.deepEqual(safeFailure({ code: 'secret with spaces' }, 'private path'), { code: 'assertion-failed' });
});
