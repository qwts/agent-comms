# Local broker failure diagnostics

The broker writes bounded JSON lines to stderr for unexpected request-handler
errors, uncertain storage appends or compaction, and background maintenance
failures. CLI stdout and the durable `events.jsonl` format are unchanged.
Expected permission and validation refusals keep their existing public error
codes and do not produce these internal-error records.

Each line contains only `component`, `buildVersion`, a fixed `event` name,
a locally generated `eventId`, `stage`, stable `code`, and `outcome`.
`buildVersion` comes from packaged metadata, or is `unknown` when that metadata
is unavailable. The diagnostic event ID identifies this observation only; it
does not identify a message, soul, or cross-process operation and grants no
authority. No Error objects, causes, stacks, request fields, arbitrary messages,
paths, bodies, or credentials are serialized.

| Event | Stage | Code | Outcome |
| --- | --- | --- | --- |
| `request-internal` | `request` | `internal` | `failed` |
| `storage-append` | `append` | `storage-failed` | `recovery-required` |
| `storage-compact` | `compact` | `storage-failed` | `recovery-required` |
| `maintenance-internal` | `maintenance` | `internal` | `failed` |
| `maintenance-storage` | `maintenance` | `storage-failed` | `recovery-required` |
| `diagnostics-dropped` | `diagnostics` | `diagnostics-dropped` | `dropped` |

A `storage-failed` result still requires stopping the broker, correcting the
storage problem and restarting to recover before retrying. Diagnostics are
best-effort observations. Mailbox state, acknowledgment, task completion and
security receipts remain authoritative through their existing interfaces.

## Resource and failure limits

One process shares a pending queue of at most 64 records and 32 KiB, plus one
in-flight record. Each complete line is at most 512 UTF-8 bytes. Reporting
enqueues bounded data and defers the stream write outside the request handler.
The production sink starts at most one isolated helper process on its first
write, with one record in its private IPC channel. That helper writes fd 2
asynchronously, handles partial progress and acknowledges only a complete line.
It inherits no account credentials or Node preload configuration, writes no
stdout, and has no broker authority. A stalled stderr destination cannot block
the broker event loop. Injected stream sinks must both complete their write
callback and drain before another record is written.
New observations are dropped when the queue is full. After the stream recovers,
`diagnostics-dropped` reports a cumulative `droppedCount`, saturated at
`Number.MAX_SAFE_INTEGER`.

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
policy. This local event format is a private first slice of
[#164](https://github.com/qwts/agent-comms/issues/164), under accepted
[ADR-0007](decisions/ADR-0007-observability-and-geniusbar.md) and
[ADR-0002](decisions/ADR-0002-messaging-plane-on-the-agent-bot-daemon.md).
Shared trace propagation, lifecycle metrics, health extensions, inspection,
optional reporting and cross-repository contracts remain open work.
