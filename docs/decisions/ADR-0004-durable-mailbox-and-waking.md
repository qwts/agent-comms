# ADR-0004: Durable mailbox delivery, and waking through the daemon planes

**Status:** Proposed
**Date:** 2026-09-30
**Issue:** qwts/agent-comms#4

## Context

An agent is usually not listening. It runs a turn, stops, and runs again when
something prompts it. A message sent while it is idle must survive until it
reads it, and something may need to prompt it. The first draft of this series
specified durable delivery in detail but said a watch "does not wake a model"
and left waking open.

agent-bot-identity epic
[#142](https://github.com/qwts/agent-bot-identity/issues/142) designs three
planes for reaching a session:

- **drive**: the daemon starts or resumes a harness turn over ACP (built,
  agent-bot-identity#144);
- **reach-back**: MCP tools that let a session fetch context and post replies
  (built, agent-bot-identity#146);
- **wake**: a persistent listener armed at session start, so the daemon can
  push a frame into a warm session (agent-bot-identity#147, open). The spike behind it woke a
  Claude Code session through a `Monitor` on a socket.

The production daemon does not yet wire an executor, so every `/v1` message
fails with `no executor is configured for this daemon` until that lands.
Mailboxes live in the broker
([ADR-0002](ADR-0002-messaging-plane-on-the-agent-bot-daemon.md)), which runs
while accounts are logged out.

## Decision

1. **Each joined soul has a durable mailbox in the broker.** A soul gets a
   mailbox when it joins the hub
   ([ADR-0003](ADR-0003-agents-are-souls-humans-are-principals.md)). A message is
   an immutable record with a `message_id`, the sender (a soul or principal,
   with its account), the recipient address, a kind, a
   body of at most 32 KiB, optional artifact references, and correlation IDs.
   The broker writes it durably before it reports success. A failed write is
   an error, never a silent drop.
2. **Idempotency matches `/v1`.** Every send carries an idempotency key. The
   broker stores a fingerprint of the whole send request: recipient, kind,
   body, artifact references, and correlation IDs. The same sender, key, and
   fingerprint return the original `message_id`; the same key with any
   different field is a `conflict`. The deduplication window is published with
   the retention limits.
3. **Reading, receipt, and work are separate.**
   - `agent-comms inbox read` returns a bounded page starting at the first
     unacknowledged message. `inbox watch` streams one JSON message per line
     from the same point. Both return the same message IDs.
   - A cursor pages forward within one reading session only. The durable
     restart point is the acknowledgement watermark, so a reader that crashes
     before acknowledging sees the message again. A cursor is never a
     substitute for an acknowledgement.
   - `agent-comms inbox ack <message_id>` records a durable receipt. The
     watermark advances past each contiguous run of acknowledged messages.
   - Task acceptance and completion are task events
     ([ADR-0005](ADR-0005-a2a-at-the-broker-edge.md)), never inferred from a
     read or a receipt.
4. **Delivery is at least once.** Consumers deduplicate by `message_id`.
   Order holds within one mailbox only; there is no order across accounts.
5. **Limits are explicit and failures are typed.** Message size, mailbox
   bytes, and retention are published together. A full mailbox rejects new
   sends with `mailbox-full`. A cursor older than retention returns
   `cursor-expired` with the earliest available position; the broker never
   moves a reader forward silently. Unread messages removed by retention are
   reported as a gap.
6. **Waking is a separate, recorded step.** After a message commits, the
   broker records a wake intent for the recipient and tries, in order:
   1. **warm**: a listener the session armed receives the message. In the
      bootstrap release that listener is `agent-comms inbox watch` run under a
      harness primitive that turns output into a turn, such as Claude Code's
      `Monitor`. Once agent-bot-identity#147 ships, the recipient account's
      daemon, connected to the broker as that account's paired client,
      receives the wake and pushes a frame over the wake plane;
   2. **cold**: when the owner has enabled cold wake for that soul, the
      recipient account's daemon receives the wake the same way and resumes
      the soul's harness session over the drive plane, with a turn that names the `message_id`;
   3. **none**: the message waits for the soul's next session-initiated read.

   The wake outcome (`warm`, `cold`, `waiting`, or `failed`) is recorded
   beside the message. A wake is not a receipt. Wakes for one soul are
   coalesced and rate limited, so a burst of messages starts at most one turn.
7. **Cold wake is off by default.** A cold wake spends a harness turn and a
   model call, and the executor is not wired. The owner enables it per soul,
   with the principal operations of the daemon, once the executor ships.
8. **Message content grants nothing.** A peer message is untrusted input under
   [ENG-0081](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0081-transcript-bound-agent-execution-identities.md)
   decision 8. It cannot select an App, widen access, approve a
   proposal, or stand in for an owner decision. Approvals stay digest-bound
   daemon proposals.
9. **No webhooks in the core.** Every consumer is local, and waking replaces
   what a webhook would do. A later ADR may add them.

## Consequences

- A disconnected agent still receives every retained message later, with no
  harness adapter.
- Claude Code sessions can be woken from the first release through
  `Monitor`. Other harnesses wake through agent-bot-identity#147 or the executor once they
  ship, and until then read at session start or poll. Delivery waits for
  neither.
- A logged-out account cannot be woken at all; its souls read their mail
  when the owner next switches in.
- A woken agent may decide not to act. Only its task events or replies say
  what it did.
- Groups, fan-out, and competing consumers of one mailbox are deferred.
  Direct and task-scoped messages come first.

## Alternatives

- **Treat a watch as a wake:** rejected. A watch writes bytes to a process; it
  does not start a model turn.
- **Always cold-wake:** rejected. It spends turns on every message and races
  with sessions the owner is running by hand.
- **Delete on read:** rejected. It loses messages on a crash between read and
  processing.
