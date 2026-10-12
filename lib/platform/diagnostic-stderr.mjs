// Isolate stderr I/O from both the broker event loop and its process lifetime.
// An unref Worker is insufficient: a blocked async fs request can still keep
// the containing process alive during Worker teardown.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export function createDiagnosticStderr(platform = process.platform) {
  const stream = new EventEmitter();
  let child;
  let pending;
  let stopped = false;

  function terminate() {
    try { child?.kill('SIGKILL'); } catch { /* No cleanup failure reaches the broker. */ }
  }

  function failure() {
    if (stopped) return;
    stopped = true;
    const callback = pending;
    pending = null;
    const error = new Error('diagnostic stderr is unavailable');
    callback?.(error);
    stream.emit('error', error);
    terminate();
  }

  stream.write = (line, callback) => {
    if (stopped || pending) { callback(new Error('diagnostic stderr is unavailable')); return false; }
    pending = callback;
    try {
      if (!child) {
        // The helper needs no credentials, Node preload hooks, or stdout.
        const writer = new URL('../diagnostic-writer.mjs', import.meta.url).href;
        // Catch even missing/broken helper modules before Node could print a
        // loader stack containing identifying package paths to inherited fd 2.
        child = spawn(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(writer)}).catch(() => process.exit(0));`], {
          env: platform === 'win32' && process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot } : {},
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        child.on('message', (message) => {
          if (stopped || !pending) return;
          if (message?.ok !== true) { failure(); return; }
          const completed = pending;
          pending = null;
          completed();
        });
        child.on('error', failure);
        child.on('exit', failure);
        child.on('close', () => {
          process.removeListener('exit', terminate);
          stream.emit('close');
        });
        process.once('exit', terminate);
        child.unref();
        child.channel?.unref();
      }
      // At most one <=512-byte record is in IPC until the helper acknowledges
      // the complete stderr write. No send callback queues another record.
      child.send({ line }, (error) => { if (error) failure(); });
    } catch { failure(); }
    return true;
  };

  // Private lifecycle seam for tests and process cleanup, not a broker API.
  Object.defineProperty(stream, 'pid', { get: () => child?.pid ?? null });
  return stream;
}
