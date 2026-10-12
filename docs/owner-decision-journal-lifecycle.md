# Disabled broker typed lifecycle storage

This internal fixed-v1 slice extends the [same bounded journal core](owner-decision-journal-core.md)
with the [producer-owned typed graph](owner-decision-journal-records.md). No route,
capability advertisement, receipt signer or daemon adapter consumes it. Valid
stored evidence never grants current authority; both authorizationSupported and
physicalAllocationSupported remain false. R1–R4 acceptance is not established.

## Trusted configuration and retained evidence

`OwnerDecisionJournalStore` is an alias of the existing admission class, not a
second format or store. Explicit trusted constructor configuration adds
`lifecycle:{brokerPublicKeys,presencePublicKeys}` only with `format:"fixed-v1"`.
These bounded arrays contain independently trusted Ed25519 public KeyObjects;
the constructor snapshots their key-ID maps, rejects duplicates and never
enrolls keys from records. The default reader still refuses any later nonzero
slot. Missing historical keys refuse; key retention/enrollment remains the
trusted coordinator's responsibility. No arbitrary verifier callback exists.

`createOwnerDecisionLifecycleValidator` snapshots all present bounded bytes and
checks exact schemas, original acceptance/action bindings, legal predecessors,
proof digests and selected daemon/watch/epoch. Prepared wrapper validation
retains authenticated public staging expiry without changing public challenge
or signed bytes. This new wrapper selects no wire serialization. Existing
disabled admission-only stores have never written a challenge, so no lifecycle
migration is implemented or inferred. Unknown or contradictory slots freeze
instead of falling back to an earlier permission state.

Every presence-only crash prefix verifies p1 with the pinned bot-owned verifier,
exact action text/nonce and independently trusted presence keys. It remains
prepared and proof-incomplete, never authorized. Existing p1 decoding/signature
semantics are preserved. With d1 present, its untrusted bounded key hint can
select only an already pinned broker key; strict d1 signature/schema validation
then selects an already pinned presence key and invokes the complete existing
proof binder. Retained p1/d1 bytes are never normalized.

Historical verification uses a deterministic clock derived from signed issuance
and saved authenticated acceptance/preparation: max(issuance,0,acceptedAt−30,
preparedAt−30), converted to safe milliseconds. The standalone p1 prefix uses
its verified issuance; the complete proof uses verified d1 issuance. Existing
signed preparation/p1/d1 skew, ordering and expiry checks remain strict. This
historical clock verifies stored evidence rather than making it fresh. Outcome
and reconciliation timestamps remain safe nonnegative seconds; causal order
comes from the slot graph, not wallclock monotonicity. Effects may finish after
expiry.

## Synchronous storage API

Each method holds the existing kernel lock, revalidates namespace, count, every
initialized slot and complete typed graph, and requires instance-local flush
evidence before publishing. Candidate graphs are completely validated before
the first write. Publication uses the existing final inode body/flush/trailer/
flush/readback sequence; there is no link, rename, truncate or new phase file.

- `recordPrepared(requestId,wrapperBytes)` accepts only preparing. It checks the trusted current clock and complete wrapper cap before publication.
- `recordAuthorization(requestId,{presenceBytes,receiptBytes,authorizationBytes})` accepts only prepared. It verifies complete proof against the trusted current clock, then flushes p1, d1 and authorization in that order. A leftover incomplete proof refuses reissuance/resumption.
- `recordRelease(requestId,releaseBytes)` accepts only authorized and checks the retained proof against the trusted current clock. It stores the exact release record but returns no mayApply field or effect permit.
- `recordOutcome(requestId,outcomeBytes)` records one immutable legal outcome. Cancelled/expired cannot follow authorization; applied/indeterminate require release. Broker-origin applied and post-release inferred refusal are forbidden.
- `recordObservation(requestId,referenceBytes)` records the first immutable indeterminate reference. A changed observation conflicts; bounded replacement and scratch recovery remain a prerequisite.
- `recordResolution(requestId,referenceBytes)` resolves only indeterminate with an immutable applied/refused reference. Authenticated daemon evidence lookup/validation is a future coordinator obligation; an echoed evidence digest is not custody proof.

Success is `{requestId,state,duplicate,authorizationSupported:false,
physicalAllocationSupported:false}`. Exact duplicate bytes return the current
stored state, including a later terminal state; they never rewind, redeliver or
reissue proof. Conflicting bytes refuse. `read` copies the retained slots and
reports stored state separately from admission-visible/admission-complete.
`inspect` includes stored state. Neither status operation writes or flushes.

Every reopen starts without flush evidence. A complete visible graph refuses
transition/duplicate acknowledgement until explicit `recover` flushes all eleven
inodes and directories and revalidates all names, schemas, bytes and identities.
A changed inode or exact frame invalidates the cache. A valid partial p1/d1
prefix can be recovered for inspection, but cannot resume authorization. Torn,
unknown, inconsistent or unsupported records refuse; no older image is used.
An I/O failure retains the prefix, poisons the instance and requires reopen.

## Remaining coordinator and native boundary

This API is composable storage, not the live release transaction. A future
coordinator must authenticate before lookup, independently resolve the selected
account daemon and intersect current scoped owner and target grants, pairing,
watch and enrollment at the release linearization point. It must bind one online
awaiting check, recheck expiry/current authority after durable publication before
answering mayApply:true, and never replay a stored release. Authenticated
preparation/result/reconciliation transport and daemon evidence validation also
remain prerequisites. Constructor key registries and trusted clock are local
configuration, never request-selected authority.

`ownerDecisionJournalError` maps only fixed codes/messages: malformed input to
bad-request, spent/conflicting ID to conflict, quota to journal-capacity,
unsupported phase to owner-decision-unsupported, and lock/corruption/I/O/recovery
failure to storage-failed. Mapping does not alter lifecycle or infer refusal.
The future route must return the existing non-disclosing unavailable result for
unknown/unauthorized requests before exposing storage findings.

Ordinary Node writes/fsync and all-zero initialization remain disabled test
mechanics. The reviewed native allocator/full-flush bridge, filesystem eligibility,
physical allocation and metadata guarantees, real macOS 13 runtime verification,
observation replacement and live composition are still required. No physical
support option, production namespace bootstrap or daemon-state access is added.

## Validation

Run `node --test tests/owner-decision-lifecycle-records.test.mjs
tests/owner-decision-journal-lifecycle.test.mjs`. Pure typed tests run everywhere;
Darwin storage tests cover all operation shapes, exact duplicate/reopen behavior,
malformed candidate refusal before writes, expired live proofs, publication
SIGKILL points, EIO/ENOSPC/EDQUOT flush failures, full-graph recovery and inode/
byte invalidation. Child output/lifetimes/cleanup are bounded. These tests prove
process-interruption behavior on the test host, not power-loss durability.
