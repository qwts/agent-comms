# ADR-0028: Broker federation through explicitly enrolled remote hubs

**Status:** Proposed
**Date:** 2026-10-11
**Issue:** qwts/agent-comms#28

This proposes the policy for outbound machine tunnels (#118) and multiple
remote hubs (#119). It authorizes no runtime, deployment, spending or release.
Owner acceptance and repository review are pending. The supporting
[federation contract](../federation-contract-proposal.md) defines proposed
custody, finite defaults, receipts and acceptance evidence.

## Context

[ADR-0006 decision 11](ADR-0006-machine-broker-between-persona-accounts.md#decision)
defers cross-machine routing and anticipates an outbound hosted hub. Its local
account and mailbox authority must survive federation. Existing A2A routes
provide scoped configuration and durable-outbox patterns, not transparent
broker federation: inbound A2A callers are principals and ambiguous outbound
sends remain uncertain under [ADR-0005](ADR-0005-a2a-at-the-broker-edge.md).
The owner's #28 production sequencing remains a release gate; this proposal
does not reopen completed GeniusBar #41 or agent-bot #332/#45 work.

## Proposed decision

1. **Private relay, local authority.** Recommend an owner-operated, single-tenant
   reference hub at `unforgiven.ai`, with a documented self-hostable protocol.
   Brokers initiate TLS WebSocket connections; no local inbound listener opens.
   Recommend Cloudflare Workers with Durable Objects as the first implementation
   candidate, subject to acceptance of custody, operating budget and a measured
   persistence/cost review. No provider account or remote hub is required locally.
   The relay stores bounded encrypted envelopes and routing metadata, never
   population registries, transcript locators, spaces, credentials or execution
   state. This is messaging custody, not the personal remote population server
   excluded by agent-bot #35/#45. Any changed org-wide custody/identity policy
   needs an ENG record before implementation.
2. **Explicit trust and export.** Owners approve each relay identity and peer
   broker key, then explicit per-hub soul exports, imports and operations.
   Keys, credentials and discovery are isolated per hub. Peer claims cannot
   enroll souls or widen local grants. Payloads require authenticated encryption
   between approved brokers; the relay can delay, drop and observe metadata but
   cannot forge a verified sender or read content. Existing local daemon vouching,
   receive rules, principal boundaries and wake consent remain authoritative.
3. **Multiple connections without bridging.** A soul may use several approved
   hubs or none. No automatic cross-hub relay, credential reuse, peer-to-peer
   fallback or inbound daemon exposure is allowed. Persistent broker-origin IDs
   differ from relay-service IDs. Preserve #120's opaque origin/channel IDs;
   transport route context is additional, not a renamed channel identity.
4. **Durable admission, bounded lifetime.** Local send success records a durable
   outbox entry, not remote receipt. Relay custody, destination mailbox commitment,
   owner acknowledgement and work are distinct facts. Reconnection repeats the
   same authenticated logical envelope. #122's seven-day API-key guarantee does
   not limit transport deduplication: protected outcomes last through immutable
   thirty-day envelope expiry plus bounded clock skew. Capacity refuses admission;
   expiry/revocation yields explicit loss or uncertainty, never silent success.
   Inbox read/watch/ack stay at the owning broker; task offers retain one
   authoritative task record and wakes follow local durable delivery.
5. **Stage within the whole scope.** Deliver #118 direct/task traffic and #119
   isolated hub configuration/census through CLI and library APIs, then host glue.
   Remote channel subscriptions are a separate amendment: #120's approved local
   all-or-none admission must not silently become a distributed transaction.
   Local named channels and their canonical addresses remain compatible.

## Consequences and owner choices

Accept the deployment/custody recommendation, peer enrollment model,
multihoming/no-bridge rule and finite offline budget together or request concrete
changes before runtime work. Encryption and approved peer keys add setup and
rotation costs; metadata remains visible to the operator. Long protected
deduplication consumes finite capacity and may refuse traffic during outages.
No availability, global ordering, exactly-once execution or remote owner-presence
guarantee follows from this decision. Accepted ADR text remains unchanged; on
acceptance this record supersedes only ADR-0006's cross-machine exclusion and
extends its address boundary, preserving the remaining local contract.
