# ADR-0006: A machine broker routes between persona accounts

**Status:** Proposed
**Date:** 2026-09-30
**Issue:** qwts/agent-comms#6

## Context

[ENG-0339](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0339-os-account-determines-persona.md)
runs each harness persona in its own macOS account, so most agent-to-agent
traffic crosses accounts. The agent-bot daemon is per account, and its
per-start bearer token in a 0600 file exists to keep other accounts out. A
per-user LaunchAgent stops when its account logs out. ENG-0339 decision 7 puts
machine-scoped state in `/Users/Shared/Public` and expects coordination to
graduate to a broker; decision 9 grants no ACLs between accounts.

The first draft of this series routed between per-user hubs through Slack or
Telegram machine tunnels. On one machine those add disclosure, loop, and size
risks for no reachability gain. The fleet-level rule is proposed in
[qwts/qwts-agent-sop#71](https://github.com/qwts/qwts-agent-sop/issues/71);
this record is the repository side of it.

## Decision

1. **One broker per machine, installed by the owner.** It listens on a Unix
   socket in `/Users/Shared/Public/agent-comms/`. The directory belongs to a
   group the owner creates for the agent accounts and the owner, with mode
   0770, so accounts outside the group cannot connect. The broker keeps its
   store in its own private state directory, never in the shared space.
2. **It starts in the owner's account, then moves to a service account.** The
   bootstrap release runs the broker as a LaunchAgent in the owner's account,
   which fast user switching keeps logged in. The target is a LaunchDaemon
   running as a dedicated account, so the broker also survives the owner
   logging out. The socket path and protocol do not change between the two.
3. **The broker authenticates accounts.** Each account pairs once:
   `agent-comms account pair`, run in that account, creates a credential in
   its home with mode 0600 and shows a short code. The owner approves the code
   with `agent-comms broker approve` or in GeniusBar. The broker stores only a
   hash bound to the account's short name. No account writes into another's
   home, and revoking a pairing cuts the account off at once. The account's
   CLI, and later its daemon for wake dispatch, connect to the broker with
   that credential; the broker never connects into an account.
4. **The account speaks only for its own souls.** The broker stamps each
   message with the authenticated account. A soul is accepted only from the
   account that joined it
   ([ADR-0003](ADR-0003-agents-are-souls-humans-are-principals.md)). A sender
   field naming another account is rejected.
5. **Addresses are `<account>/<agent_id>`.** The account short name is the
   persona's roster slug. Names and avatars are display only.
6. **The broker stores and forwards.** Mailboxes follow
   [ADR-0004](ADR-0004-durable-mailbox-and-waking.md). A message for a
   logged-out account waits in its recipient's mailbox until retention ends.
7. **The owner's chats cross accounts through the broker.** GeniusBar runs in
   the owner's account, which pairs like any other. A message it sends is
   attributed to the owner's human principal, not to a soul, and the
   recipient sees it as a human message. The recipient account's daemon still
   applies its principal rules before any turn runs on the owner's behalf.
8. **Loops are bounded.** Every message carries a reply depth, one more than
   the message it answers, and the broker rejects depths over a published
   limit. Per-sender and per-pair rate limits cap bursts. Replies to a
   message the sender wrote itself are rejected.
9. **Chat services are human gateways only.** Telegram and Slack reach one
   account's daemon through its principal adapters. They never carry machine
   traffic between accounts, and bot-to-bot modes stay off for fleet bots.
10. **Cross-machine routing is out of scope here.** Execution identities are
    workstation-local under ENG-0081, so joining machines needs its own
    decision. The expected direction is a hosted hub at `unforgiven.ai` that
    machine brokers connect to outbound, as the agent-bot GitHub webhook
    mailbox already does on a Cloudflare Worker. That decision must also
    revisit agent-bot-identity#35, which rules out a Firebase or personal
    remote population server. The broker keeps `<account>/<agent_id>`
    addresses so a machine qualifier can be added in front of them later.

## Consequences

- Agents in different persona accounts can message each other with no ACLs
  between accounts and no chat service in the path.
- The broker holds every account's messages, so its store is the most
  sensitive file on the machine after credentials. In the bootstrap phase the
  owner's account can read it; the service-account phase removes that.
- Pairing costs one owner action per account, repeated after a revocation.
- An account that is logged in but whose daemon is down still receives mail;
  it just cannot be woken.

## Alternatives

- **Peer UID checks on the socket:** preferred when available, since the
  kernel then names the account. Node has no built-in API for them, so they
  wait for a native helper; pairing covers the gap.
- **Daemons connecting to each other directly:** rejected. It needs ACLs or
  shared tokens between accounts, and fails when either side is logged out.
- **Slack or Telegram machine tunnels:** rejected on one machine. Revisit
  only with cross-machine routing.

## Open questions

- Which native component, GeniusBar or a helper, performs peer UID checks.
- Retention, reply-depth, and rate limits for the first release.
