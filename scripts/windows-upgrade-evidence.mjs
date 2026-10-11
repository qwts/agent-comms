import assert from 'node:assert/strict';

export function taskQueryProvesAbsence(response) {
  return response.exit > 0 && /^\s*ERROR:\s*The system cannot find the file specified\.\s*$/i.test(response.stderr);
}
export function safeFailure(error, stage) {
  const safe = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
  return { code: safe(error?.code) ? error.code : 'assertion-failed', ...(safe(stage) ? { stage } : {}) };
}
export function assertOriginalRetry(original, retry) {
  assert.equal(retry.duplicate, true);
  for (const field of ['messageId', 'seq', 'wake']) assert.deepEqual(retry[field], original[field]);
}
export function assertRetainedMessage(messages, original, payload, envelope) {
  const message = messages.find(row => row.id === original.messageId);
  assert.ok(message, 'original unacknowledged message must remain readable');
  assert.equal(message.seq, original.seq);
  for (const field of ['body', 'refs', 'correlation']) assert.deepEqual(message[field], payload[field]);
  for (const field of ['from', 'to', 'kind', 'at', 'replyTo', 'depth']) assert.deepEqual(message[field], envelope[field]);
}
