// Delivered asides (qwts/agent-comms#100, agent-bot-identity#404). The
// agent-bot daemon records an `in` aside for each message that actually entered
// a soul's context, and it can only do that where it can see the delivery
// happen. A soul reading its own mail is the one place it cannot: the read
// goes from the CLI to the broker, and the daemon is not on that path. So after
// a session prints messages — `inbox read` for a person or for a live harness
// session, a hook injecting them — the CLI tells the daemon which ids it
// delivered, over the soul's binding proof (ADR-0008 decision 3 as amended):
//
//   POST <daemon>/v0/asides/delivered
//   { "messageIds": [...], "via": "inbox-read" | "hook-inject", "harnessSessionId"?: "..." }
//
// The two `via` values are reserved in the daemon's aside schema, which fetches
// each body from the broker as the soul.
//
// Best effort throughout. The daemon may be down, old enough not to know this
// route, slow, or refusing, and none of that may change what the command
// printed or the code it exited with, so nothing here throws. A session with no
// binding reports nothing at all: there is no credential to prove the soul
// with, and an aside claimed for an unbound session would be a record nobody
// can attribute.

import { bindingPost } from './client.mjs';

export const DELIVERED_PATH = '/v0/asides/delivered';
export const VIA = Object.freeze(['inbox-read', 'hook-inject']);
// A read must not wait on a daemon that is not answering, so this is short
// enough that a session owner notices the pause and not so short that a busy
// daemon loses the report.
export const TIMEOUT_MS = 2_000;
// The broker caps one mailbox at 1000 unacknowledged messages, so this bounds
// any real report; a longer list is a bug on this side, not a large mailbox.
const MAX_IDS = 1_000;

// Whether this invocation handed messages to something that reads them. The
// hook knows its session and always counts. `inbox read` prints JSON either
// way, so `--json` is the claim that the output is machine output: only a
// terminal behind it means a person is reading, and output a script consumes
// is not in a soul's context (agent-bot-identity#404 point 2).
export function shouldReportDelivered({ via, json = false, tty = false, env = {} } = {}) {
  if (!VIA.includes(via)) return false;
  // The agent-bot daemon reads a soul's mailbox through this same CLI (its
  // cold-wake relay, and the delivered route itself); it sets this so that
  // read is never reported back to it, which would recurse.
  if (env.AGENT_COMMS_NO_DELIVERY_REPORT === '1') return false;
  return via === 'hook-inject' || !json || Boolean(tty);
}

// Report the ids this session printed. Returns what happened, or null when
// there was nothing to report; it never rejects and never throws, because
// every caller is a command that has already done its real work.
export async function reportDelivered(context, { messageIds, via, harnessSessionId = null } = {}) {
  // Only a bound session can authenticate, and a claim with no proof behind it
  // is worse than no claim.
  if (!context?.binding) return null;
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).filter((id) => typeof id === 'string' && id))];
  if (!ids.length) return null;
  if (!VIA.includes(via)) return { ok: false, reason: `unknown aside via ${via}` };
  const body = {
    messageIds: ids.slice(0, MAX_IDS),
    via,
    ...(typeof harnessSessionId === 'string' && harnessSessionId ? { harnessSessionId } : {}),
  };
  try {
    const response = await bindingPost(context, DELIVERED_PATH, body, { timeoutMs: TIMEOUT_MS });
    if (response.status < 200 || response.status >= 300) return { ok: false, reason: `the daemon answered ${response.status}` };
    return { ok: true, status: response.status, reported: body.messageIds.length };
  } catch (error) {
    // A daemon that is down, slow, or refusing says nothing about the read the
    // session already has.
    return { ok: false, reason: error.message };
  }
}