# ADR-0007: GeniusBar shows the hub, and runtime metrics stay optional

**Status:** Proposed
**Date:** 2026-09-30
**Issue:** qwts/agent-comms#7

## Context

GeniusBar is a planned macOS menubar app. Like the Fast User Switching menu,
it lists everyone on the machine, but its list is every agent that has joined
the hub, across accounts. Each agent appears as a Dudle, a round cartoon
character. Clicking one opens a chat with that agent, among other actions. An
agent started from GeniusBar joins the hub automatically.

The proof of concept also showed each agent's model, context size, and cached
input, read incrementally from harness logs. Harnesses report these
differently and at different times, and the numbers are easy to conflate.
The agent-bot daemon already has a per-account census and a private web
client; the broker holds the machine census
([ADR-0006](ADR-0006-machine-broker-between-persona-accounts.md)).

## Decision

1. **GeniusBar reads the broker.** It is a client in the owner's paired
   account. It lists joined souls from the broker's census, with each
   subagent that has not joined nested under its parent
   ([ADR-0003](ADR-0003-agents-are-souls-humans-are-principals.md)). The
   census row carries the account, soul, display name, harness, parent,
   presence, and mailbox and wake state.
2. **A Dudle is display only.** Its look is derived from the soul ID, the way
   the census derives display names, so it stays the same across restarts.
   It never routes, authenticates, or distinguishes two souls on its own.
3. **Clicking a Dudle opens a chat as the owner.** Messages go through the
   broker, attributed to the owner's human principal. Other actions, such as
   starting an agent or approving a proposal, go through the same
   authorization as the CLI or the daemon. GeniusBar holds no authority of
   its own.
4. **Launching from GeniusBar joins the agent.** GeniusBar starts the harness
   in its persona account and has the session run `agent-comms join`. A
   harness started any other way joins only when told to.
5. **Runtime metrics come from optional, read-only collectors.** Messaging
   works with every collector absent, stopped, or failing. A collector binds
   an observation to a soul through the worktree's soul ID and the harness
   session it recorded, never by matching names, paths, or model strings. An
   observation it cannot bind stays unassigned. A collector never joins,
   registers, or authorizes anything.
6. **Every measurement says what it is.** An observation records the metric,
   the value or `unknown`, the unit, whether it covers one call or a session,
   the source, whether it was reported, configured, or estimated, and when it
   was observed. The metrics are distinct:
   - `model_reported`: the model a call or session reported; never identity;
   - `context_capacity_tokens`: the documented maximum for that exact model
     and configuration;
   - `context_used_tokens`: tokens in a stated context snapshot, with method;
   - `input_tokens`, `output_tokens`: usage for one call;
   - `cached_input_tokens`: input served from cache for one call;
   - `cache_write_tokens`: tokens written to cache, never shown as cached
     input.

   Missing is `unknown`, not zero. Cached input is not subtracted from
   context used. Per-call input is never summed into live context. A
   utilization percentage appears only when capacity and usage share model,
   configuration, scope, and time, and GeniusBar shows both numbers.
7. **Collectors read incrementally and cheaply.** They keep a checkpoint per
   source, survive rotation, truncation, partial and duplicate records, and
   never move a checkpoint past input they did not handle. Bytes read, CPU,
   polling rate, and retained volume are bounded.
8. **Collect the least.** Collectors keep allowlisted fields only. They do
   not ingest transcripts, index home directories, or keep raw log lines.
   Secrets and sensitive paths are redacted before storage. Metrics never
   leave the machine without an explicit route and disclosure decision.
9. **Health is separate from presence.** GeniusBar also shows broker health,
   mailbox depth, wake outcomes, and collector errors. Presence, delivery,
   receipt, task acceptance, and task completion stay distinct signals, and a
   recent metric never proves an agent can take work.

## Consequences

- One place shows every agent on the machine, and the owner can reach any of
  them with a click.
- GeniusBar is a native app in its own repository. This series defines the
  broker contract it reads; it does not decide the app's design.
- Collector coverage will be partial and parsers need upkeep as harness log
  formats change.

## Alternatives

- **A new hub web page:** rejected. GeniusBar covers the machine, and the
  daemon's web client already covers one account.
- **Required collectors:** rejected. They would tie messaging to fragile log
  formats.
- **Transcript ingestion for richer debugging:** rejected by default. The
  privacy and retention cost is too high.
