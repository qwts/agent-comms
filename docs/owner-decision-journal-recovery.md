# Owner decisions: proposed journal ordering and recovery

This disabled companion defines ordering for the [bounded slot graph](owner-decision-journal-records.md)
and [finite reservations](owner-decision-journal-capacity.md). It selects no backend
and makes no multi-file atomicity or runtime acceptance claim.

## Exact bytes before acknowledgement

Admission is deliberately multi-file, not atomic as a group:

1. Authenticate, authorize and validate the complete bounded original action before creating admission artifacts. Fix the selected binding and original acceptedAt once; never refresh that clock while allocating.
2. Under the store admission lock, charge a full reservation for a new request directory and durably publish its name before creating other entries. Any surviving directory or partial artifact counts after interruption, even before acceptance. At the broker its name is the UUIDv4 request ID. At the daemon use lowercase SHA-256 of canonical `{namespaceDigest,requestId,v:1}` so the stable namespace/request tuple has one fixed 64-byte name. A repeated orphan key refuses, never starts fresh admission.
3. Publish and flush the exact canonical original action slot, then publish and flush immutable acceptance referencing its digest and fixed reservation. Only the complete validated durable pair may become preparing or be forwarded. An interrupted prefix stays reserved; restart never automatically forwards even a complete saved pair.
4. The daemon creates nonce, preparedAt, expiry and effectId once from the authenticated original prepare event and saved expected state. Before its owner-decision-prepared request, persist complete context/action, immutable typed preparation evidence and its exact deterministic challenge. Validate their byte/digest/nonce/time/expected-state bindings and separately retained private stage descriptors. No preparation acknowledgement precedes these flushes. A partial prefix cannot stand in for preparation or permit application.
5. Before exposing prepared status, the broker validates the selected authenticated response and reconstructs the same challenge from saved action/context plus the daemon's unchanged nonce/preparedAt/exp and validated public stage descriptor, then durably publishes the broker's exact bounded `{challenge,stage,v:1}` wrapper. The inner challenge is unchanged; its digest and daemon slot 3 never hash the wrapper. It creates no new challenge nonce or preparation binding. Before authorization/delivery, flush complete p1 and d1 slots followed by the spent-nonce authorization marker. Before mayApply:true, durably publish release. Before daemon effect entry, flush the successful check and entered evidence under the required final lock. Completion and terminal reconciliation require their own whole-effect proof and flushes.

A duplicate daemon preparation never regenerates nonce, effectId, expected state
or deadlines. Reopening visible preparation/challenge bytes requires explicit
flush and full graph revalidation before repeating prepared acknowledgement,
including exact duplicates. Recovery never schedules application.

Every step rechecks the applicable original deadlines before proceeding. A
partial graph or leftover proof must not expose an older success that would
reissue/deliver/release work. Use the existing non-authorizing storage refusal
when safe state cannot be established; retain indeterminate where an attempt
may have entered. The exact live check/current-authority requirements remain
independent of these on-disk order rules.

## Exclusive publication and recovery

Prefer immutable per-request phase/slot records over rewriting a complete state
image. Serialize admission globally; serialize each request's transitions and
follow the existing [domain lock order](owner-decision-locking.md). Every
permission-bearing slot publishes logically once, exclusively, through a
reviewed backend. The original scratch/hard-link candidate writes and flushes
bounded bytes, creates the final name without replacing an existing destination,
then flushes the directory before acknowledgement or forwarding. The proposed
[fixed-name backend](owner-decision-journal-fixed-slots.md) instead creates and
initializes all final names before admission, then publishes bounded framed
contents with explicit body/trailer flushes and strict recovery. The bounded
APFS comparison found that successful data preallocation alone does not cover
a later hard-link metadata operation. Neither mechanism is production-enabled
or establishes unconditional future physical capacity. Acknowledged acceptance also durably reserves its full budget and ID
before any preparation event. Exact duplicate input reads saved state and never
publishes another slot, proof or delivery attempt.

The stored graph must validate all present slots, their original-byte digests,
namespace/request/target/epoch/watch bindings and legal transitions. A malformed,
unknown, inconsistent, corrupt or ambiguous newest phase never falls back to an
older prepared/authorized permission state. It refuses release/effect, preserves
all material and retains indeterminate where an attempt may have entered.
Missing completion cannot prove refusal. No record-only recovery infers an
effect from a preexisting matching value or from absence of a marker.

An orphan scratch file cannot create another scratch allocation on retry. Its
bounded recovery must inspect it with the immutable graph; unknown contents
refuse writes and remain for inspection. When exclusive publication used a
second hard-link entry, identical retained target/scratch bytes may permit
removing only the redundant scratch entry after required flushes. That cleanup
never removes the authoritative record or permits redelivery. Backend-specific
crash points and directory allocation must be reviewed and tested; this graph
does not claim existing generic file-lock stale-artifact cleanup already meets
these bounds.

Only the indeterminate observation and its preimage may replace old bytes. Their
publication uses the exact bounded observation-pair frame from the
[slot contract](owner-decision-journal-records.md#producer-owned-slots), scratch reservation and
durable replacement; an implementation cannot expose a mixed digest/preimage.
Original entered/completed/refused evidence and authoritative linkage remain
unchanged forever. Terminal resolution uses the immutable terminal-pair frame with the same
component/wrapper bounds. Flush completed or proven pre-effect refused evidence
first, then body/trailer and exact readback of the terminal pair, then terminal
outcome/report. Reopened visible pairs require explicit recovery flush before
acknowledgement. No mixed record/preimage pair is ever a committed resolution. No permission-bearing rollback or automatic
mutation retry is permitted after restart. Current authority, live check,
receipt deadline and final expected-state lock checks remain independent
requirements; a valid stored phase is never standalone authorization.
