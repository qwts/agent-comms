// A harness worker (issue #20): join the hub, watch the inbox, run each
// message as one headless harness turn, reply, then acknowledge. One turn at a
// time. Delivery is at-least-once, so a crash before the ack replays the
// message, and the reply key makes the replayed reply idempotent.
//
// The worker never pushes or publishes. A turn runs as its account's delegate,
// in the credential jail, and the prompt says what a peer message cannot do.

import { LIMITS } from '../broker/shared.mjs';
import { call, loadCredential, resolveSoul } from '../client.mjs';
import { brokerPaths, clientPaths } from '../paths.mjs';
import { buildJail } from './jail.mjs';
import { recordTurn } from './metrics.mjs';
import { resolveOptions } from './options.mjs';
import { turnPrompt } from './prompt.mjs';
import { runTurn } from './turn.mjs';
import { watchInbox } from './watch.mjs';

// The broker takes a body of at most 32 KiB; leave the headroom the prefix and
// escaping need.
const REPLY_BYTES = LIMITS.bodyBytes - 2_048;

// A reply the broker will never accept: the sender has gone, or the
// conversation is already too deep. Replaying such a message would spend a
// model turn on every restart and could still never answer it.
const UNDELIVERABLE = new Set(['unknown-recipient', 'reply-depth-exceeded']);

// A watch refused outright will be refused again, so the worker stops rather
// than reconnecting in a loop.
const REFUSED = new Set(['not-joined', 'not-approved', 'unauthenticated', 'soul-taken']);

// The listener comes off the signal again, so a worker that reconnects for
// hours does not pile them up.
const sleep = (ms, signal) => new Promise((resolve) => {
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

// Cut on a byte boundary, so the reply never ends in half a character, and say
// how much was dropped.
function truncate(text) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= REPLY_BYTES) return text;
  return `…[truncated, ${bytes.length} bytes]\n${bytes.subarray(0, REPLY_BYTES).toString('utf8').replace(/\uFFFD+$/, '')}`;
}

function failure(harness, turn) {
  const because = turn.exit === null && turn.signal
    ? `signal ${turn.signal}${turn.timedOut ? ' after the turn timeout' : ''}`
    : `exit ${turn.exit}`;
  const detail = [turn.error, turn.stderr.split('\n').slice(-5).join('\n'), turn.answer.slice(-2_000)]
    .filter(Boolean).join('\n');
  return `${harness} turn failed (${because}).${detail ? `\n${detail}` : ''}`;
}

export function runWorker(options = {}) {
  const settings = resolveOptions(options);
  const { adapter, env, log, now, metrics, turnTimeoutMs, killAfterMs, reconnectMs } = settings;
  const { workspace, model, effort, sandbox } = settings;
  const paths = settings.paths ?? brokerPaths(env);
  const soul = resolveSoul(env, workspace);
  const credential = loadCredential(settings.client ?? clientPaths(env));
  const request = settings.transport ?? ((payload) => call(paths, credential, { ...payload, agentId: soul }));
  const watch = settings.watch ?? ((state) => watchInbox({ ...state, log }));
  const jail = buildJail({ harness: adapter.name, workspace, env, root: settings.jailRoot });

  const abort = new AbortController();
  const queue = [];
  const seen = new Set();
  let busy = false;
  let backlog = false;
  let running = null;
  let watching = null;
  let refused = null;
  let stopped = false;

  function enqueue(message) {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    queue.push(message);
    drain();
  }

  // A coalesced wake names no message, so read the page behind it.
  async function page() {
    const result = await request({ op: 'read', limit: LIMITS.readPage });
    const fresh = result.messages.filter((message) => !seen.has(message.id));
    fresh.forEach(enqueue);
    // Ask again only when a page turned up something new: a message still
    // waiting on its ack is that same message, and paging it would spin.
    backlog = result.remaining > 0 && fresh.length > 0;
  }

  async function handle(message) {
    log('task', message.id, 'from', message.from.agentId);
    const started = now();
    const turn = await runTurn({
      adapter, prompt: turnPrompt(message, { harness: adapter.name, soul }), workspace,
      env: jail.env, artifacts: jail.root, model, effort, sandbox,
      timeoutMs: turnTimeoutMs, killAfterMs, signal: abort.signal, now,
    });
    if (metrics) {
      recordTurn(metrics, {
        at: new Date(started).toISOString(),
        harness: adapter.name,
        model: model ?? 'default',
        effort: effort ?? 'default',
        sandbox,
        message: message.id,
        correlation: message.correlation ?? null,
        exit: turn.exit,
        signal: turn.signal,
        timedOut: turn.timedOut,
        ms: turn.ms,
        usage: turn.usage,
        answerChars: turn.answer.length,
      });
    }
    // An interrupted turn keeps its message: the next run replays it.
    if (stopped) return log('interrupted', message.id);

    const ok = turn.exit === 0 && turn.answer !== '';
    const replyTo = `${message.from.account}/${message.from.agentId}`;
    try {
      const sent = await request({
        op: 'send',
        to: replyTo,
        body: truncate(ok ? turn.answer : failure(adapter.name, turn)),
        kind: ok ? 'result' : 'error',
        key: `reply-${message.id}`,
        replyTo: message.id,
      });
      log('replied', message.id, sent?.messageId ?? '', sent?.duplicate ? 'already replied' : '');
    } catch (error) {
      // A conflict means an earlier run already answered this message.
      if (error.code === 'conflict') log('already replied', message.id);
      else if (UNDELIVERABLE.has(error.code)) log('dropping the reply', message.id, error.code, '- nobody left to answer');
      else return log('reply failed', message.id, error.code ?? error.message, '- left unacknowledged for replay');
    }
    try {
      await request({ op: 'ack', ids: [message.id] });
      log('done', message.id);
    } catch (error) {
      log('ack failed', message.id, error.code ?? error.message, '- delivered again next time');
    }
  }

  function drain() {
    if (busy || stopped || !queue.length) return;
    busy = true;
    running = (async () => {
      try {
        for (;;) {
          // A message still queued when the worker stops keeps its turn: the
          // next run replays it.
          while (queue.length && !stopped) await handle(queue.shift());
          if (!backlog || stopped) return;
          // page() owns the flag, so a failed read keeps the backlog and the
          // next event tries it again.
          await page();
        }
      } catch (error) {
        log('worker stopped paging', error.code ?? error.message);
      } finally {
        busy = false;
        running = null;
      }
    })();
  }

  function onEvent(event) {
    if (event.event === 'ready') return log('watching as', event.address);
    if (event.event === 'message' && event.message) return enqueue(event.message);
    // A coalesced wake (issue #19) carries no message of its own.
    if (event.event === 'wake') return page().catch((error) => log('read failed', error.code ?? error.message));
    // The watch child answers a refusal on its own stdout before it exits.
    if (REFUSED.has(event.error?.code)) {
      refused = event.error.code;
      log('watch refused', event.error.code, '- not reconnecting');
      watching?.kill();
    }
    return undefined;
  }

  // The watch is the only way the worker hears; a dropped one reconnects
  // instead of leaving the inbox unattended.
  async function follow() {
    while (!stopped) {
      try {
        watching = watch({ bin: settings.bin, soul, env, onEvent, log });
        const { code, signal } = await watching.closed;
        log('watch ended', signal ?? `exit ${code}`);
      } catch (error) {
        log('watch failed', error.code ?? error.message);
      }
      if (stopped || refused) return;
      await sleep(reconnectMs, abort.signal);
    }
  }

  const ready = (async () => {
    // Reuse a joined soul as it stands: `peers` answers only for a joined
    // soul, and re-joining would clear the name and allowlist the operator
    // set on it.
    try {
      await request({ op: 'peers' });
    } catch (error) {
      if (error.code !== 'not-joined') throw error;
      await request({ op: 'join', ...settings.join, harness: adapter.name });
    }
    follow();
    return `${credential.account}/${soul}`;
  })();
  ready.catch((error) => log('worker cannot start', error.code ?? error.message));

  return {
    soul,
    ready,
    async stop() {
      stopped = true;
      abort.abort(); // ends the turn in flight, leaving its message unacked
      watching?.kill();
      if (running) await running;
    },
  };
}
