# Proposed next experiment: precreated fixed-name slots

The [paired result](EVALUATION.md#paired-comparison-data-writes-succeed-publication-refuses)
requires a different publication primitive: data writes succeeded in reserved
inodes, but the first final-name hard link received ENOSPC. The next candidate
creates every final inode and directory entry **before admission**, then changes
only bounded bytes inside those files. This is a concrete experiment proposal,
not a selected production format or a physical-capacity claim.

## Admission and fixed layout

Under the existing broker admission lock, charge a surviving request directory
as a full spent-ID/orphan reservation immediately. Exclusively create the ten
final slot names and one scratch name before publishing acceptance. Use the
existing exact payload caps plus 256 framing bytes, request persistent complete
allocation, set each final EOF to its full framed cap, initialize the complete
file with zero bytes, and explicitly full-flush each file and its directory.
Verify allocation, identity and exact EOF by read-only reopen. A failure keeps
the complete charged prefix and never acknowledges, forwards or reuses the ID.
This does not make the multi-file initialization atomic.

The ten final slot entries and scratch remain unchanged for the request's
lifetime. There is no later link, rename, unlink, truncate, file creation,
metadata index append or extra scratch allocation on the transition path.
Namespace enrollment and global durable accounting must likewise be established
before admission; recomputing the request count by a bounded validated scan is
preferable to assuming a later index append will have space. Directory capacity
is tested at admission, never inferred from data extents.

## Candidate frame and commit order

The experiment can use this precisely bounded, test-only binary frame; no
atomic-sector or atomic-pwrite assumption is permitted. Integers are unsigned
big-endian, unused bytes are zero, and slot numbers use a fixed table matching
the ten contract slots.

| Region | Size | Contents |
| --- | ---: | --- |
| Header | 128 | magic `ODJSLOT1` (8), version (u16), slot (u16), flags zero (u32), payload cap (u32), payload length (u32), sequence (u64), context digest (32), payload SHA-256 (32), zero padding (32). |
| Payload | Slot cap | Exact canonical record/token bytes followed by zero padding to the fixed cap. |
| Commit trailer | 128 | magic `ODJCOM01` (8), version (u16), slot (u16), flags zero (u32), sequence (u64), payload length (u32), zero reserved (u32), frame SHA-256 (32), context digest (32), zero padding (32). |

Context digest is SHA-256 of canonical local
`{namespaceDigest,requestId,role,slot,v:1}`, with producer-owned role broker or
daemon. The retained lab source/evidence used role-free synthetic framing; this
corrected proposed context is distinct and enables no runtime. Payload digest covers only its exact
un-padded bytes. Frame digest covers ASCII `owner-journal-frame-v1\n`, then
the complete header and fixed padded payload. The trailer repeats bounded
identity/sequence/length fields; all repetitions must match. Immutable slots
use sequence 1 and refuse every subsequent write, including a changed duplicate.
These hashes detect torn/corrupt contents; they do not authenticate a malicious
same-account writer or promise that storage preserves every acknowledged byte.

For one immutable slot, require its initialized all-zero contents under the
request lock. Write the complete header and padded payload without changing EOF;
request `F_FULLFSYNC`; then write the commit trailer and request `F_FULLFSYNC`
again. Verify the whole frame by read-only descriptor before acknowledging that
step. Every short write, flush failure or integrity mismatch is a sanitized
storage refusal. Nothing proceeds to the next live protocol step after failure.
Original action precedes acceptance, proofs precede authorization, and release
still requires the existing live checks and durable ordering. Fixed filenames
remove the observed late hard-link operation, not the rest of these invariants.

## Recovery and bounded observation replacement

A complete validated graph is required; individual frame validity is insufficient.
All-zero initialized slots mean no committed record, never proof of no effect.
Nonzero uncommitted bytes, invalid framing, a mismatched context, unknown names,
wrong lengths or an impossible graph keep the ID spent and refuse progress.
There is no older permission-bearing image to select. A process crash after a
visible trailer but before its final flush cannot establish durable publication:
recovery must full-flush and revalidate before acknowledging even an identical
saved record, and never automatically forward, deliver, release or resume it.
If that recovery flush refuses, the record remains unsettled. Status remains
non-authorizing; absent completion cannot establish refusal.

The first experiment covers write-once slots only. Full lifecycle integration
also requires the existing replaceable observation and daemon preimage pair.
A bounded candidate uses the precreated full-cap scratch inode to retain the
complete next observation frame before overwriting its fixed destination.
Scratch keeps its physical EOF of 33024 bytes: the destination frame begins at
offset zero, its header cap must equal that destination's fixed contract cap,
its validated length is exactly that cap plus 256, and every remaining scratch
byte must be zero. It is a destination-bound embedded frame, not a second
independent scratch record or a caller-selected cap. Then
flush scratch, invalidate and flush destination trailer, write/flush destination
body, write/flush destination trailer, verify exact scratch/destination equality,
then zero/flush scratch. A crash or failure with nonzero scratch freezes ordinary
writes and preserves both images for bounded explicit recovery; it never falls
back to an older permission state. Recovery can validate and flush an identical
committed destination, or retain the pending scratch as evidence of an unsettled
replacement. It must not silently discard the newest observation or invent a
resolution. Daemon observation plus preimage must occupy one combined frame;
each paired payload cap is 4352, including two unchanged 2048-byte component
caps and at most 256 wrapper bytes, and fits scratch. Terminal record/preimage
likewise use one immutable paired frame; no separate preimage file publishes. The exact recovery API and latest-observation
availability semantics need review before claiming this replacement is complete.
Original entered/completed/refused evidence and terminal resolution stay immutable.

## Targeted next lab and production prerequisites

After separate resource/source review, a fresh bounded disposable APFS image
would precreate final-size zero-initialized final names, close/reopen them,
kill the owned child, detach/remount, and verify identities, EOF, zero contents
and allocated blocks. Fill before the first nonzero record write; retain exact
refusal syscall/errno. Commit every maximal frame in place with the two full
flushes above, retaining available/allocated-block observations and deterministic
readback. No reclaim or late directory operation is allowed. Child SIGKILLs
at body writes, body flush, trailer writes, trailer flush and immediately before
acknowledgement must yield either validated non-authorizing records after an
explicit recovery flush or a charged unsettled refusal. Separate corruption
and injected I/O failures must not revive an older success. Snapshot testing
is a separately authorized boundary, never a silent fallback or support claim.

APFS copy-on-write inode/extent/checkpoint updates can still fail under pressure
even when names and data extents exist. The candidate may fail. Passing this
bounded workload would not prove unconditional metadata capacity, arbitrary
snapshot tolerance, power-loss safety, 4096-request allocation, or macOS 13
execution. If the contract requires guaranteed later transitions under all such
conditions, preallocation alone cannot justify enabling that promise.

Production needs a reviewed native packaging boundary because Node exposes no
`F_PREALLOCATE` call. Prefer a minimal broker-owned Darwin helper with fixed
operations, bounds and no-follow descriptor validation, pinned source/build
provenance, supported architecture and actual macOS 13 tests. No shell protocol,
arbitrary path/command operation, new npm runtime dependency, daemon storage
access or daemon signing-key custody belongs in it. The binary distribution,
full-flush semantics, safe installed-helper identity and lock lifetime need
review before any production import.

The current proposed [recovery companion](../../../docs/owner-decision-journal-recovery.md#exclusive-publication-and-recovery)
describes exclusive publication from scratch by creating final names. A fixed
precreated-name backend would require a reviewed companion amendment replacing
that physical mechanism while preserving immutable logical publication and
all acknowledgement/order rules. The 256-byte framing allowance accommodates
this candidate; a logical metadata charge remains distinct from an actual
filesystem allocation guarantee. Existing disabled admission code is unchanged.
