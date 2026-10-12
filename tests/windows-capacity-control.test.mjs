import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createCapacityController } from '../tools/acceptance/windows-capacity-control.mjs';

function transport() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  let close;
  const exited = new Promise((resolve) => { close = resolve; });
  return { child, exited, terminal: () => false, close };
}
test('malformed supervisor startup refuses immediately with no child source leakage', async () => {
  const owned = transport(), control = createCapacityController(owned);
  owned.child.stdout.write('CANARY-private-path-body\n');
  await assert.rejects(control.startup, { message: 'control-invalid' });
  await assert.rejects(control.request('close'), { message: 'control-invalid' });
  owned.close();
});
test('bounded supervisor output rejects startup and an already pending request', async () => {
  const owned = transport(), control = createCapacityController(owned);
  const request = control.request('close', {}, 50);
  owned.child.stdout.write('x'.repeat(65537));
  await assert.rejects(control.startup, { message: 'control-output-bound' });
  await assert.rejects(request, { message: 'control-output-bound' });
  owned.close();
});
test('valid fixed phases remain bounded metadata and do not prematurely resolve readiness', async () => {
  const owned = transport(), control = createCapacityController(owned);
  let ready = false; control.startup.then(() => { ready = true; });
  owned.child.stdout.write('{"id":-1,"phase":"compile-supervisor"}\n');
  await Promise.resolve(); assert.equal(ready, false);
  assert.deepEqual(control.state(), { phase: 'compile-supervisor', encoding: 'ascii-compatible' });
  owned.child.stdout.write('{"id":0,"ok":true,"phase":"ready"}\n');
  assert.equal((await control.startup).phase, 'ready');
  owned.close();
});
test('UTF16 framing is identified and refused instead of disguised as a deadline', async () => {
  const owned = transport(), control = createCapacityController(owned);
  owned.child.stdout.write(Buffer.from('{"id":0}\n', 'utf16le'));
  await assert.rejects(control.startup, { message: 'control-invalid' });
  assert.equal(control.state().encoding, 'utf16le-json'); owned.close();
});
test('owned terminal before readiness rejects the startup promise', async () => {
  const owned = transport(), control = createCapacityController(owned);
  owned.close(); await assert.rejects(control.startup, { message: 'control-closed' });
});
test('stream failure persists for later requests while the child is still live', async () => {
  const owned = transport(), control = createCapacityController(owned);
  owned.child.stdout.write('{"id":0,"ok":true}\n'); await control.startup;
  owned.child.stdin.emit('error', new Error('CANARY-private-path'));
  await assert.rejects(control.request('close'), { message: 'control-closed' }); owned.close();
});
test('valid acknowledged response survives immediate owned terminal but future calls refuse', async () => {
  const owned = transport(), control = createCapacityController(owned);
  owned.child.stdout.write('{"id":0,"ok":true}\n'); await control.startup;
  const request = control.request('close');
  owned.child.stdout.write('{"id":1,"ok":true,"closed":true}\n'); owned.close();
  assert.equal((await request).closed, true);
  await assert.rejects(control.request('close'), { message: 'control-closed' });
});
test('IPC fixtures preserve the supplied bounded failure classification', async () => {
  const owned = transport(); owned.child.send = () => {};
  const control = createCapacityController(owned, { ipc: true,
    classifyFailure: (record) => new Error(record.failure.check === 'owned-startup-fault' ? 'owned-startup-fault' : 'job-supervisor-failed') });
  const request = control.request('start');
  owned.child.emit('message', { id: 1, ok: false, failure: { check: 'owned-startup-fault' } });
  await assert.rejects(request, { message: 'owned-startup-fault' }); owned.close();
});
test('IPC send failure persists for later calls without waiting for child exit', async () => {
  const owned = transport(); owned.child.send = (record, callback) => callback(new Error('CANARY-private-path'));
  const control = createCapacityController(owned, { ipc: true });
  await assert.rejects(control.request('start'), { message: 'control-closed' });
  await assert.rejects(control.request('start'), { message: 'control-closed' }); owned.close();
});
