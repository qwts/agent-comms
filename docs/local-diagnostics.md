# Local broker and client diagnostics

The broker writes bounded JSON lines to stderr for startup and shutdown outcomes,
unexpected request-handler
errors, uncertain storage appends or compaction, and background maintenance
failures. The client records local custody/proof refusals, unreachable channels,
request deadlines and scheduled watch retries. CLI stdout and the durable
`events.jsonl` format are unchanged.
Expected permission and validation refusals keep their existing public error
codes and do not produce these internal-error records.

The private stderr format adopts a local subset of the proposed
[ENG-0085 profile](https://github.com/qwts/qwts-agent-sop/blob/fc470c9244ae8018d24df217a03ce29f9bdfcc0e/docs/reference/diagnostic-profile-v1.md).
The [proposal PR](https://github.com/qwts/qwts-agent-sop/pull/87) and
[exact merged-main CI](https://github.com/qwts/qwts-agent-sop/actions/runs/38190389433)
record the shared review baseline; joint cross-repository adoption remains open.
Each line contains `v: 1`, `component`, `buildVersion`, `buildSource`, a fixed
`event` name, locally generated `eventId` and `sessionId`, `operation`, `stage`,
stable `code`, `outcome` and `observedAtUnixMs`. Components are
`agent-comms-broker` and `agent-comms-client`. `buildVersion` comes from running
package metadata with `buildSource: running`; unavailable or invalid metadata
produces null with `buildSource: unknown`. Optional `durationMs` measures a
local stage using a monotonic clock, rounded down; absent means unmeasured.

An event ID identifies one observation; the random session ID joins observations
in one process lifetime. Neither identifies a message, soul, installation or
cross-process operation or grants authority. This slice emits no context or
links and does not accept peer diagnostic IDs. No Error objects, causes, stacks,
request fields, arbitrary messages, paths, bodies or credentials are serialized.

| Event | Operation | Stage | Code | Outcome |
| --- | --- | --- | --- | --- |
| `broker.request-failure` | `broker.request` | `handler` | `internal` | `failed` |
| `broker.storage-failure` | `broker.storage` | `append` or `compact` | `storage-failed` | `recovery-required` |
| `broker.maintenance-failure` | `broker.maintenance` | `maintenance` | `internal` | `failed` |
| `broker.maintenance-storage` | `broker.maintenance` | `maintenance` | `storage-failed` | `recovery-required` |
| `broker.traceparent-dropped` | `broker.launch` | `propagation` | `traceparent_dropped` | `dropped` |
| `transport.unreachable` | `transport.connect` | `connect` | `broker-unreachable` | `failed` |
| `transport.timeout` | `transport.request` | `deadline` | `broker-timeout` | `failed` |
| `transport.untrusted` | `transport.connect` | `custody` or `proof` | `broker-untrusted` | `refused` |
| `transport.retry` | `transport.watch` | `backoff` | `retry-scheduled` | `succeeded` |
| `diagnostics.dropped` | `diagnostics` | `queue` | `diagnostics-dropped` | `dropped` |

[Lifecycle diagnostics](lifecycle-diagnostics.md) extend this private registry
with broker startup/shutdown and watch readiness/reconnection outcomes.

`transport.retry` has exact `details: { attempt, delayMs }`. Attempt counts
scheduled retries since the last ready event and saturates at
`Number.MAX_SAFE_INTEGER`; delay is the existing 250–10000 ms backoff.
Its outcome confirms scheduling only, not reconnection, delivery or task
completion. Retry observations omit duration because the wait has not occurred.
Client deadlines and lost channels measure elapsed local time to detection;
they do not measure broker work. Remote reply error codes never create local
transport-failure observations, and explicit cancellation is not a failure.

`broker.traceparent-dropped` has exact
`details: { traceparentDroppedCount }`: a cumulative local counter per broker
instance, saturated at `Number.MAX_SAFE_INTEGER`, for malformed optional launch
context after ordinary principal authentication, target validation and grant
checks. It never contains the supplied value, trace/span IDs, baggage or
tracestate. Reports use the existing finite queue/rate/failure bounds; a lost
report is not a launch failure and later counts can include earlier losses.
The count is local diagnostic state, never a durable audit record or public
status field. Valid trace context does not create diagnostic links.

A `storage-failed` result still requires stopping the broker, correcting the
storage problem and restarting to recover before retrying. Diagnostics are
best-effort observations. Mailbox state, acknowledgment, task completion and
security receipts remain authoritative through their existing interfaces.

## Resource and failure limits

Broker and client in one process share a pending queue of at most 64 records
and 32 KiB, plus one
in-flight record. Each complete line is at most 512 UTF-8 bytes. Reporting
enqueues bounded data and defers the stream write outside the request handler.
The production sink starts at most one isolated helper process on its first
write, with one record in its private IPC channel. That helper writes fd 2
asynchronously, handles partial progress and acknowledges only a complete line.
It inherits no account credentials or Node preload configuration, writes no
stdout, and has no broker authority. A stalled stderr destination cannot block
the broker event loop. Injected stream sinks must both complete their write
callback and drain before another record is written.
New observations are dropped when the queue is full. A monotonic token bucket
also limits records to 100 per second with burst 64. After progress resumes,
`diagnostics.dropped` reports exact `details: { droppedCount }`, saturated at
`Number.MAX_SAFE_INTEGER`, at most once per second across the process. Two fixed
component counters keep broker and client drops distinct; rotating summaries
report the component whose observations were dropped, including pending records
discarded after a writer failure.
Summaries do not recursively enter the queue or consume event-rate tokens;
their own interval and single in-flight bound apply. Timers are unreferenced.

A throwing, closed or errored sink disables that diagnostic sink and discards
its pending work. It does not end or destroy stderr, retry indefinitely, or
change the real request result, authorization, delivery or storage recovery.
A permanently blocked or failed stderr cannot carry its own drop report.
Diagnostics do not keep the process alive or delay broker shutdown, so pending
observations can be lost on exit. The helper and its parent IPC handles are
unreferenced; parent exit kills the helper, and IPC disconnection also makes the
helper exit. A failed helper is not restarted. The helper is an ephemeral local
diagnostic writer, not a second account service or identity store.

The broker adds no diagnostic files, retention policy, rotation, network
listener or exporter. A supervisor may capture stderr under its own existing
policy. This local event format is a private partial implementation of
[#164](https://github.com/qwts/agent-comms/issues/164), under accepted
[ADR-0007](decisions/ADR-0007-observability-and-geniusbar.md) and
[ADR-0002](decisions/ADR-0002-messaging-plane-on-the-agent-bot-daemon.md).
Shared trace propagation, broader lifecycle metrics, health extensions,
inspection, optional reporting and cross-repository contracts remain open work.
The profile and client custody tests run in the native Windows lane; existing
portable helper lifecycle tests retain Windows natural-exit evidence. Real
socket/client canary and unread-stderr delivery fixtures run on POSIX. This
slice does not claim packaged host integration or complete numeric acceptance.
[Local paired evidence](local-diagnostics-performance.md) records independently
passing reporting/helper comparisons, a retained healthy p99 failure, exact
provenance and baseline limitations. [Complete-runtime evidence](local-diagnostics-total-overhead.md) records the
scoped macOS embedded Broker/client comparison against a pre-change runtime,
including healthy, failed and unread diagnostic destinations. CPU remains
ungated and sparse appends do not establish compaction performance. Native Windows numeric budgets and packaged host integration remain outstanding in
[#164](https://github.com/qwts/agent-comms/issues/164).

## Private Windows connector stage

The Windows connector locally produces one optional fixed stage on connection
refusal: `host-clixml`, `host-stderr`, `pipe-refused`, `process-error`,
`premature-close` or `startup-timeout`. Generic client error wrapping preserves
only that own primitive data property as nonenumerable internal metadata.
One shared projector ignores unknown, inherited, accessor or nonprimitive
values; it never reads exception messages, causes or arbitrary properties.
Remote broker response fields are not projected into this metadata.

This does not change the public `broker-unreachable` code, error/wire JSON,
authentication, pin/proof validation, connection/request deadlines or retry
policy. It does not serialize PowerShell output, paths, commands or secrets,
and is not a new shared public event schema. A refused helper can now retain
its existing local stage through the connector, handshake and client wrapper
for separately reviewed internal evidence consumers. No underlying cause or
platform acceptance follows merely from a stage label.

The client preserves its first result or error before guarded stream disposal.
A synchronous disposal throw or later close/error cannot replace that outcome.
This is best-effort disposal, not confirmation that a stream, helper or descendant
has exited; owned-process acceptance tools still need their independent terminal,
stdio and job cleanup receipts.
