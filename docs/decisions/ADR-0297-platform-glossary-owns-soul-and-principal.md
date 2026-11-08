# ADR-0297: The platform glossary owns "Soul" and "principal"

**Status:** Proposed
**Date:** 2026-11-07
**Issue:** qwts/agent-comms#297

Amends the terms in
[ADR-0003](ADR-0003-agents-are-souls-humans-are-principals.md). Its
decisions are unchanged.

## Context

ADR-0003 defines a soul as one agent conversation (`agent_<uuid>`) and a
principal as a human or transport account in the agent-bot daemon.

The Soul Agent Platform now keeps one vocabulary for every component.
[true-line/agent-bot-platform](https://github.com/true-line/agent-bot-platform)
is the product's single source of truth (platform PDR-0001), and its
[glossary](https://github.com/true-line/agent-bot-platform/blob/main/docs/glossary.md)
defines a **Soul** as the smallest unit the network addresses, with one
stable ID across revisions, hosts and harnesses, and a **principal** as a
human or organization that can own or delegate authority, independent of
any agent. The platform records the conflict as
[DRIFT-009](https://github.com/true-line/agent-bot-platform/blob/main/docs/00-governance/drift-register.md#drift-009-soul-and-principal-mean-different-things),
and its resolution is that agent-comms records its older meaning as
superseded.

## Decision

1. **The platform glossary governs the words.** Where a document in this
   repository uses "Soul" or "principal" as a platform term, it carries the
   glossary's meaning. This repository defines neither term again.
2. **ADR-0003's meanings are superseded as definitions.** Its decisions
   stand as mechanism: connection-bound identity, explicit joining, nested
   subagents, account-qualified addresses, authorized discovery and
   fail-closed sandboxes.
3. **Identifiers and interfaces do not change.** `agent_<uuid>` and
   `principal_<uuid>`, CLI verbs, request fields, error codes and stored
   state keep their names. Renaming them would break installed v0.5.5
   clients and host apps. Existing documents that say "soul" for an
   `agent_<uuid>` conversation identity use ADR-0003's older sense.
4. **The mapping stays unspecified.** Which platform term an `agent_<uuid>`
   conversation identity corresponds to (Soul, member, runtime or session)
   is not decided here. Choosing it binds more than this repository, so it
   goes to the platform's
   [Decisions](https://github.com/true-line/agent-bot-platform/discussions/categories/decisions)
   category.

## Consequences

- No reader needs two glossaries: platform terms resolve on the platform.
- This repository's documents still use "soul" for `agent_<uuid>` until the
  mapping is decided. That is a known and recorded inconsistency, not a
  second definition.
- Renaming identifiers, if the mapping ever calls for it, needs its own
  migration and compatibility plan.

## Alternatives

- **Rewrite every document to the platform meaning now:** rejected. Without
  a decided mapping, the rewrite would invent one.
- **Rename identifiers and CLI verbs:** rejected. It breaks installs, which
  platform PDR-0002 forbids for adoption work.
