# Private lifecycle diagnostics

Related to [#164](https://github.com/qwts/agent-comms/issues/164).
These broker and client observations extend the private
[local diagnostic registry](local-diagnostics.md) using its unchanged per-process
queue, rate, record-size and writer failure limits. They add no runtime dependency,
exporter, host field, inspection route or diagnostic network traffic.

| Event | Operation | Stage | Code | Outcome |
| --- | --- | --- | --- | --- |
| `broker.started` | `broker.lifecycle` | `startup` | `ready` | `succeeded` |
| `broker.start-failed` | `broker.lifecycle` | `startup` | `startup-failed` | `failed` |
| `broker.stopped` | `broker.lifecycle` | `shutdown` | `stopped` | `succeeded` |
| `broker.stop-failed` | `broker.lifecycle` | `shutdown` | `shutdown-failed` | `failed` |
| `transport.ready` | `transport.watch` | `ready` | `ready` | `succeeded` |
| `transport.reconnected` | `transport.watch` | `reconnect` | `ready` | `succeeded` |

Lifecycle observations use fixed private tuples, not new public error codes.
`broker.started` follows completed broker startup, including listeners and
outbound services. `broker.start-failed` covers a thrown startup outcome,
including preparation or replay failure, without recording the error. Cleanup
of a failed startup and repeated stops do not produce normal shutdown records.
`broker.stopped` follows completion of the existing stop operations; it does not
prove host, harness or diagnostic-helper exit. `broker.stop-failed` records a
thrown stop outcome. Startup and shutdown durations measure the complete local
method invocation. Existing cleanup and error behavior remain authoritative.

Watch `transport.ready` follows the first broker `ready` event after the
existing custody/proof and request authentication path. `transport.reconnected`
follows the first `ready` after a previously ready watch loses its channel.
Repeated ready events within one connection add no completion records. Initial
readiness duration covers the watch invocation through first ready, including
any initial retries. Reconnection duration covers local disconnect detection
through ready, including backoff and failed attempts. Socket connection alone
is insufficient. These observations prove watch readiness only, not agent
presence, message delivery, acknowledgment or task completion. Cancellation
and broker permission refusals add no successful readiness observation.

The established broker lifecycle is tracked only in private process memory.
Concurrent stops can complete their existing cleanup independently but emit at
most one successful shutdown observation for that lifecycle. A failed stop can
be retried. No lifecycle observation enters the durable message log or changes
canonical presence, delivery, task or security receipts.

Focused fixtures cover early preparation/replay failure, normal/failed/repeated
and overlapping stop, real authenticated watch readiness after broker restart,
refusal, repeated ready suppression and cancellation. Blocked and throwing
sinks retain real operation outcomes, and existing secret-canary projection
and queue bounds apply to the new fixed tuples.

These are source fixtures, not packaged-host or native Windows numeric
acceptance. Existing [performance records](local-diagnostics-total-overhead.md)
predate the new lifecycle producers and do not establish their overhead.
Paired producer workload measurements and platform acceptance remain open.
