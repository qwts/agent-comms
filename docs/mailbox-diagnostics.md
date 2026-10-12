# Direct mailbox observations and queue age

Related to [#164](https://github.com/qwts/agent-comms/issues/164),
[local diagnostics](local-diagnostics.md) and
[mailbox retention](mailbox-retention.md).

## Authorized queue snapshot

Each existing principal census soul row adds `oldestUnackedAgeMs` beside
`unacked`. It is `null` when no retained unacknowledged message remains;
otherwise it is the nonnegative difference in milliseconds between the broker
snapshot clock and the oldest pending message's recorded admission time.
Acknowledged and expired messages do not contribute. It covers the soul's
whole mailbox, including retained channel and task-event copies; it is not a
channel-specific statistic or evidence of task execution.

Filtering by the principal grant happens before either count or age is built.
The query adds no machine-wide mailbox aggregate to health and exposes no
principal inbox through census. Existing authentication, grant, presence and
wake semantics are unchanged. Age and depth come from canonical retained
mailbox state, without a second queue, retention store or background sampler.
Each census uses one broker snapshot time for all visible rows. Age is floored
to whole milliseconds and saturates at `Number.MAX_SAFE_INTEGER`. The existing
request maintenance rejects an invalid broker clock before census runs;
canonical message timestamps are validated by admission and replay.

Age is a wall-clock observation, not a monotonic delivery deadline. The existing
broker maintenance clock floor applies after rollback; an admission timestamp
later than that clock yields zero age. Compaction and restart preserve admission
timestamps, so age survives restart and can include downtime. Normal retention
maintenance runs before the request: expired entries disappear from count and
age through the existing policy. Empty means `null`, never zero age.

## Private completion observations

Successful direct `send`, mailbox `read` and mailbox `ack` calls add fixed local
stderr records. Duration measures the local operation using a monotonic clock,
rounded down to integer milliseconds. It excludes prior broker maintenance and
response serialization or transport to the caller.

| Event | Operation | Stage | Code | Exact details |
| --- | --- | --- | --- | --- |
| `mailbox.admitted` | `mailbox.send` | `admission` | `admitted` | None |
| `mailbox.duplicate` | `mailbox.send` | `idempotency` | `duplicate` | None |
| `mailbox.read` | `mailbox.read` | `page` | `read` | `returnedCount`, `remainingCount` |
| `mailbox.acked` | `mailbox.ack` | `commit` | `acknowledged` | `acknowledgedCount`, `alreadyAcknowledgedCount` |

All four have component `agent-comms-broker` and outcome `succeeded`.
Counts are nonnegative safe integers; a hostile or invalid primitive measurement
is dropped. No request object, arbitrary error, peer identifier, body, key,
correlation value, path or trace context enters these records. Cardinality is
limited to these fixed tuples, with the existing 512-byte event, shared queue,
byte, rate and helper bounds. No public error codes or details are added.

Admission is observed after the existing durable commit, rate charging and
notification call complete. Socket notification remains best effort and does
not prove receipt. An idempotent duplicate returns the original admission
outcome and emits no second admission or wake. A read observes a successfully
constructed authorized page; it does not acknowledge its messages. Ack observes
a successful durable acknowledgment, with repeated IDs counted separately in
the existing reply. It proves mailbox receipt, not task acceptance or completion.
These observations do not cover channel-post or task-generated admission, gap
acknowledgment, or remote reply delivery. Read and ack retain their existing
whole-mailbox or requested page/filter semantics.

Expected validation, authentication and policy refusals preserve their public
error codes and create no successful completion record. In particular,
`unknown-recipient` still conceals recipient existence and receive policy.
Storage failures retain the existing recovery-required path and cannot emit a
successful admission or acknowledgment. A failing observer, full queue, stalled
helper or lost exit record cannot change canonical authorization, replies,
retention, deduplication or durable receipt state. Diagnostics remain sampled
observations and are not a second delivery history or security receipt.

Real socket tests cover queue age, oldest-message acknowledgment, read-only
paging, idempotent/repeated operations, narrowed grants, secret canaries,
expiry, compaction/restart, clock rollback, durable append failures and
throwing/stalled/failed diagnostic consumers. POSIX exercises these socket
fixtures; portable profile tests validate the exact primitive projectors.
Numeric overhead for these additional producers and native Windows/packaged
host acceptance remain pending. Earlier lifecycle and total-instrumentation
measurements do not establish this slice's overhead.
