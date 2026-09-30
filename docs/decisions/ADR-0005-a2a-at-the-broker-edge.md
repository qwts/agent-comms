# ADR-0005: A2A at the broker edge, and tasks that link to invocations

**Status:** Proposed
**Date:** 2026-09-30
**Issue:** qwts/agent-comms#5

## Context

Agents hand each other work, and some of that work goes to, or comes from,
agent systems outside the fleet. A2A distinguishes a message response from a
stateful task. A task can pause for input and ends in a terminal state; a
context groups related interactions
([Life of a Task](https://a2a-protocol.org/v1.0.1/topics/life-of-a-task/)).
The [A2A specification](https://a2a-protocol.org/v1.0.1/specification/) 1.0.1
negotiates protocol versions on major and minor, lets the server assign task
IDs, and makes `SendMessage` idempotency optional.

The first draft of this series put an A2A gateway on a per-user hub. That hub
is now the agent-bot daemon ([ADR-0002](ADR-0002-messaging-plane-on-the-agent-bot-daemon.md)),
which runs work as invocations: one message, one harness turn, with ordered
events and cooperative cancellation.

## Decision

1. **The A2A gateway runs in the broker.** External agents reach souls in any
   account through the broker's authorization
   ([ADR-0006](ADR-0006-machine-broker-between-persona-accounts.md)), not
   through a gateway per account. Outbound routes name configured external
   agents. An inbound listener exposes only capabilities the owner selects,
   and opening one beyond loopback is a separate deployment decision.
2. **Protocol 1.0, and only standard bindings.** The gateway implements the
   1.0.1 specification and negotiates version 1.0. The CLI and daemon
   contracts are application APIs, not an A2A binding, and are never
   described as one.
3. **A task is an agent-comms record.** It holds the assignee (account and
   soul), parent and dependency links, acceptance criteria, and the
   result-review state. Local states are `offered`, `accepted`, `working`,
   `input-required`, and the terminal `completed`, `failed`, `rejected`, and
   `canceled`. An offer assigns nothing until the assignee accepts. Every
   transition is authenticated, names the record revision it expects, and
   appends a task event to the task's message stream
   ([ADR-0004](ADR-0004-durable-mailbox-and-waking.md)).
4. **Work on a task runs as daemon invocations linked to it.** When the
   assignee works, each turn is an invocation in its own account's daemon
   that references the `task_id`. Invocation states are execution facts; the
   task state is the assignee's claim about the work. A completed invocation
   never completes a task by itself.
5. **Terminal tasks stay terminal.** Refining or retrying finished work
   creates a new task linked to the earlier one.
6. **Remote tasks keep their namespace.** A remote task reference stores the
   authenticated server, the tenant when there is one, the route, and the
   server-assigned task and context IDs, which are opaque. A bare remote ID
   never identifies work. The local `task_id` is separate, and remote states
   map explicitly while the original state is kept.
7. **Content keeps its shape or fails visibly.** Text, structured data, and
   artifact references keep their media types and access limits. An
   unsupported part or required extension is a compatibility error, never
   silent loss. `input-required` and `auth-required` pass through; an auth
   request goes to the credential workflow, and message text grants no
   permission.
8. **Transport retry is not new work.** The gateway persists each outbound
   request before sending it. Retrying transport repeats the same logical
   request. A timeout after submission is an uncertain outcome until
   reconciliation shows what happened; the gateway never resubmits a
   non-idempotent send blindly. Cancellation is best effort, and a closed
   stream does not cancel a task.
9. **Orchestration belongs to the souls.** Any soul may offer, accept, or
   delegate within its permissions. No soul is a mandatory supervisor, and a
   related-task reference sent remotely carries context, not ownership.

## Consequences

- External agents see one endpoint for the machine, governed by the same
  authorization as local peers.
- Mapping code, conformance fixtures, and server-scoped identity records are
  new work, and ambiguous sends need a visible uncertain state.
- Task state depends on assignees reporting it. A crashed turn leaves the
  task `working` until its owner or a timeout policy moves it.

## Alternatives

- **A2A in every harness:** rejected. It multiplies integration work.
- **A gateway per account:** rejected. External agents would need to know the
  fleet's account layout.
- **Treat invocations as tasks:** rejected. One task spans many turns, and a
  turn ending says nothing about whether the work is done.
