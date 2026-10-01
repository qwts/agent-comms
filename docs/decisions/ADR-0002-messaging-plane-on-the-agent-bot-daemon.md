# ADR-0002: agent-comms is a messaging plane on the agent-bot daemon

**Status:** Accepted
**Date:** 2026-09-30
**Issue:** qwts/agent-comms#2

## Context

agent-comms lets agents in different harnesses message each other, hand off
tasks, and reach external agents, without a harness-specific control adapter.
A proof of concept worked across several harness CLIs, VS Code, Devin Desktop,
Hermes, and Pi by giving every harness one CLI to call.

The first draft of this series designed a new per-user hub with its own
identities, store, IPC, and authorization. The
[agent-bot daemon](https://github.com/qwts/agent-bot-identity) already
provides most of that in each macOS account:

- a loopback service with a per-start bearer token in a 0600 state file,
  supervised by a per-user LaunchAgent;
- the versioned `/v1` interaction contract: sessions, messages with required
  idempotency keys, invocations, ordered events, cancellation, and artifacts;
- principals with deny-by-default authorization per soul and operation, and
  secret-free audit receipts;
- transcript-bound souls (`agent_<uuid>`), worktree binding, and the
  population census;
- an ACP drive engine and the reach-back MCP tools, designed as planes in
  [agent-bot-identity#142](https://github.com/qwts/agent-bot-identity/issues/142).

It does not provide messages between agents, a way across macOS accounts, or
A2A. A second hub beside the daemon would split identity, authorization, and
audit into two systems of record in every account. And because each daemon
runs only while its account is logged in, messages for a logged-out account
have to wait somewhere outside it.

## Decision

1. **The daemon stays the per-account trust boundary.** It remains the system
   of record for souls, principals, sessions, invocations, and audit, and it
   runs the drive and wake planes. agent-comms adds no second per-account
   service and no second identity or authorization store.
2. **The broker is the machine's message store.** One broker per machine
   ([ADR-0006](ADR-0006-machine-broker-between-persona-accounts.md)) holds
   every joined soul's mailbox and the machine census, so no message depends
   on the recipient's daemon running. In its target deployment it also runs
   whether or not any account is logged in; the bootstrap release runs while
   the owner is logged in.
3. **agent-comms owns four things.**
   - The broker and its mailboxes
     ([ADR-0004](ADR-0004-durable-mailbox-and-waking.md)).
   - The `agent-comms` CLI, the one command every harness calls.
   - The A2A gateway, inside the broker
     ([ADR-0005](ADR-0005-a2a-at-the-broker-edge.md)).
   - The contract the GeniusBar menubar app reads
     ([ADR-0007](ADR-0007-observability-and-geniusbar.md)).
4. **Daemon changes land in agent-bot-identity.** Where agent-comms needs new
   daemon routes, such as persisted bindings or wake dispatch, the change is
   specified here and built there, under its review, per
   [ENG-0128](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0128-agent-bot-runtime-ownership.md).
   agent-comms reaches the daemon only through versioned HTTP contracts. It
   never reads or writes the daemon's state files, as agent-bot-identity#35
   requirement 13 already requires of remote adapters.
5. **Runtime conventions follow agent-bot.** Node, zero npm dependencies at
   runtime, JSON documents written atomically and JSONL append logs, and local
   sockets only. No network listener exists except an A2A endpoint the owner
   opens. A different store needs its own ADR with a measured reason.
6. **The CLI is thin and structured.** It validates input, calls the broker or
   daemon, and prints versioned JSON on stdout with diagnostics on stderr,
   stable error codes, and a nonzero exit on failure. A stopped broker is an
   error, never an apparent successful send.
7. **The CLI ships its skill per ENG-0055 and ENG-0064.** Guidance is read
   through `agent-comms skill`, `skill list`, and `skill show <feature>`, with
   features `messaging`, `tasks`, `routes`, and `diagnostics`. Nothing is
   installed into a harness. An optional `decide` command family follows
   [ENG-0065](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0065-cli-bounded-runtime-decisions.md);
   every messaging operation works with all decision providers disabled.
8. **No permanent coordinator.** Any authorized soul may message any other
   authorized soul, lead one task, and contribute to another. Storage is
   central per machine; task leadership is not.
9. **Bootstrap first.** The first release is the broker and the CLI alone,
   with no daemon change. Hardening that needs the daemon, such as persisted
   bindings and wake dispatch, follows in agent-bot-identity.

## Consequences

- One identity and one authorization model per account. A principal allowed
  to message a soul through Telegram and a peer soul messaging it pass the
  same gate and write the same kind of receipt.
- Messaging ships without waiting for agent-bot-identity releases. Stronger
  identity and waking do wait for them.
- The broker is a single machine-wide point of failure for messaging. When it
  is down, sends fail loudly and nothing else in the daemon is affected.
- JSON stores set the scale ceiling. That fits one owner's
  fleet on one machine; a busier deployment would revisit decision 4.
- Harnesses that can run a CLI need nothing else. Harnesses that cannot,
  such as Cursor, reach the daemon through the reach-back MCP tools instead.

## Alternatives

- **A separate agent-comms hub per account:** rejected. It duplicates the
  daemon and splits identity, authorization, and audit.
- **Put all of agent-comms inside agent-bot-identity:** rejected for now. The
  broker and A2A gateway are separate services with their own release
  cadence.
- **Mailboxes in each account's daemon:** rejected. A logged-out account's
  daemon is not running, so the broker would have to hold its mail anyway,
  and two stores would need reconciling.
- **SQLite for the first store:** deferred. The daemon's existing stores
  already show atomic writes, locks, and crash recovery work at this scale.
