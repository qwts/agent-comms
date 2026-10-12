import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createOwnerReceiptNativeFixtureInvoker as invoker } from '../lib/platform/owner-receipt-native.mjs';
const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/protected-signing-v1.json', import.meta.url))).cases;
const command = () => JSON.parse(vectors[0].commandJson);
const c = command(), action = JSON.parse(Buffer.from(c.originalAction, 'base64url'));
const response = JSON.stringify(Object.fromEntries(Object.entries({ v: 1, kind: 'owner-decision-receipt-signature', requestId: action.requestId,
  brokerEnrollmentHeadDigest: c.brokerEnrollmentHeadDigest, signature: vectors[0].signature }).sort()));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = promise => assert.rejects(promise, { message: 'owner-receipt-unavailable' });
// Process-lifetime fixture only; this compiled C emitter is not the native
// cryptographic worker. Positive native signature reconstruction is a separate
// required connected test using the true-line standalone worker.
function compile(t, mode = 0, timeoutMilliseconds = 1000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-receipt-process-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'worker.c'), binary = path.join(root, 'worker');
  fs.writeFileSync(source, `#include <unistd.h>\n#include <string.h>\nint main(void){char input[131073];size_t used=0;ssize_t n;while((n=read(0,input+used,sizeof(input)-used))>0){used+=(size_t)n;if(used==sizeof(input))return 2;}if(n<0||!used)return 2;\n#if MODE==1\nchar excess[1025];memset(excess,'x',sizeof(excess));write(1,excess,sizeof(excess));\n#elif MODE==2\nwrite(2,"sensitive",9);\n#elif MODE==3\nusleep(500000);\n#elif MODE==4\nif(fork()==0){usleep(150000);_exit(0);}\n#endif\nconst char *response=${JSON.stringify(response)};return write(1,response,strlen(response))==(ssize_t)strlen(response)?0:3;}\n`);
  execFileSync('xcrun', ['clang','-Wall','-Wextra','-Werror','-mmacosx-version-min=13.0',`-DMODE=${mode}`,source,'-o',binary], { timeout: 20000, stdio: 'pipe' });
  fs.chmodSync(binary, 0o700);
  return { binary, core: invoker({ binary, binarySha256: sha(fs.readFileSync(binary)), syntheticFixture: true, timeoutMilliseconds }) };
}
test('compiled process adapter snapshots command, validates response and owns independent terminal', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const { core } = compile(t), controller = new AbortController(), mutable = command();
  const invocation = core.startDecisionReceipt(mutable, { signal: controller.signal });
  mutable.originalAction = 'invalid';
  const result = await invocation.result;
  assert.deepEqual(result.signature, Buffer.from(vectors[0].signature, 'base64url'));
  assert.deepEqual(await invocation.terminal, { terminalConfirmed: true, safeClose: true });
});
test('compiled process adapter bounds stdout, sanitizes stderr and waits after cancellation/deadline', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  for (const mode of [1,2,3]) {
    const { core } = compile(t, mode, mode === 3 ? 25 : 1000), controller = new AbortController();
    const invocation = core.startDecisionReceipt(command(), { signal: controller.signal });
    await unavailable(invocation.result);
    assert.deepEqual(await invocation.terminal, { terminalConfirmed: true, safeClose: true });
  }
  const { core } = compile(t, 3), controller = new AbortController();
  const invocation = core.startDecisionReceipt(command(), { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await unavailable(invocation.result); assert.equal((await invocation.terminal).terminalConfirmed, true);
});
test('compiled adapter does not treat parent exit as closed pipes and never launches after immediate abort', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const { core } = compile(t, 4), controller = new AbortController();
  const start = performance.now(), invocation = core.startDecisionReceipt(command(), { signal: controller.signal });
  await invocation.result; await invocation.terminal;
  assert.ok(performance.now() - start >= 100, 'inherited stdout must remain charged until close');
  const cancelled = new AbortController();
  const late = core.startDecisionReceipt(command(), { signal: cancelled.signal }); cancelled.abort();
  await unavailable(late.result); assert.equal((await late.terminal).safeClose, true);
});
test('fixture artifact must be pinned and unchanged; no production selection is exposed', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const { core, binary } = compile(t), controller = new AbortController();
  assert.throws(() => invoker({ binary, binarySha256: '0'.repeat(64), syntheticFixture: true }), { message: 'owner-receipt-unavailable' });
  assert.throws(() => invoker({ binary, binarySha256: sha(fs.readFileSync(binary)) }), { message: 'owner-receipt-unavailable' });
  fs.chmodSync(binary, 0o600);
  const invocation = core.startDecisionReceipt(command(), { signal: controller.signal });
  await unavailable(invocation.result); assert.equal((await invocation.terminal).terminalConfirmed, true);
});
