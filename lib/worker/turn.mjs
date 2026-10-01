// One headless harness turn. The harness runs in the worker's workspace with
// the jail's environment, and the turn is bounded twice over: a wall clock
// timeout, and the worker's own stop signal, which ends an interrupted turn
// without leaving the harness process behind.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

// Keep the tail of a chatty turn, not all of it: a turn that prints megabytes
// must not grow the worker's memory without bound.
const STDOUT_KEEP = 2_000_000;
const STDERR_KEEP = 4_000;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g; // the escape sequences a terminal harness prints

const tail = (text, keep) => (text.length > keep ? text.slice(-keep) : text);

function usageOf(stdout) {
  let usage = null;
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.completed' && event.usage) usage = event.usage;
    } catch {
      // not an event line
    }
  }
  return usage;
}

// `answer: 'file'` harnesses leave their final message in the file named by
// `out`; the rest answer on stdout, chrome and all.
function readAnswer(adapter, out, stdout) {
  if (adapter.answer !== 'file') return stdout.replace(ANSI, '').trim();
  try {
    return readFileSync(out, 'utf8').trim();
  } catch {
    return '';
  }
}

export function runTurn({
  adapter, prompt, workspace, env, artifacts, model = null, effort = null, sandbox = null,
  timeoutMs = 30 * 60 * 1000, killAfterMs = 5_000, signal = null, now = () => Date.now(),
}) {
  // The final message lands beside the jail, never in the worker's tree.
  const out = path.join(artifacts, `turn-${randomUUID()}.txt`);
  const started = now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let kill = null;
    const child = spawn(adapter.cmd, adapter.args({ prompt, out, workspace, model, effort, sandbox }), {
      cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = tail(stdout + chunk, 4 * STDOUT_KEEP); });
    child.stderr.on('data', (chunk) => { stderr = tail(stderr + chunk, STDERR_KEEP); });

    const timer = AbortSignal.timeout(timeoutMs);
    const end = AbortSignal.any(signal ? [timer, signal] : [timer]);
    // A harness that ignores SIGTERM gets one SIGKILL, then the turn is over.
    const onEnd = () => {
      child.kill('SIGTERM');
      kill = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
      kill.unref();
    };
    if (end.aborted) onEnd();
    else end.addEventListener('abort', onEnd, { once: true });

    const result = (exit, sig) => ({
      exit,
      signal: sig ?? null,
      timedOut: timer.aborted,
      ms: now() - started,
      answer: readAnswer(adapter, out, stdout),
      usage: usageOf(stdout),
      stderr: stderr.trim(),
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      end.removeEventListener('abort', onEnd);
      rmSync(out, { force: true });
      resolve(value);
    };
    child.on('error', (error) => finish({ ...result(null, null), error: error.message }));
    child.on('close', (code, sig) => finish(result(code, sig)));
  });
}
