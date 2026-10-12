# Disabled broker journal admission core

`lib/owner-decision-journal.mjs` is an internal, disabled implementation of only
the admission prefix in the [proposed journal contract](owner-decision-journal-capacity.md).
No broker route, capability discovery or daemon adapter imports it. It does not
reserve physical write capacity, authorize an operation or claim R1–R4 acceptance.
The full challenge/proof/release/effect/reconciliation lifecycle remains future work.

## Supported storage findings

`OwnerDecisionAdmissionStore(root, { namespaceDigest })` requires an existing,
private, owned 0700 directory in trusted ancestry. Its digest must come from the
future independently enrolled stable broker namespace, never a request field.
That enrollment adapter remains a prerequisite; synthetic tests supply a fixed
value. The constructor pins the digest in immutable local metadata and rejects
reopening with a different digest. Initial construction in an empty root creates the fixed lock, namespace metadata
and request-container directory; it creates no request ID. Later inspect/read/admit
calls only validate that metadata. Missing established files refuse without recreation.

All methods are synchronous and serialize on one kernel lock:

- `admit(actionBytes, acceptanceBytes)` validates and snapshots the complete exact action and acceptance before creating a request artifact. It returns only `{requestId,finding:"admission-complete",duplicate}`. An exact duplicate reads the original bytes; changed bytes conflict. It does not forward or acknowledge any protocol preparation.
- `inspect()` returns retained-ID count, full logical reservation charge and bounded per-ID admission/orphan findings. `physicalAllocationSupported` and `authorizationSupported` are always false.
- `read(requestId)` returns absent/orphan/admission-complete and copies of any saved original action/acceptance bytes. These findings never imply a lifecycle state, reusable permission or a mutation outcome.

Acceptance has the contract's exact fields and primitive types, with full
cross-binding to the action's request, principal, account, soul, operation and
original-byte digest, plus the configured namespace. The reservation is exactly
262144 bytes, including empty future slots. Selected daemon/watch/epoch and time
fields are structurally checked; current authority, enrollment and live deadline
validation remain the future caller's responsibility.

There are at most 4096 retained request directories. Empty/action-only interrupted
admissions consume a full reservation and permanently spend that ID. Capacity
refusal does not poison existing reads or exact duplicates. Corrupt or unknown
artifacts refuse writes; none are silently freed or reused. Later lifecycle slot
names explicitly return `owner-journal-unsupported-phase`; the core does not
accept opaque future records or fall back to an earlier permission state.

## Experimental framing and publication

This disabled backend uses one canonical JSON header followed by LF and exact
payload bytes. The header is exactly `{bytes,sha256,slot,v:1}`, with safe positive
payload length, lowercase SHA-256 and fixed slot action/acceptance/namespace.
Header plus LF is at most 256 bytes. The payload caps are 32768/4096/4096 bytes.
This is local experimental framing, not a production wire encoding selection.

One fixed `pending` scratch entry publishes exclusively through write-all,
file fsync, `linkSync` to the immutable target, directory fsync, scratch unlink
and directory fsync. `EEXIST` never overwrites a target, even if bytes match.
Every exception after writing starts retains artifacts and requires reopening
before further writes. Reads validate bounded framing, exact schemas/digests,
private ownership/modes, regular files, inode identity and original bindings.
They reject unsupported types and unknown entries. Directory iteration stops at
count plus one, rather than allocating an unbounded listing.

A surviving scratch with complete valid bytes remains charged. A redundant
hard-link scratch and target are separate named entries, although they share an
inode; reading/replay never deletes either. Any surviving request scratch makes that ID
an orphan and prevents duplicate acknowledgement: a visible target is not proof
that its directory flush completed. A partial/unknown scratch blocks
recovery writes and remains for inspection. A complete pair discovered after
restart is a storage finding only; restart never forwards it automatically.
No multi-file atomicity, automatic mutation retry or missing-marker effect proof
is claimed.

## Darwin boundary and remaining prerequisites

The kernel lock uses Apple's documented `O_EXLOCK | O_NONBLOCK` open flags on
one fixed, private, empty file. It is never unlinked or replaced. Existing opens
never use create flags; initial creation is exclusive, so a disappearing or racing
name cannot silently become a second lock inode. Contention
returns `owner-journal-busy`; kernel close/process death releases the lock.
The Darwin flag value is pinned to the macOS 13-era XNU header, and libuv passes
numeric open flags through with close-on-exec. No npm runtime dependency or
external lock process is introduced.
[Apple open documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html)
and the [XNU header](https://github.com/apple-oss-distributions/xnu/blob/xnu-8792.61.2/bsd/sys/fcntl.h)
define this primitive. Other platforms fail before filesystem mutation.

Native tests on this macOS 27 host establish process contention, crash release,
spawn inheritance behavior and recorded publication crash points. They do not
establish power-loss durability, all Darwin filesystem support or actual macOS
13 runtime support. Node's fsync attempts full flush on Darwin but can silently
fall back to weaker operations; see the
[pinned libuv implementation](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/fs.c#L158).

Physical reservation and filesystem eligibility remain explicit prerequisites:
Node's public fs API has no persistent all-or-nothing preallocation operation.
Free-space queries, sparse truncation and a separate reservoir file do not prove
future exclusive-slot capacity. A reviewed native strategy must account for
actual final inodes, metadata, APFS copy-on-write, replacement scratch, reboot
persistence and disk-full behavior before enabling admission. Daemon storage
stays in agent-bot under ADR-0002; this core never accesses its files.

## Validation

Run `node --test tests/owner-decision-journal*.test.mjs`. Pure acceptance tests run
on every platform; native storage/lock tests skip outside Darwin. Tests cover
all operation schemas, immutable binding, byte snapshots, quota including
orphans, fixed-name scans, hard-linked scratch, short/zero writes, fsync/ENOSPC
failure, exclusive conflicts, corrupt/future records and SIGKILL at publication
boundaries. Children have finite lifetimes, bounded output and awaited cleanup.
Trusted `io`/`fault` injection exists only for internal failure tests; it is not
request-selectable authority or a production allocation adapter.
