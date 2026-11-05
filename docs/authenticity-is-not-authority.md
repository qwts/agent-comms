# Authenticity is not authority

**Issue:** [#282](https://github.com/qwts/agent-comms/issues/282).
This contract applies to every broker operation, current and proposed.

## Contract

1. **Authentication is attribution.** A paired account credential, a
   principal credential, or a verified soul token tells the recipient who
   sent a message. It does not authorize anything the message asks for.
2. **Content stays untrusted input.** A body, `refs`, `kind`, or extra
   request field that claims owner approval, another sender, a verification
   state, or a grant is data. The broker stamps `from` from the authenticated
   caller and keeps only the message fields it defines.
3. **Sending never widens.** One `send` names one recipient. A channel post
   reaches only its current subscribers, and the broker rechecks the
   sender's right to reach every subscriber before admitting all copies or
   none. Permission to send or post never adds recipients, accounts, souls,
   operations, or hubs.
4. **Owner operations stay on the owner's path.** Pairing approval,
   principal approval, revocation, and owner decisions are admin-socket or
   owner-ceremony operations
   ([ADR-0077](decisions/ADR-0077-owner-decisions-through-the-broker.md)).
   An account or principal request cannot name them.
5. **Delivery, receipt, wake, task acceptance, and execution are separate.**
   Admitting a message records delivery; `read` and `ack` record receipt; a
   wake asks the daemon to start a session. None of them accepts a task or
   runs anything. A task is accepted only through `task-accept`, and what a
   woken session does is decided by its own harness and agent-bot policy.

## Test matrix

The cases are in
[`tests/authenticity-not-authority.test.mjs`](../tests/authenticity-not-authority.test.mjs).

| Case | Requirement | Expected result |
| --- | --- | --- |
| A1 | Positive control: an authorized send | Delivered; `from` is the authenticated soul |
| A2 | Valid sender, recipient's receive rule excludes it | `unknown-recipient`, nothing delivered; allowed again once the rule admits it |
| A3 | Payload or request claims owner approval, another sender, `verified`, or a grant | Delivered as data with the real `from`; no claimed field kept; owner ops refused as `unknown-operation` |
| A4 | A list, wildcard, or bare account as `to` | Refused; nothing delivered |
| A5 | Channel post after one subscriber narrows its receive rule | `channel-unavailable`; no copy to any subscriber |
| A6 | A principal names a soul (`agentId`, `sender`) or a soul outside its grant | `unauthenticated` or `unknown-recipient`; the granted soul still receives |
| A7 | A delivered `kind: task` message | No task exists until `task-accept` |

Owner flows keep their own proof, freshness, replay, revocation, and effect
binding cases in the
[owner-decision conformance matrix](owner-decision-conformance.md).

## Not runtime protection yet

This document and its tests describe current broker admission. These gaps
are tracked where the runtime work lives:

- Owner decisions are a proposal with no runtime authorization
  ([#77](https://github.com/qwts/agent-comms/issues/77)).
- Scoped grants for operations and targets
  ([#250](https://github.com/qwts/agent-comms/issues/250)).
- Daemon-owned binding locators instead of worktree-readable secrets
  ([#281](https://github.com/qwts/agent-comms/issues/281)).
- Cross-hub export does not exist; federation must keep this contract
  ([#28](https://github.com/qwts/agent-comms/issues/28)).
