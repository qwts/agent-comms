# Architecture decisions (ADR series)

Durable records for decisions owned by this repository. A decision that
changes more than this repository is an ENG record in
[qwts-agent-sop](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/README.md),
and the ADR that depends on it links to it.

## Numbering

`ADR-NNNN`, zero-padded, taken from the originating issue number in this
repository, as ENG records do
([ENG-0035](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0035-issue-derived-record-numbers.md)).
Numbers are therefore sparse.

## Format

Short: context, the decision, and consequences, including the ones you did
not like. Each record starts with `**Status:**`, `**Date:**`, and
`**Issue:**` fields. Status is one of `Proposed`, `Accepted`, or
`Superseded by ADR-NNNN`. Records are never rewritten after acceptance;
supersede them instead.

## Index

| ID | Title | Status |
| --- | --- | --- |
| [ADR-0002](ADR-0002-messaging-plane-on-the-agent-bot-daemon.md) | agent-comms is a messaging plane on the agent-bot daemon | Accepted |
| [ADR-0003](ADR-0003-agents-are-souls-humans-are-principals.md) | Agents are souls and humans are principals | Accepted |
| [ADR-0004](ADR-0004-durable-mailbox-and-waking.md) | Durable mailbox delivery, and waking through the daemon planes | Accepted |
| [ADR-0005](ADR-0005-a2a-at-the-broker-edge.md) | A2A at the broker edge, and tasks that link to invocations | Accepted |
| [ADR-0006](ADR-0006-machine-broker-between-persona-accounts.md) | A machine broker routes between persona accounts | Accepted |
| [ADR-0007](ADR-0007-observability-and-geniusbar.md) | GeniusBar shows the hub, and runtime metrics stay optional; amended 2026-10-01: any principal client | Accepted |
| [ADR-0008](ADR-0008-daemon-vouching-and-the-wake-plane.md) | The daemon vouches for souls and carries their wakes; amended 2026-11-05: single-account daemon approval | Accepted |
| [ADR-0028](ADR-0028-cross-machine-hubs-and-federation.md) | Broker federation through explicitly enrolled remote hubs | Accepted |
| [ADR-0059](ADR-0059-host-apps-embed-agent-comms.md) | Host apps embed agent-comms through a contract and platform seams | Accepted |
| [ADR-0077](ADR-0077-owner-decisions-through-the-broker.md) | Grant-scoped owner decisions through the broker | Accepted |
| [ADR-0276](ADR-0276-soul-tokens-signed-by-the-identity-service.md) | The broker accepts service-signed soul tokens | Accepted |
| [ADR-0297](ADR-0297-platform-glossary-owns-soul-and-principal.md) | The platform glossary owns "Soul" and "principal"; amends ADR-0003's terms | Proposed |
| [ADR-0300](ADR-0300-contract-codecs-for-task-v1-and-wire-v1.md) | Contract codecs for task/v1 and wire/v1, checked against pinned soul-contracts fixtures | Proposed |
| [ADR-0306](ADR-0306-broker-mode-as-an-hq-plugin.md) | Broker mode as an HQ plugin, on a vendored agent-bot-hq SDK | Proposed |
| [ADR-0309](ADR-0309-daemon-identity-for-soul-token-v2-pairings.md) | A soul-token v2 pairing identifies its daemon by issuer and device; amends ADR-0276 and ADR-0077 | Proposed |
