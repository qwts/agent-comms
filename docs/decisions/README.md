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
| [ADR-0008](ADR-0008-daemon-vouching-and-the-wake-plane.md) | The daemon vouches for souls and carries their wakes | Accepted |
| [ADR-0059](ADR-0059-host-apps-embed-agent-comms.md) | Host apps embed agent-comms through a contract and platform seams | Proposed |
