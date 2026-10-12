import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import test from 'node:test';
import { createLocalChannel } from '../lib/platform/local-channel.mjs';

// Exercise the real Windows channel constructor through its existing injected
// transport seam. No PowerShell, account state or native pipe is created here.
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
function subject(dispose = () => {}) {
  const raw = new EventEmitter(); let disposals = 0;
  raw.destroy = () => { disposals++; dispose(raw); return raw; };
  const channel = createLocalChannel('win32', { isolation: { currentUid: () => SID }, createConnection: () => raw });
  return { raw, operation: channel.removeStaleSocket('CANARY-private-admin.sock'), disposals: () => disposals };
}
function resultListenersRemoved(raw) {
  assert.equal(raw.listenerCount('connect'), 0); assert.equal(raw.listenerCount('close'), 0);
  assert.equal(raw.listenerCount('error'), 1, 'one stream-local error listener survives late errors');
  for (let n = 0; n < 3; n++) assert.doesNotThrow(() => raw.emit('error', new Error('CANARY-late-private-error')));
  assert.equal(raw.listenerCount('error'), 1, 'late errors never accumulate listeners');
}

test('ordinary refusal settles absent, disposes once and handles late errors without accumulating result listeners', async () => {
  const value = subject();
  value.raw.emit('error', Object.assign(new Error('CANARY-refusal-detail'), { code: 'ECONNREFUSED' }));
  await value.operation;
  assert.equal(value.disposals(), 1); resultListenersRemoved(value.raw);
});

test('close before a result refuses explicitly with no path, error detail or cause', async () => {
  const value = subject(); value.raw.emit('close', new Error('CANARY-close-detail'));
  await assert.rejects(value.operation, error => {
    assert.equal(error.code, 'broker-probe-failed');
    assert.equal(error.message, 'the broker pipe probe closed before reporting a result');
    assert.equal(error.cause, undefined); assert.equal(JSON.stringify(error).includes('CANARY'), false); return true;
  });
  assert.equal(value.disposals(), 1); resultListenersRemoved(value.raw);
});

test('observed live connection stays broker-running when synchronous disposal emits error and close', async () => {
  const value = subject(raw => { raw.emit('error', new Error('CANARY-disposal-error')); raw.emit('close'); });
  assert.doesNotThrow(() => value.raw.emit('connect'));
  await assert.rejects(value.operation, { code: 'broker-running' });
  assert.equal(value.disposals(), 1); resultListenersRemoved(value.raw);
});

test('disposal throws cannot escape the connect callback or turn a live decision into absence', async () => {
  const value = subject(() => { throw new Error('CANARY-disposal-throw'); });
  assert.doesNotThrow(() => value.raw.emit('connect'));
  value.raw.emit('error', new Error('CANARY-later-error')); value.raw.emit('close');
  await assert.rejects(value.operation, { code: 'broker-running' });
  assert.equal(value.disposals(), 1); resultListenersRemoved(value.raw);
});

test('ordinary refusal and unexplained close preserve their decisions when disposal throws', async () => {
  for (const first of ['error','close']) {
    const value = subject(() => { throw new Error('CANARY-disposal-throw'); });
    assert.doesNotThrow(() => value.raw.emit(first, new Error('CANARY-original-detail')));
    if (first === 'error') await value.operation;
    else await assert.rejects(value.operation, { code: 'broker-probe-failed' });
    assert.equal(value.disposals(), 1); resultListenersRemoved(value.raw);
  }
});

test('actual Duplex asynchronous disposal errors stay handled after the live result settles', async () => {
  const raw = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); },
    destroy(error, callback) { callback(new Error('CANARY-native-shaped-disposal')); } });
  const channel = createLocalChannel('win32', { isolation: { currentUid: () => SID }, createConnection: () => raw });
  const operation = channel.removeStaleSocket('broker.sock'); raw.emit('connect');
  await assert.rejects(operation, { code: 'broker-running' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(raw.destroyed, true); resultListenersRemoved(raw);
});
