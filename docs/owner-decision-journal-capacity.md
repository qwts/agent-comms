# Owner decisions: proposed finite journal capacity

This disabled companion to [the lifecycle](owner-decision-lifecycle.md) proposes
finite storage for [the exact retained slots](owner-decision-journal-records.md).
It supplies no journal implementation, routes, custody, evidence transfer or
R1–R4 acceptance. Broker and bot must review the backend and crash tests before
admitting owner decisions.

## Admission and retention

Version 1 retains the full record and accepted-ID binding for at most **4096
requests** per broker installation. A daemon store independently admits at most
4096 requests in aggregate across its enrolled broker namespaces. These are
lifetime retained counts, including cancelled, expired, refused and unsettled
requests. No record retirement, automatic compaction, ID eviction, reuse or
quota refund is supported. This version never emits `details-retired`; that
existing reserved wire outcome does not authorize a deletion policy here.
Explicit installation decommissioning remains the lifecycle boundary.

Reserve the complete per-request budget durably before forwarding preparation
at the broker, and before acknowledging a valid preparation at the daemon.
Exhaustion returns the existing `journal-capacity` refusal. A broker-accepted
request later refused by a full daemon remains accepted at the broker and
consumes its broker reservation. Neither side fabricates the other's evidence.
A refusal before durable admission starts creates neither an accepted ID nor a
reservation. Interrupted admission is different: any surviving request directory,
action or scratch entry consumes one full count/byte reservation, even without
a complete acceptance record. Such an orphan ID never becomes fresh/reusable
and is not silently freed. Recovery cannot forward without complete validated
durable action and acceptance. No effect is inferred from an orphan. Principal/daemon
re-pairing, receipt-key rotation and account revocation never reset storage
counts, IDs or unsettled reservations.

The daemon keys a request by its independently enrolled **stable broker
installation namespace** and request ID. The local index may retain a fixed
64-hex namespace digest, but its exact preimage and authenticated trust-record
binding require the reviewed enrollment adapter. A filesystem path, caller
string or rotating receipt-key ID is not automatically an installation identity.
This indexing prerequisite creates no new credential or caller-selected wire
identity. A missing/ambiguous namespace refuses admission.

## Mechanically bounded reservation

One KiB is 1024 bytes. Caps below include nullable/unused slots as fully reserved.
Every slot has at most 256 additional framing/checksum bytes. A request has at
most one scratch file, whose payload is at most 32768 bytes and framing at most
256 bytes. There are at most 24 named non-directory entries and eight named directories
per request, counting permanent records, scratch, locks, owner stamps, takeover
and stale artifacts. Count directory entries, not unique inodes: a hard-linked
scratch and published target charge two entries, even when they share data.
Unsupported entry types refuse writes and still consume their entry charge. Every component is fixed ASCII at most 64 bytes; only canonical
UUID/digest components come from validated identifiers. Unknown artifacts or
failed cleanup cannot bypass these counts.

| Store | Slot payload sum | Slot framing | Scratch | Metadata accounting | Required charge | Reservation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Broker, 10 slots | 94208 | 2560 | 33024 | 131072 | 260864 | 262144 |
| Daemon, 16 slots | 126976 | 4096 | 33024 | 131072 | 295168 | 524288 |

Metadata accounting charges 4096 bytes for each of the 32 permitted named file/
directory entries. It is a conservative **logical accounting unit**, not a
claim that every supported filesystem physically uses exactly that much space.
The implementation must enforce the byte, object and filename limits together;
there is no unconstrained per-request audit log, retry file or hidden index.
A change in slots, field bounds or artifact graph requires recalculating this
reservation before enabling it.

The broker therefore reserves at most 1 GiB for request allocations; the daemon
at most 2 GiB. Each store additionally reserves 1 MiB for its fixed store metadata,
admission scratch and global lock artifacts: at most 16 named non-directory entries/eight
named directories, fixed 64-byte names, and at most 128 KiB total encoded metadata and
scratch payload. No unbounded directory-per-attempt or detached global log is
permitted. Directory scans stop and refuse writes at the object limit; malformed
or excess entries remain for inspection, never silently deleted to admit work.

These limits bound this journal's accounting, not the whole filesystem or the
bot's existing revision/package history. The selected backend must check its
supported filesystem allocation/durability behavior, reserve actual write
capacity and fail closed on ENOSPC/I/O/flush errors. Sparse truncation or a free
space query alone proves no physical reservation. Other processes, snapshots
and hardware failures can still make storage unavailable; a logical reservation
never permits an unacknowledged release/effect or a fabricated success.

Package/webhook/private descriptor bytes are separately charged to existing
stage limits: 64 MiB per package stage, 32 KiB per webhook stage, four live stages
per principal/target and 256 MiB total per daemon. Unsettled snapshots retain
those charges. Moving bytes into an owner journal, pairing again or expiring a
receipt does not release staging quota. This proposal adds no snapshot deletion
or ordinary revision-history retention policy.

## Status and reconciliation at capacity

New preparations stop at capacity; existing status reads do not append records.
Each request has already reserved its initial result, one replaceable
indeterminate observation and one immutable terminal resolution, including both
original and reporting daemon key IDs/epochs. Repeated unchanged observations
return the existing record; changed observations replace only their bounded
slot. They never consume another accepted-ID reservation or discard original
proof. If the selected backend uses a finite observation-generation counter, it must
reserve terminal resolution independently so counter exhaustion cannot prevent
resolving proven evidence.

Public broker status returns retained outcome/reference fields. Canonical daemon
preparation/effect/reconciliation bytes remain under daemon custody. There is no
new wire retrieval promise or evidence-transfer interface here. An unavailable
source cannot be replaced by an inferred result. Owner-local reconciliation
needs the retained daemon source and the existing local gate; if a later feature
promises remote evidence retrieval, a bounded authenticated typed interface
requires separate review.

## Reproducible specification check

Run `node tools/acceptance/owner-decision-journal-budget.mjs`. Its static
[journal-budget-v1.json](../tests/fixtures/owner-decisions/journal-budget-v1.json)
records the exact slot caps, arithmetic results and maximal-width typed
administrative records with canonical bytes/digests. The checker reproduces
sums, entry/framing/scratch charges, installation totals and record bounds. It
imports no production journal or codec and proves no disk allocation, durable
recovery, authority or runtime acceptance.
