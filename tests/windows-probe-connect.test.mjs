import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { waitForProbeConnect } from './helpers/windows-probe-connect.mjs';

test('a close-only connector settles fixture start without waiting for its control deadline', async () => {
  const raw = new EventEmitter();
  const connected = waitForProbeConnect(raw);
  raw.emit('close');
  await assert.rejects(connected, { message: 'probe-connect-closed' });
  for (const event of ['connect', 'error', 'close']) assert.equal(raw.listenerCount(event), 0);
});

test('an already destroyed connector refuses start immediately', async () => {
  const raw = new EventEmitter();
  raw.destroyed = true;
  await assert.rejects(waitForProbeConnect(raw), { message: 'probe-connect-closed' });
});

test('connector success and error both settle and remove the temporary listeners', async () => {
  for (const event of ['connect', 'error']) {
    const raw = new EventEmitter();
    const connected = waitForProbeConnect(raw);
    const error = new Error('fixture-error');
    raw.emit(event, error);
    if (event === 'connect') await connected;
    else await assert.rejects(connected, value => value === error);
    for (const name of ['connect', 'error', 'close']) assert.equal(raw.listenerCount(name), 0);
    raw.emit('close');
  }
});
