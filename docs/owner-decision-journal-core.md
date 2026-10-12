# Disabled broker journal admission core

`lib/owner-decision-journal.mjs` is an internal, disabled implementation of only
the admission prefix in the [proposed journal contract](owner-decision-journal-capacity.md).
No broker route, capability discovery or daemon adapter imports it. It does not
reserve physical write capacity, authorize an operation or claim R1–R4 acceptance.
The default mode remains admission-only. Trusted fixed-v1 lifecycle mode now
adds the [typed storage graph](owner-decision-journal-lifecycle.md); observation
replacement and live coordinator composition remain prerequisites.

## Supported storage findings

`OwnerDecisionAdmissionStore(root, { namespaceDigest, format })` requires an existing,
private, owned 0700 directory in trusted ancestry. Its digest must come from the
future independently enrolled stable broker namespace, never a request field.
Enrollment remains a prerequisite; tests use a synthetic digest.
`format` is trusted constructor configuration:
`"scratch-v1"` remains the default existing experiment, and `"fixed-v1"` selects
the fixed-name experiment. Immutable namespace metadata pins digest and format.
Mismatches, inferred formats, conversion and mixed-format recovery refuse. Empty-root
construction creates only the lock, namespace and request-container directory.
Later calls validate these; missing established files refuse without recreation.

Methods are synchronous under one kernel lock:

- `admit(actionBytes, acceptanceBytes)` validates and snapshots the complete exact action and acceptance before creating a request artifact. It returns only `{requestId,finding:"admission-complete",duplicate}`. An exact duplicate reads the original bytes; changed bytes conflict. It does not forward or acknowledge any protocol preparation.
- `inspect()` returns retained-ID count, full logical reservation charge and bounded per-ID admission/orphan findings. `physicalAllocationSupported` and `authorizationSupported` are always false.
- `read(requestId)` returns absent/orphan/admission-visible/admission-complete and copies of any saved original action/acceptance bytes. `admission-visible` is specific to fixed-v1 and requires explicit recovery before duplicate acknowledgement. These findings never imply a lifecycle state, reusable permission or a mutation outcome.
- `recover(requestId)` is fixed-v1 only. It returns absent for an unknown ID, refuses an orphan, or explicitly flushes and revalidates a complete visible pair and all eleven initialized slots. Its admission-complete result always includes `authorizationSupported:false` and `physicalAllocationSupported:false`. It performs no delivery or effect.

Acceptance uses exact contract fields/types, bound to the action's request,
principal, account, soul, operation, original-byte digest and namespace. The reservation is exactly
262144 bytes, including future slots. Daemon/watch/epoch/time fields are structurally checked; current authority, enrollment and live deadline
validation remain the future caller's responsibility.

There are at most 4096 retained request directories. Empty/action-only interrupted
admissions consume a full reservation and permanently spend that ID. Capacity
refusal does not poison existing reads or exact duplicates. Corrupt or unknown
artifacts refuse writes; none are silently freed or reused. Later lifecycle slot
names explicitly return `owner-journal-unsupported-phase`; the core does not
accept opaque future records or fall back to an earlier permission state.

## Existing scratch-v1 framing and publication

The default scratch-v1 experiment frames exact payload bytes with a canonical
JSON `{bytes,sha256,slot,v:1}` header and LF. Header plus LF is at most 256 bytes;
action/acceptance/namespace payload caps are 32768/4096/4096 bytes.
This experimental format selects no wire encoding.

Its fixed `pending` scratch publishes through write-all, file fsync, exclusive
hard link, directory fsync, scratch unlink and directory fsync. `EEXIST` never
overwrites, even for identical bytes. Exceptions retain artifacts and require
reopen. Reads check bounded frames, exact schemas/digests, private regular-file
ownership/modes, identity and original bindings. Directory iteration is bounded.

Scratch and target hard links are separately charged names; replay deletes
neither. Any surviving scratch makes the ID an orphan and prevents duplicate
acknowledgement: visible links do not prove directory flush. Partial/unknown
scratch refuses recovery writes. Restart never forwards a complete saved pair.
No multi-file atomicity, mutation retry or missing-marker effect proof is claimed.

## Disabled fixed-v1 framing and publication

The fixed-name experiment implements the [proposed frame and slot set](owner-decision-journal-fixed-slots.md).
Its pure frame codec checks fixed cap/EOF, raw magic, primitives,
broker-role context/payload/frame digests, sequence 1 and padding. It reports snapshotted empty/uncommitted/committed integrity. The store separately
validates exact action/acceptance schemas and namespace/request/digest binding.

After charging and flushing the request directory, the disabled initializer
exclusively creates the ten final broker slot files and scratch inode, sets each
fixed EOF, writes its full contents as zeros, flushes/closes/reopens it, and
flushes the directory. It rechecks all eleven complete blank files before any
action write. These ordinary full-zero writes are test mechanics, **not persistent
physical reservation**. No allocator bridge or physical-support option exists.
Original-action and acceptance then publish in that order through positional
header/padded-body write, file fsync, trailer write, file fsync, close and exact
readback. Every destination must be a complete all-zero, private, regular file
with one link. No record creation, link, unlink, rename or truncate follows
initialization. This is multi-file ordering, not an atomic group.

Each store open starts without flush evidence. A valid visible pair is
`admission-visible`, never an implicit duplicate acknowledgement. `admit` refuses
that exact pair with `owner-journal-recovery-required`; different bytes conflict.
Explicit `recover` validates all eleven files, flushes each existing inode and
both request/parent directories, then revalidates the namespace, every name,
frame, schema and exact byte/inode stamp before recording success. Interrupted
recovery never resumes or forwards automatically. An orphan remains fully
charged and permanently spent; recovery cannot complete or rewrite it.

The volatile flush cache is instance-scoped and bounded by retained IDs. Every
operation still acquires the kernel lock and rereads the complete graph. Stamps
include every slot's device/inode, EOF, times and exact frame hash; changed
identity/bytes invalidates them. Reopening requires recovery again. Corruption, unsafe ownership/link/EOF, unknown names or any nonzero
unsupported lifecycle/scratch slot refuses; corruption/unsupported phase also
poisons that instance until reopen. No older success image is selected. Deleting
or shortening a blank slot leaves a spent orphan, never a recreated file. Cache
maintenance retires no durable IDs or evidence.

Storage errors retain the prefix and require reopen. A partial trailer write
can already equal its complete bytes when the unwritten suffix is zeros; visible
validity proves no final flush. Recovery requires its own successful flush.
The Node fsync caveat below precludes power-loss or unconditional-write claims.
In the default admission-only mode all later lifecycle slots must remain zero.
The trusted lifecycle mode validates every supported typed prefix. Nonzero
scratch and observation replacement/recovery remain unsupported.

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
operation schemas, byte snapshots, quota including orphans, short/zero writes,
exclusive conflicts, corrupt/future records and process interruption. Fixed-v1
covers initialized/admission/recovery phases, torn frames, explicit recovery,
inode/link/EOF checks and EIO/ENOSPC/EDQUOT at every flush boundary. Children
have finite lifetimes, bounded output and awaited cleanup.
Trusted `io`/`fault` injection exists only for internal failure tests; it is not
request-selectable authority or a production allocation adapter.
