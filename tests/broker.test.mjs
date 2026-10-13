import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { withBroker } from './helpers/broker.mjs';

const newSoul = () => `agent_${randomUUID()}`;

test('peers lists other joined souls by address', async () => withBroker(async ({ cli, accounts }) => {
  const { json } = await cli(['peers']);
  assert.deepEqual(json.peers.map((peer) => peer.name), ['bob']);
  assert.match(json.peers[0].address, new RegExp(`/${accounts.bob}$`));
}));

test('send, read, and ack follow the acknowledgement watermark', async () => withBroker(async ({ cli, accounts }) => {
  const sent = await cli(['send', accounts.bob, '--body', 'hello bob', '--key', 'k1']);
  assert.equal(sent.exit, 0, JSON.stringify(sent.json));
  assert.equal(sent.json.wake, 'waiting');
  const first = await cli(['inbox', 'read'], accounts.bob);
  assert.equal(first.json.messages.length, 1);
  const [message] = first.json.messages;
  assert.equal(message.body, 'hello bob');
  assert.equal(message.from.verification, 'claimed');
  assert.equal((await cli(['inbox', 'read'], accounts.bob)).json.messages[0].id, message.id);
  assert.equal((await cli(['inbox', 'ack', message.id], accounts.bob)).json.acknowledged, 1);
  assert.equal((await cli(['inbox', 'read'], accounts.bob)).json.messages.length, 0);
}));

test('idempotency covers the whole request', async () => withBroker(async ({ cli, accounts }) => {
  const one = await cli(['send', accounts.bob, '--body', 'same', '--key', 'k2']);
  const two = await cli(['send', accounts.bob, '--body', 'same', '--key', 'k2']);
  assert.equal(two.json.duplicate, true);
  assert.equal(two.json.messageId, one.json.messageId);
  const conflict = await cli(['send', accounts.bob, '--body', 'same', '--kind', 'note', '--key', 'k2']);
  assert.equal(conflict.json.error.code, 'conflict');
}));

test('replies carry depth and cannot answer your own message', async () => withBroker(async ({ cli, accounts }) => {
  const sent = await cli(['send', accounts.bob, '--body', 'question', '--key', 'k3']);
  const reply = await cli(['send', accounts.alice, '--body', 'answer', '--key', 'k4', '--reply-to', sent.json.messageId], accounts.bob);
  assert.equal(reply.exit, 0, JSON.stringify(reply.json));
  const ownReply = await cli(['send', accounts.bob, '--body', 'x', '--key', 'k5', '--reply-to', sent.json.messageId]);
  assert.equal(ownReply.json.error.code, 'unknown-message');
  const inbox = await cli(['inbox', 'read'], accounts.alice);
  assert.equal(inbox.json.messages.find((m) => m.id === reply.json.messageId).depth, 1);
}));

test('allowlists hide a soul from senders it does not accept', async () => withBroker(async ({ cli, accounts }) => {
  const carol = newSoul();
  await cli(['join', '--name', 'carol', '--allow', accounts.bob], carol);
  const peers = await cli(['peers']);
  assert.ok(!peers.json.peers.some((peer) => peer.agentId === carol));
  assert.equal((await cli(['send', carol, '--body', 'hi', '--key', 'k6'])).json.error.code, 'unknown-recipient');
  assert.equal((await cli(['send', carol, '--body', 'hi', '--key', 'k7'], accounts.bob)).exit, 0);
}));

test('send refuses a body that would not fit in a read page once escaped', async () => withBroker(async ({ cli, root, accounts }) => {
  const file = path.join(root, 'nul-body');
  writeFileSync(file, '\0'.repeat(21_500));
  assert.equal((await cli(['send', accounts.bob, '--body-file', file, '--key', 'k-nul'])).json.error.code, 'message-too-large');
}));

test('a retry gets its original answer after the recipient leaves', async () => withBroker(async ({ cli }) => {
  const dave = newSoul();
  await cli(['join', '--name', 'dave'], dave);
  const first = await cli(['send', dave, '--body', 'before you go', '--key', 'k-dave']);
  await cli(['leave'], dave);
  const retry = await cli(['send', dave, '--body', 'before you go', '--key', 'k-dave']);
  assert.equal(retry.json.duplicate, true);
  assert.equal(retry.json.messageId, first.json.messageId);
  assert.equal((await cli(['send', dave, '--body', 'a new message', '--key', 'k-dave-2'])).json.error.code, 'unknown-recipient');
}));

test('a read page stays within one protocol line', async () => withBroker(async ({ cli }) => {
  const erin = newSoul();
  await cli(['join', '--name', 'erin'], erin);
  const body = 'x'.repeat(30 * 1024);
  for (let i = 0; i < 6; i += 1) assert.equal((await cli(['send', erin, '--body', body, '--key', `k-erin-${i}`])).exit, 0);
  const page = await cli(['inbox', 'read', '--limit', '100'], erin);
  assert.ok(page.json.messages.length >= 1 && page.json.messages.length < 6);
  assert.equal(page.json.remaining, 6 - page.json.messages.length);
}));
