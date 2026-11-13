# Notices in HQ's broker mailbox

The HQ broker plugin pulls GitHub notices through HQ's identity-service host
service. It stores each notice in the plugin's durable HQ store transaction
before acknowledging the service's lease. This implements the ingestion gate
in [HQ plan §4.8 and row 11](https://github.com/true-line/agent-bot-hq/blob/main/docs/daemon-plugin-split.md).
Tracking: [agent-bot-comms #313](https://github.com/true-line/agent-bot-comms/issues/313)
and [agent-bot-hq #123](https://github.com/true-line/agent-bot-hq/issues/123).

## Enable and inspect

HQ's owner-written config enables ingestion explicitly:

```json
{
  "notices": {
    "harnesses": ["example-codex-agent"],
    "pollIntervalMs": 30000,
    "count": 10,
    "leaseSeconds": 300,
    "wakeClass": "none",
    "maxMessages": 1000,
    "maxBytes": 16777216,
    "retentionMs": 691200000
  }
}
```

The queue names must also be in the enrolled device's scope; the identity
service enforces that scope. A reply naming a different queue is refused.
The plugin declares only the notice take and ack identity-service routes.
No configuration means no pulls. Starting the broker never waits for the uplink.

The trusted host can use the plugin's `provides.notices` object:

- `pull()` performs one bounded pass across the configured queues. Concurrent
  callers share the pass. `reconnect()` requests the same pass immediately.
- `list(harness)` reads ready mailbox records. Each record's `message_id` is
  the notice ID; the durable key also names the queue, since one GitHub event
  can be addressed to more than one harness.
- `acknowledge(harness, messageIds)` records local consumption after the
  trusted consumer finishes handling the messages. This is separate from
  acknowledging the upstream lease.
- `status()` reports configuration, running/revoked state, consecutive failures,
  the last successful pass and a bounded failure category. `mailbox_full`
  means local consumption or capacity needs attention.

These are host-side plugin methods. This slice adds no member wire operation
and no public CLI. A future member-facing surface must keep its caller binding
and grant checks; a caller cannot supply an arbitrary harness to this pump.

## Custody and recovery

A notice is always `external-untrusted`, with wake class `none` or `notify`
chosen by the owner's configuration. Source-supplied authority and wake fields
are ignored. Ingestion publishes a custody event after the durable commit;
it never launches a Soul or treats notice text as a directive.
The event is an in-process hint, not custody itself: if publishing fails, the
message remains available through `list(harness)` for the consumer to recover.

The mailbox stores only known notice content fields, bounded to 64 KiB per
message. Lease tokens, lease expiry and attempts stay in memory. Logs contain
fixed failure categories, never notice text, upstream response bodies or
exception messages.

- Before a durable commit, a failure sends no upstream ack. The lease expires
  and the notice can return.
- After a commit, an ack failure leaves the mailbox record intact. A replay
  returns its existing sequence and acknowledges the new lease without a
  second committed transition or custody event.
- The same ID with different content is refused without overwriting custody.
- A storage failure rolls back the transaction. Message and byte caps refuse
  new custody, leave the upstream notice unacknowledged, and report pressure.
  Already-held duplicates can still be acknowledged while the mailbox is full.
  The message cap includes both ready records and retained tombstones, so
  overload cannot evict dedup evidence before its retention horizon.
- Local consumption removes the content and keeps a compact dedup tombstone.
  Tombstones are retained for at least seven days (eight by default), covering
  the service's seven-day queue retention. Only consumed records beyond that
  horizon are pruned. Ready messages and live dedup evidence are never evicted
  to make room.
- Start, scheduled polls and reconnect/on-demand pulls use the same path.
  Transient failures retry with a one-second exponential backoff capped at
  one minute. Revocation stops remote requests until a new plugin lifecycle.
  Stop cancels polling and invalidates late responses before custody or ack.

## Compatibility and evidence

The existing identity CLI/MCP `take_inbox` shim remains unchanged. Its
immediate upstream ack is still an at-most-once compatibility path; it does
not supply this durable ingestion guarantee or prove alias parity.

`tests/hq-notices.test.mjs` uses the real HQ store at the vendored SDK's pinned
revision. It covers persistence failures, restart after custody and before
ack, duplicate/content-conflict handling, caps, retention, late responses,
revocation and retry. Existing broker tests continue to exercise real HQ
admission and task commits over its member socket.
