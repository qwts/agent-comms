# Disabled broker enrollment metadata store

The [filesystem engine](../lib/broker/owner-enrollment-store.mjs) implements
bounded public enrollment metadata persistence for the
[reviewed codec](owner-enrollment-codec.md). It does not install keys, verify an
owner ceremony, consume native presence, sign receipts or enable authority.
Every returned view reports authorization, protected-producer availability,
installation provenance, native full-flush and physical allocation as false.
No broker route, readiness predicate or coordinator imports this engine.

## Fixed custody and capacity

The production wrapper has no arguments or environment overrides. It opens
`/Library/Application Support/AgentComms/owner-enrollment` without creating,
repairing, changing permissions or replacing anything. The root and its three
subdirectories must already belong to the actual non-root Darwin broker UID
with mode 0700. Files must be regular, nonlinked, broker-owned mode 0600.
Ancestors must satisfy existing broker custody checks. Missing, unknown,
symlinked, replaced or wrong-length entries refuse. The internal constructor's
path, I/O and fault seams serve trusted storage plumbing and disposable tests;
they are not wire operations or authorization callbacks.

The root contains exactly `.journal-lock`, `source.record`, `format`, `records`,
`audits` and `confirmations`. The existing zero-length lock inode stays held
through all synchronous scans, writes and flushes until close. Established open
uses existing-only acquisition: even a raced removal cannot recreate the lock.
File opens use `O_NOFOLLOW | O_NONBLOCK`, then compare named/opened identity.
Directories remain descriptor-bound; device, inode, ownership, mode, link count
and exact file lengths are rechecked. This is cooperative broker-account
locking, not protection from malicious code running as that same account.

`source.record` is canonical JSON, at most 4096 bytes, exactly
`{v:1,kind:"broker-owner-enrollment-source",namespaceDigest,service}`. Its service
is exactly `{platform:"darwin",brokerUid}` matching the actual UID. Its namespace
is lowercase SHA-256 hex. This self-consistent metadata binding does not prove
independently installed namespace or owner verification provenance. `format`
is exactly ASCII `broker-owner-enrollment-fixed-v1\n`.

| Directory | Fixed names | Payload cap | Exact slot length |
| --- | --- | ---: | ---: |
| `records` | `0001.record` through `1024.record` | 4096 | 4352 |
| `audits` | `0001.audit` through `1024.audit` | 512 | 768 |
| `confirmations` | `0001.confirm` through `1024.confirm` | 512 | 768 |

All final names and full-length zero slots must already exist. There are 3072
slot entries and 3078 named entries including the three directories and three
root files; directory entries count separately from inode allocation. Framed
slots total 6,029,312 bytes, plus bounded source/format/lock and OS metadata.
There is no scratch, rename, link, unlink, retirement or extra generation.
Revision 1024 remains reserved for terminal revocation; no reset or fallback
recovers capacity. These are logical bounds, not a physical reservation claim.

## Exact frame

Each slot is a 128-byte header, its full payload-cap body, and 128-byte trailer.
Only an exact full-length all-zero slot is unused. Integers are big-endian.
Kind IDs are record 1, audit 2, confirmation 3; revision is 1–1024.

| Header offset | Exact value |
| --- | --- |
| 0–7 | ASCII `BOENFR01` |
| 8, 9, 10–11 | version 1, kind ID, uint16 revision |
| 12–15 | uint32 canonical payload length, 1 through cap |
| 16–47 | raw 32-byte namespace digest |
| 48–79 | SHA-256 of exact payload bytes |
| 80–111 | context digest |
| 112–127 | zero |

Context is SHA-256 of ASCII
`agent-comms-broker-owner-enrollment-frame-v1\n`, raw namespace, uint16 revision,
uint8 kind and uint32 cap, concatenated in that order. Payload bytes follow the
header; every remaining body byte is zero. The trailer has magic `BOENCM01`,
the same version/kind/revision/length at offsets 8–15, SHA-256 of the complete
header and padded body at 16–47, context digest at 48–79, payload digest at
80–111 and zero at 112–127. Typed decoding separately cross-checks exact kind,
namespace and revision. Enrollment/revocation share kind 1; the unchanged codec
enforces their transition rules. This domain cannot validate a journal frame.

Nonzero incomplete, corrupt, wrong-context or wrong-typed slots refuse the
whole store. A valid visible trailer proves structural integrity only.
No older active prefix is returned on an uncertain suffix. Hashes cannot detect
a consistent rollback or replacement of the entire installation history.

## Separate transaction phases

`inspect()` only scans. `recoverConfirmed()` explicitly flushes retained
source/format, nonzero frames and directory descriptors, then scans again;
any changed byte or inode refuses. It never creates audit/confirmation evidence
or resumes a ceremony. Open alone does not establish completed requested flush.

`beginIntent(expectedHeadDigest, recordBytes)` requires an explicitly recovered
complete prefix and exact current head. It validates the prospective codec
transition, publishes the immutable record, and only then returns an opaque
one-use intent handle. A future trusted ceremony must durably establish this
intent **before** consuming its native one-use challenge. `recordAudit(handle,
auditBytes)` publishes the exact linked audit and returns a new one-use audit
handle. `confirm(handle, confirmationBytes)` validates and publishes the linked
confirmation. Handles bind the exact transaction, revision, record digest,
phase and complete captured storage fingerprint. They cannot be reconstructed
from public fields, replayed, moved to another instance or resumed after exit.
There is deliberately no API that appends all three records in one call.

Each publication writes the header and complete padded body, requests file
`fsync`, writes the trailer, requests file `fsync` again, closes once and scans
every slot. Exactly the selected slot may change; all other frame hashes and
cached identities must remain unchanged. Failures poison the instance and
retain every byte and name. No success can follow uncertain close state.
Cleanup attempts every owned descriptor once, retaining the sanitized failure.

A complete visible chain after restart still needs explicit recovery before
an exact duplicate can acknowledge the recorded transaction. A duplicate
compares exact record bytes and its original expected head and performs no
write. Conflicting reuse refuses. A pending record or record-plus-audit freezes
all writes and confirmed recovery. An interrupted challenge consumption, audit
or confirmation must not automatically reconsume, reenroll, refund, delete or
restore prior authority. A future authenticated native transaction-reconciliation
producer must distinguish consumed, unconsumed and uncertain results for that
exact intent. This slice supplies no recovery handle from an audit ID or digest
alone; pending recovery remains explicitly unsupported.

Public errors are fixed storage-failed, busy, recovery-required, pending,
conflict, capacity or invalid-phase codes prefixed `owner-enrollment-` (the
phase code is `invalid-owner-enrollment-phase`). They contain no paths, payload,
syscall text or secret material. Structural state is not current authority.

## Validation and remaining integration

Tests use actual disposable files and the Darwin lock. They exercise every
publication SIGKILL boundary with an exact emitted fault marker, syscall and
flush failures, short I/O, close-once cleanup, inode/byte replacement, malformed
and pending prefixes, explicit duplicate recovery, contention and all 1024
revisions. Pure frame tests reject every truncation and one-bit corruption;
independent Python framing also matches the four public fixture payloads.
These tests qualify process-crash behavior and completed requested Node flushes,
not power loss, macOS 13 runtime or durable physical allocation.

Production integration still requires independently protected installation
identity and native verification pins, a fixed authenticated owner ceremony and
one-use transaction reconciliation, native private receipt storage/signing
outside JavaScript, descriptor-bound native full-flush/allocation packaging and
OS metadata capacity evidence. The current journal helper's fixed slot protocol
does not cover these names. No installer or compiled helper is invoked here.
The store cannot satisfy runtime readiness until those boundaries are reviewed
and implemented; ordinary owner-decision ingress remains unavailable.
