# Mailbox retention, reader gaps and recovery

The broker implements [#122](https://github.com/qwts/agent-comms/issues/122)
under accepted [ADR-0004](decisions/ADR-0004-durable-mailbox-and-waking.md).
The [owner approved](https://github.com/qwts/agent-comms/issues/122#issuecomment-6106764617)
30-day body expiry including unread messages, capacity refusal and a seven-day
durable deduplication window. Broker acceptance is distinct from recipient
acknowledgement.

## Limits and controls

| Resource | Default | Scope and behavior |
| --- | --- | --- |
| Body | 32 KiB UTF-8 | Each message; `message-too-large` |
| Unacknowledged messages | 1,000 | Each soul/principal mailbox; `mailbox-full` |
| Retained messages | 10,000 | Each mailbox, acknowledged or not; `mailbox-full` |
| Retained message bytes | 64 MiB | Each mailbox; UTF-8 JSON including message envelope; `mailbox-full` |
| Message lifetime | 30 days | From acceptance, including unread bodies |
| Dedupe lifetime | Seven days | From acceptance; retries never extend it |
| Protected dedupe budget | 100,000 entries and 32 MiB | Sending account/principal namespace; serialized key/entry pairs; `dedupe-full` |
| Expired-ID evidence | 30 more days, at most 10,000 IDs and 64 MiB | Receiving mailbox; remove oldest evidence first at capacity |
| Maintenance | Every 60 seconds and when an operation encounters due expiry | Single writer; idle watchers receive loss notices |
| Compaction | Startup, expiry, or 4 MiB appended tail | One authoritative checkpoint-and-tail file |

Receipts, wakes, dedupe and expiry evidence have separate accounting; 64 MiB
is a message bound, not RSS/total disk. Ordinary sends and atomic task changes
share admission. Capacity never evicts bodies/protected outcomes early.
Acknowledgement frees unacked capacity; retained count/bytes remain charged
until expiry. Exact capacity fits; exceeding it refuses the new send.

Explicitly launch with `agent-comms broker run --limits-file /path/limits.json`,
a JSON object of [LIMITS](../lib/broker/shared.mjs) overrides. Embedded hosts
pass `new Broker({ limits })`. Overrides apply broker-wide, with no per-mailbox
control. `broker install` does not persist the manual flag; customized hosts
own their launcher configuration. Unknown names/invalid retention limits
fail with `usage`.

Controls: `retainedPerMailbox`, `mailboxBytes`, `messageRetentionMs`,
`dedupeRetentionMs`, `dedupeEntriesPerSender`, `dedupeBytesPerSender`,
`referenceRetentionMs`, `expiredPerMailbox`, `expiredBytesPerMailbox`,
`maintenanceIntervalMs` and `compactAfterBytes`. New message/dedupe deadlines
are persisted at acceptance; changing durations cannot shorten existing
guarantees. Lower capacities refuse new admissions rather than delete data.
Legacy records adopt approved 30-day/seven-day deadlines from their original
timestamps. The first upgraded start can therefore expire old unread data
and create a loss notice.

## Reading and loss notices

`inbox read` starts at the first retained unacknowledged message and adds
`gap: { through, count, firstSeq, lastSeq }` for outstanding unread expiry.
`through` is cumulative mailbox unread loss; the other fields describe the
outstanding notice. The range can include acknowledged messages/other
mailboxes' positions; `count` counts actual unread losses. Global sequence
holes alone never create gaps.

Read/message ack never receives a loss notice on the reader's behalf. After
reviewing/recording it, run `agent-comms inbox gap-ack THROUGH` (principal API:
`ackGap(through)`). It returns `{ acknowledged: COUNT, alreadyAcknowledged:
false }`; retries return zero/true. New loss racing receipt returns
`gap-changed`: reread before acknowledging. Aggregate outstanding loss survives
individual evidence eviction, restart and compaction without unbounded ID lists.

Paging's `after` is exclusive. The stale boundary is the smaller of the highest
expired sequence and earliest retained sequence minus one (highest expired
sequence when empty). A positive cursor below it returns `cursor-expired`
and bounded `error.details`:

```json
{
  "earliestAvailableSeq": 17,
  "resumeAfter": 16,
  "gap": { "through": 2, "count": 2, "firstSeq": 10, "lastSeq": 14 }
}
```

Earliest means an actual retained message, including acknowledged ones. An
empty mailbox reports null and its durable high-water mark as `resumeAfter`.
Suggested resume positions work; the caller explicitly chooses whether to
resume. If prospective deadline changes expire newer messages first, earlier
retained cursors remain usable; the separate gap notice reports that loss.
Omitted/zero `after` starts a session and reports loss with surviving backlog.
Gap details are absent when no unread loss remains outstanding.

Full/coalesced/account watches emit a `gap` event before surviving backlog,
repeat outstanding loss on reconnect and notify connected watchers on idle
expiry. Events carry gap/earliest/resume fields; account events also name
`agentId`. Hook injection preserves gap fields. Workers log loss and its
receipt command without auto-acknowledging or spending a turn. Message-ID
suppression never hides loss notices.

## Retries and references

Inside seven days, the same sender namespace/key/full fingerprint returns
the original message ID, sequence and acceptance wake with `duplicate: true`;
changed content returns `conflict`. Receipt, later wake reports, body expiry,
recipient leave and restart preserve the protected outcome. Reads/census can
show later wake reports while a retry returns the original acceptance outcome.
After expiry the key is reusable and can deliver again, subject to current
recipient policy. Exhaustion refuses new sends instead of dropping guarantees.

Ack/reply to an expired own ID returns `message-expired` while bounded evidence
exists. Foreign IDs and IDs beyond the evidence horizon/budget return
`unknown-message`, revealing no hidden endpoint. Expired parents cannot
validate replies. Retained `replyTo` and artifact strings are opaque historical
references, not promises that referenced bodies/artifacts remain available.

Task claims, invocations and A2A task links have independent lifecycles and
remain retained. Last-five event summaries are independent of message bodies;
task show survives expiry, and ID streams contain no dangling references.
Task brief refuses an expired event. Wakes expire with bodies; dedupe preserves
acceptance outcomes. Census last-wake is the newest retained message's outcome,
or null. Revocation/leave does not itself delete mailbox/identity data.
Other durable collections include tasks, invocations, outbound A2A requests,
launches, pairings, daemons, principals and souls. Their total counts and backup
retention remain separate; this change authorizes no cleanup of those records.

## Format and recovery

| Alternative | Assessment |
| --- | --- |
| One checkpoint plus tail in `events.jsonl` | Selected: one authoritative recovery file and existing append/fold model; rewrites live state |
| Separate checkpoint/tail/manifest | Adds atomic generation selection and missing/mismatched-file recovery |
| Segmented log | Reclaims wholly obsolete segments, but permanent identity/task records pin mixed segments; still needs checkpoints |

Version-1 checkpoints preserve every live collection, receipts, deadlines,
sequence high-water marks and loss evidence, with checksum and structural
validation. Maintenance records carry policy/time, keeping replay deterministic.
Committed time never moves backwards; effective time is the greater of the
clock and persisted time. Expiry is inclusive at `now >= expiresAt`.

Custody/single-writer locking precedes replay/maintenance. The broker writes
all bytes to an exclusively created private sibling temporary file, fsyncs
and closes it, then replaces the authoritative file. POSIX fsyncs the directory;
Windows uses checked native `MoveFileExW` replacement with write-through.
Later commits complete only after durable replacement. Initial file creation
uses the same staged replacement. Appends open the current path and fsync
before folding/reporting success. There is no copy/delete fallback or guess
that an abandoned temporary file is a newer generation.

Checkpoint must be first. Invalid checksum/references/positions, reused IDs
or sequence, unsupported version and corrupt complete lines fail visibly.
Only after valid complete history is folded are torn final bytes truncated
and fsynced. Invalid history is left untouched. Ambiguous append/replacement
poisons the writer: `storage-failed` requires restart/recovery before further
writes. No-op requests neither scan nor fsync the whole state.

Old brokers reject new maintenance/checkpoint types before appending;
downgrade after new writes is unsupported. Coordinate host reader/recovery
policy with [GeniusBar's compatibility matrix](https://github.com/true-line/geniusbar/blob/main/docs/compatibility-matrix.md)
and [proposed ADR-0282](https://github.com/true-line/geniusbar/blob/main/docs/decisions/ADR-0282-component-compatibility-and-recovery.md).
The closed investigation did not accept its outstanding owner choices.

## Operations and evidence

Compaction needs space for active log plus a complete live checkpoint until
replacement. Disk-full, short writes and fsync failures never become successful
acceptance. Read broker diagnostics, correct storage, then restart with a
compatible reader. Failed replacement leaves a recoverable old/new authoritative
generation, not a guessed combination.

Before upgrading, stop writes and back up the authoritative state directory
with private permissions. After shutdown, `events.jsonl` is the recovery
source. Restore a consistent generation with a compatible broker and check
startup/reads. Old backups lose newer accepted data; they are not lossless
downgrade recovery. Temporary files are not backups. Backup cleanup remains
an owner operation outside live mailbox limits.

[Recovery/resource fixtures](../tests/state-retention.test.mjs) cover recovery,
bounded cycles, deadlines and capacity. [Acceptance fixtures](../tests/retention-acceptance.test.mjs)
exercise protocol boundaries and namespaces. Native Windows replacement runs
in CI; macOS fixtures prove neither Windows host acceptance nor hardware
power-loss behavior. Heavy performance/end-to-end lanes run in CI.
