// Disabled native process plumbing. No production path, compiler or authority
// selection is accepted here; only the explicit compiled-fixture constructor
// exists until installed provenance/observation and custody are implemented.
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { decodeOwnerDecisionCanonical } from '../owner-decision-canonical.mjs';
import { assertAncestors } from '../custody.mjs';
import { encodeOwnerReceiptNativeCommand, decodeOwnerReceiptNativeResponse } from './owner-receipt-wire.mjs';
const unavailable = () => new Error('owner-receipt-unavailable');
const same = (a, b) => ['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(k => a[k] === b[k]);
const hash = value => createHash('sha256').update(value).digest('hex');
function artifact(binary, digest) {
  if (typeof binary !== 'string' || !path.isAbsolute(binary) || path.resolve(binary) !== binary
      || typeof digest !== 'string' || /^[a-f0-9]{64}$/.exec(digest)?.[0] !== digest) throw unavailable();
  assertAncestors(binary, process.getuid());
  const before = fs.lstatSync(binary);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.uid !== 0 && before.uid !== process.getuid())
      || (before.mode & 0o7022) !== 0 || (before.mode & 0o111) === 0 || before.size < 1 || before.size > 32 * 1024 * 1024) throw unavailable();
  let fd;
  try {
    fd = fs.openSync(binary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!same(before, fs.fstatSync(fd))) throw unavailable();
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) throw unavailable();
      offset += count;
    }
    if (hash(bytes) !== digest || !same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(binary))) throw unavailable();
  } finally {
    if (fd !== undefined) { const closing = fd; fd = undefined; fs.closeSync(closing); }
  }
  return before;
}
class FixtureInvoker {
  #binary; #digest; #identity; #deadline; #source;
  constructor(binary, digest, deadline, source) {
    this.#binary = binary; this.#digest = digest; this.#identity = artifact(binary, digest); this.#deadline = deadline; this.#source = source;
  }
  startDecisionReceipt(command, { signal } = {}) {
    const deadline = performance.now() + this.#deadline;
    // Allocate owned promises before any possible launch. Every failure after
    // return has a result and independent terminal path, never a naked throw.
    let resultResolve, resultReject, terminalResolve;
    const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    const terminal = new Promise(resolve => { terminalResolve = resolve; });
    // Attach rejection immediately even if a caller abandons the result while
    // continuing to own terminal cleanup. The returned original still rejects.
    result.catch(() => {});
    let child, timer, done = false, resultDone = false, output = [], outputLength = 0, stderrLength = 0;
    const reject = () => { if (!resultDone) { resultDone = true; resultReject(unavailable()); } };
    const stop = () => { reject(); if (child && !done) { try { child.kill('SIGKILL'); } catch {} } };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    const notStarted = () => { done = true; cleanup(); reject(); terminalResolve(Object.freeze({ terminalConfirmed: true, safeClose: true })); };
    let input, expected;
    try {
      input = encodeOwnerReceiptNativeCommand(command);
      const snapshot = JSON.parse(input);
      const action = JSON.parse(Buffer.from(snapshot.originalAction, 'base64url'));
      expected = { requestId: action.requestId, brokerEnrollmentHeadDigest: snapshot.brokerEnrollmentHeadDigest };
      if (this.#source) input = encodeOwnerReceiptSourceFixtureFrame(this.#source.bootstrap, input);
    } catch { notStarted(); return Object.freeze({ result, terminal }); }
    queueMicrotask(() => {
      try {
        if (!(signal instanceof AbortSignal) || signal.aborted || !same(this.#identity, artifact(this.#binary, this.#digest))
            || performance.now() >= deadline) return notStarted();
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) return notStarted();
        if (this.#source && !same(this.#source.identity, fs.fstatSync(this.#source.rootFd))) return notStarted();
        child = spawn(this.#binary, [], { env: {}, cwd: '/', stdio: this.#source ? ['pipe','pipe','pipe',this.#source.rootFd] : ['pipe','pipe','pipe'], windowsHide: true });
      } catch { return notStarted(); }
      // Charge synchronous preparation/verification and the queued gap to the
      // same elapsed deadline. OS synchronous calls are not preemptible; a late
      // return refuses rather than receiving a fresh child-runtime allowance.
      timer = setTimeout(stop, Math.max(1, deadline - performance.now()));
      // No timeout/error event certifies process exit or descriptor closure.
      child.once('error', reject);
      child.stdin.once('error', reject);
      child.stdout.once('error', stop); child.stderr.once('error', stop);
      child.stdout.on('data', bytes => {
        outputLength += bytes.length;
        if (outputLength > 1024) return stop();
        output.push(Buffer.from(bytes));
      });
      child.stderr.on('data', bytes => {
        stderrLength += bytes.length;
        // Native operation has no public stderr protocol. Never retain/print it.
        if (stderrLength > 256) stop();
      });
      child.once('close', (code, exitSignal) => {
        done = true; cleanup();
        terminalResolve(Object.freeze({ terminalConfirmed: true, safeClose: true }));
        try {
          if (resultDone || signal.aborted || performance.now() >= deadline || code !== 0 || exitSignal !== null || stderrLength !== 0
              || !same(this.#identity, artifact(this.#binary, this.#digest))) return reject();
          const decoded = decodeOwnerReceiptNativeResponse(Buffer.concat(output, outputLength), expected);
          if (performance.now() >= deadline) return reject();
          resultDone = true; resultResolve(decoded);
        } catch { reject(); }
        finally { output = []; }
      });
      try { child.stdin.end(input); } catch { stop(); }
    });
    return Object.freeze({ result, terminal });
  }
}
// Internal disposable-test seam. This cannot construct a production capability
// or certify signed identity/custody from a path/hash; actual native worker
// compile/operation/source checks are independently exercised before publication.
export function createOwnerReceiptNativeFixtureInvoker({ binary, binarySha256, syntheticFixture = false, timeoutMilliseconds = 10000 } = {}) {
  try {
    if (!syntheticFixture || process.platform !== 'darwin' || !Number.isSafeInteger(timeoutMilliseconds)
        || timeoutMilliseconds < 1 || timeoutMilliseconds > 10000) throw unavailable();
    return new FixtureInvoker(binary, binarySha256, timeoutMilliseconds);
  } catch { throw unavailable(); }
}

// Private explicit debug framing; caller bytes never select a normal source.
export function encodeOwnerReceiptSourceFixtureFrame(bootstrap, command) {
  try {
    if (!Buffer.isBuffer(bootstrap) || bootstrap.length < 1 || bootstrap.length > 4096
        || !Buffer.isBuffer(command) || command.length < 1 || command.length > 131072) throw unavailable();
    decodeOwnerDecisionCanonical(bootstrap);
    const header = Buffer.alloc(12); header.write('GBRSFX01', 0, 'ascii'); header.writeUInt32BE(bootstrap.length, 8);
    const length = Buffer.alloc(4); length.writeUInt32BE(command.length);
    return Buffer.concat([header, bootstrap, length, command]);
  } catch { throw unavailable(); }
}
export function createOwnerReceiptNativeSourceFixtureInvoker({ binary, binarySha256, bootstrap, rootFd,
  syntheticFixture = false, timeoutMilliseconds = 10000 } = {}) {
  try {
    if (!syntheticFixture || process.platform !== 'darwin' || !Number.isSafeInteger(rootFd) || rootFd < 3
        || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 10000
        || !Buffer.isBuffer(bootstrap) || bootstrap.length < 1 || bootstrap.length > 4096) throw unavailable();
    const copy = Buffer.from(bootstrap); decodeOwnerDecisionCanonical(copy);
    const identity = fs.fstatSync(rootFd);
    if (!identity.isDirectory() || identity.uid !== process.getuid() || (identity.mode & 0o7022) !== 0) throw unavailable();
    // FD3 in the child is a root capability, never a parent-held lock. The caller
    // retains its original descriptor until independent terminal completion.
    return new FixtureInvoker(binary, binarySha256, timeoutMilliseconds, { bootstrap: copy, rootFd, identity });
  } catch { throw unavailable(); }
}
