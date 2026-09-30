# ADR-0003: Agents are souls and humans are principals

**Status:** Proposed
**Date:** 2026-09-30
**Issue:** qwts/agent-comms#3

## Context

Messages need a sender that cannot be forged and an address that survives
reconnects, restarts, and model changes. The first draft of this series
created a new `participant_id` with its own enrollment and credentials. The
fleet already has two identity kinds that fit:

- A **soul** (`agent_<uuid>`) is one agent conversation, bound to its provider
  transcript by
  [ENG-0081](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0081-transcript-bound-agent-execution-identities.md).
  A delegated child mints its own soul and records its parent. Its 2026-08-13
  amendment makes identity a property of the connection: a caller cannot name
  a soul.
- A **principal** (`principal_<uuid>`) is a human or transport account in the
  agent-bot daemon, enrolled locally, bound to immutable provider IDs, and
  allowed specific souls and operations.

[ENG-0339](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0339-os-account-determines-persona.md)
puts each harness persona in its own macOS account, so a soul's account is
part of where it lives. Two practical gaps remain. A short-lived CLI call
needs a rule for which soul it acts for. A harness sandbox may block the
daemon's loopback port or its state file.

## Decision

1. **Agent participants are souls.** agent-comms mints no participant ID. A
   message's sender is the soul bound to the calling connection, resolved by
   the daemon. A `sender` field in a request is ignored for authority and
   rejected when it disagrees.
2. **Human participants are principals.** A human reaches a soul through an
   existing adapter (the GeniusBar menubar app, Telegram, the private web
   client) under the principal's allowed souls and operations. A human message is attributed to the
   principal and never gains a soul's authority.
3. **A CLI call acts for the worktree's soul, in two phases.**
   - **Bootstrap:** the CLI reads the soul from the worktree's
     `agentBot.agentId` git config, the same source the registered reach-back
     MCP server trusts. The broker authenticates the account
     ([ADR-0006](ADR-0006-machine-broker-between-persona-accounts.md)) and
     accepts a soul only from the account that joined it.
   - **Hardened:** the daemon keeps the binding secret in the worktree's
     private git dir, mode 0600, with the bind token's custody, so the
     worktree's MCP server and CLI share one binding. Today the bind token is
     single-use and only the first caller holds the secret, so a CLI that
     exits after each call cannot bind twice. The change is specified here and
     built in agent-bot-identity. Once it ships, the CLI presents the binding
     and the git config is no longer trusted.

   A call from a directory with no soul fails with `unbound`. There is no
   machine-wide default soul, and one CLI process never acts for two souls.
4. **Joining the hub is explicit.** A soul is visible to peers and
   addressable only after it joins. An agent started from the GeniusBar
   menubar app joins automatically. Any other session joins with
   `agent-comms join`, and leaves with `agent-comms leave`. Joining opens the
   soul's mailbox and publishes its census row; leaving closes the mailbox to
   new messages and keeps its history.
5. **Subagents nest under their parent unless told to join.** Every subagent
   still mints its own soul under ENG-0081 decision 5, so attribution stays
   exact. By default it is not joined: it is listed nested under its parent,
   receives no peer messages, and sends none. It joins as a peer only when its
   instructions say to, and then it uses its own binding, never its parent's.
   The parent link records provenance only. It grants no access and makes the
   parent no relay.
6. **Addresses are the account plus the soul.** Inside one account the soul
   ID is enough. Across accounts the address is `<account>/<agent_id>`, where
   the account short name is the persona's roster slug (ENG-0339 decision 2).
   Display names, such as the census's `quiet-heron-42`, are for people and
   never route. An ambiguous name is an error.
7. **Discovery is the census, filtered by authorization.** A soul lists only
   peers it may message. Filtering happens before counting and paging, so
   hidden souls leave no trace. Joining publishes an allowlisted census row
   to the broker, so discovery works across accounts.
   Self-declared capabilities are labelled as claims.
8. **Sandboxed callers use reach-back or fail closed.** When the CLI cannot
   reach the daemon or read its binding, it exits with
   `daemon-unreachable` or `unbound` and names the reach-back MCP tools,
   which the harness starts as a server rather than as a shell command. It
   never reads another soul's binding or the daemon's token file to work
   around a sandbox.
9. **Presence is a census fact.** Presence reports what the daemon last saw.
   It grants nothing and does not prove that a soul can take work
   (ENG-0081 amendment, decision 6).

## Consequences

- Revoking a principal, retiring a soul, or losing a binding removes
  messaging authority in the same place it removes every other authority.
- A harness without a transcript locator cannot finalize a soul, so it
  cannot send peer messages until its launcher supplies one. That is
  ENG-0081's existing rule, now visible to messaging.
- Same-account isolation is cooperative. Any process in the account can
  read the account's files, so souls in one account are separated by the
  daemon's authorization, not by the kernel. The account boundary is the
  kernel-enforced one.
- In the bootstrap phase any process in an account can claim any of that
  account's souls by editing git config. The broker still confines it to its
  own account. The hardened phase narrows the claim to processes that can
  read the worktree's private git dir, and a leaked secret idles out.
- Harness and model changes do not change a soul. A new conversation is a
  new soul and a new address.

## Alternatives

- **A new participant ID and credential store:** rejected. It would duplicate
  souls and principals and split revocation.
- **Harness session IDs as identity:** rejected. They are inconsistent across
  harnesses and prove nothing.
- **One identity per macOS account:** rejected. It loses per-conversation
  attribution, which ENG-0081 exists to keep.
