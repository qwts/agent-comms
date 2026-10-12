# Federation: Cloudflare candidate feasibility review

**Status:** Proposed engineering review, 2026-10-11, for #28/#118/#119.
The [owner receipt](https://github.com/qwts/agent-comms/issues/28#issuecomment-6115481556)
accepts the [policy](decisions/ADR-0028-cross-machine-hubs-and-federation.md),
not provider suitability. This document records official capabilities, arithmetic and bounded local
synthetic measurements, not production application results. No account, deployment, spending,
crypto construction, envelope codec or production schema is authorized here.

## Candidate fit and unresolved boundaries

A SQLite-backed Durable Object (DO) per reference relay is a plausible initial
consistency boundary. A single object avoids cross-object admission accounting;
sharding would need a separately reviewed aggregate-cap design. The following
are engineering inferences, not implementation decisions.

| Accepted constraint | Candidate fit and required evidence |
| --- | --- |
| 32 brokers, 100 exported souls each | Small connection/discovery population; measure reconnect bursts, authorized paging and fair admission rather than infer performance from count. |
| 64 KiB wire envelope | Below documented 32 MiB received WebSocket and 2 MB SQL row limits. Keep application rejection at its much smaller accepted limit. |
| 10,000 pending bodies / 256 MiB, plus 100,000 protected outcomes / 32 MiB | Store custody on disk and page bounded batches. The 288 MiB payload budget cannot be hydrated inside a 128 MB Worker isolate. SQL pages, indexes and provider metadata consume additional storage. |
| Atomic body/outcome/cap reservation | Keep the synthetic admission operation within one object's transaction; require rollback and durable-write-before-receipt evidence. No network handoff is part of that transaction. |
| Thirty-day expiry, protected through expiry + 120 seconds | No provider TTL may delete protected outcomes early. Clock rollback, restart, expiry races and duplicate delivery need explicit tests. |

The [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
list 10 GB per SQLite object, a soft 1,000 requests/second and 30-second default
CPU allowance; they are ceilings, not our throughput guarantee. The same page
inconsistently describes the Free per-object storage limit as 10 GB in its table
and 1 GB in its FAQ. The proposed 288 MiB payload fits either, but production
plan limits need confirmation. [Worker limits](https://developers.cloudflare.com/workers/platform/limits/)
include 128 MB memory per isolate, potentially shared by objects.

[SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
is transactional and strongly consistent within an object. `transactionSync`
rolls back when its callback throws; `sync()` waits for pending persistence.
Review output/receipt ordering without `allowUnconfirmed`. PITR can restore the
entire database to a point in the prior thirty days and is unavailable locally.
Restoring an old snapshot could resurrect revoked trust or erase protected
outcomes. Recovery must refuse or reconcile that rollback; PITR is not the
application's thirty-day retention guarantee.

[WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
keeps accepted connections while resetting in-memory state and re-running the
constructor. Recover authorization from durable state; connection attachments
cannot supersede revocation. DO-server sockets can hibernate; outgoing sockets
cannot. Timers and pending work can prevent hibernation. Brokers initiating
connections to the relay fits this direction; periodic in-object polling may
undermine its cost benefit.

The protected-outcome caps imply an independent traffic limit: 100,000 outcomes
spread across thirty days plus 120 seconds permits roughly 3,333 new outcomes/day
in steady state. The 32 MiB cap permits about 335 serialized bytes/outcome at that
count. Measure actual evidence encoding; whichever cap fills first rejects
admission. Provider database overhead is separate from serialized application
accounting and must be measured, not subtracted from protected evidence.

## Measured local relay storage boundary

The opt-in [local feasibility package](../tools/feasibility/durable-objects/README.md)
now exercises the entire-relay body/outcome budgets with pinned native workerd
1.20260730.1 on macOS and Node 24.19.0. One local run passed in 65,665 ms. These
are synthetic measurements, not cloud limits or performance guarantees.

| Measured quantity | Observed value |
| --- | --- |
| Pending bodies, verified from streamed complete rows | 10,000 / 268,435,456 bytes (256 MiB) |
| Protected outcomes, serialized evidence verified from streamed rows | 100,000 / 33,554,432 bytes (32 MiB) |
| SQLite database at full admission | 325,394,432 bytes (about 310.3 MiB), separate from 288 MiB serialized custody |
| Actual native workerd process RSS, 322 samples | 32,522,240–392,658,944 bytes; sampled maximum about **374.5 MiB** |
| Indexed body/evidence pages | One complete body / at most 32 outcomes; maximum reported rows read 1 / 32 |

**The sampled 374.5 MiB process RSS leaves the provider memory question open.**
It includes native runtime, SQLite and caches and can miss peaks; it is neither
Node runner RSS nor a Worker isolate heap measurement. This local result does
not demonstrate compliance with the documented 128 MB isolate limit. A separate
provider-representative memory gate remains before suitability or deployment.

Streaming hashes and independently counted serialized bytes remained unchanged
after refused growth, lowered caps and duplicate/conflict retries. Bodies expired
under an injected logical clock while outcomes still reserved admission capacity.
Outcomes remained protected at exactly expiry plus 120,000 ms; releasing one
reservation at plus 120,001 ms allowed exactly one replacement. Padded synthetic
labels make this a storage/accounting probe, not evidence for production crypto,
wire encoding, real outcome sizes, all per-route/broker/multihub caps or billing.
Requests/pages are bounded, but response-size assertions verify this trusted test
worker after reading; they are not an untrusted-response streaming limiter.

## Cost assumptions and finite write budget

[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
currently gives Paid a $5/month account minimum, 10 million requests and
30 million CPU-ms, then $0.30/million requests and $0.02/million CPU-ms.
This is a planning input, **not spending authorization**.

[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
currently includes Paid monthly allocations of 1 million requests, 400,000 GB-s,
25 billion row reads, 50 million row writes and 5 GB-month. Overage rates are
$0.15/million requests, $12.50/million GB-s, $0.001/million reads,
$1/million writes and $0.20/GB-month. Incoming WebSocket messages use 20:1
compute-request billing; outgoing messages are uncharged. Deletes and alarm
updates count as writes. Measure index-related write amplification. Free daily
limits include 100,000 requests and 100,000 writes; exceeding limits fails
operations. Duration uses 128 MB allocation while active and nonhibernating.
These are distinct meters; small retained storage does not ensure small cost.

Assuming 32 connections, one batched advertisement each thirty seconds and a
thirty-day month gives 2,764,800 incoming frames, or 138,240 DO request units
before reconnects, receipts, alarms and control requests. Persisting one hundred
soul rows per advertisement instead gives 276,480,000 row updates before indexes
or cleanup. This illustrates why a finite row/write budget and bounded indexed
queries are required. No traffic rate, operation count, hibernation duty cycle,
monthly bill or SLA has been measured. Application payload caps do not cap
hostile connection traffic or provider charges.

## Bounded local feasibility harness

Use pinned dev-only vendor tooling, local persistence in disposable scratch,
loopback listeners, no remote bindings or credentials. The official
[DO test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)
provide `runInDurableObject`, `runDurableObjectAlarm` and `evictDurableObject`;
eviction can preserve hibernating sockets. Pin versions/integrities before use.
Keep a synthetic storage/transport probe outside production `lib/`; it is neither
a federation schema nor a cryptographic envelope prototype.

1. Reserve opaque synthetic bytes, one outcome and counters atomically; throw at
   each step and race admissions at count/byte boundaries. Record committed rows
   and ensure rejected operations leave no partial reservation.
2. Fill accepted maximum populations and custody sizes with bounded pages; measure
   database bytes, index/read/write counts, peak RSS, response latency and queue
   backpressure. Repeated full scans must fail the operation-budget criterion.
3. Evict/recreate objects, restart the local runtime and lose replies after commit.
   Verify identical synthetic IDs yield one stored outcome, altered digests
   conflict, and expiry/capacity never evicts protected evidence.
4. Exercise hibernated socket recovery, stale connection authorization after
   synthetic revocation, simultaneous reconnects, alarm repetition and injected
   clock boundaries. Report timing assumptions and retained counters explicitly.

Local results cannot establish production replication durability, billing,
provider-region failover, PITR recovery or metadata/key custody. Those remain
reviewed remote evidence gates requiring separate deployment authorization.
Independent crypto review still precedes the production protocol/codec/schema.
