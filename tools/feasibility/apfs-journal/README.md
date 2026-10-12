# Disabled APFS journal allocation lab

This test-only experiment examines the physical reservation prerequisite for
[the proposed journal](../../../docs/owner-decision-journal-capacity.md).
Nothing imports it from runtime or the ordinary test suite. It changes no
existing volume, owner-decision route, daemon state, enrollment or authority.
The experiment can fail; failure is retained evidence, not an invitation to
substitute a weaker allocation or flush operation.

## Explicit invocation and resources

After source review and release of any coordinated workload hold:

```sh
node tools/feasibility/apfs-journal/run.mjs --inventory /absolute/path/retained-roots.json
```

The runner compiles `allocator.c` using `/usr/bin/clang`, then creates exactly
one **128 MiB UDRW** APFS image using `hdiutil create -size 128m -layout NONE
-fs APFS -type UDIF -nospotlight`. Apple's installed manual specifies that
empty-image `-type UDIF` creates fixed read/write UDRW; `-format` applies to
conversion from source data instead. It uses no sparse image, shadow, resizing,
overwrite option, existing device or credential/data path. Its unpredictable
owned 0700 root is `/private/tmp/owner-journal-apfs-<UUID>` on this host; the
actual path is printed before work. The image and all failed artifacts remain.
There is no automatic cleanup/deletion or retry.

The image's logical size must stay at most 144 MiB and its reported allocated
blocks at most 160 MiB. The executable and compiler temporary directory each
have an 8 MiB allocated ceiling; results are capped at 4 MiB. Total reported
task-owned live allocation is capped at **192 MiB**, below 256 MiB. The runner
checks during commands every 250 ms. This is a ceiling on measured live files;
outer APFS metadata and blocks retained by external host snapshots cannot be
attributed or bounded through per-file `st_blocks`. A disk image is an inner
filesystem test, not proof of physical allocation on the host backing volume.
The runner refuses to start with less than 512 MiB reported host availability;
this is a lab guard, not production reservation evidence.
The required reviewed inventory is an owned 0600 regular file, at most 16 KiB,
with exact `{v:1,roots:[...]}` fields. It lists all prior task attempt/preflight
roots from operation receipts; omission invalidates the resource claim. Including
the new root, at most 16 canonical, private owned 0700 roots with this task's
fixed name grammar are accepted. No unrelated temporary directories are scanned.
Combined live allocation stays below 248 MiB. Before creation, the maximum image
and 20 MiB helper/build/results allowance must fit that ceiling. It never deletes
a previous attempt to obtain space. Separately reviewed lossless archival can
retain verified compressed evidence with explicit removal receipts; the runner
counts these artifacts too and never performs archival itself. Terminal reporting retains the primary
failure and reports unknown allocation if a measurement itself refuses.

Each command has a 60-second timeout, except reservation child 30 seconds,
fill 180 seconds and detach 30 seconds. The overall command deadline is ten
minutes. Each command retains at most 64 KiB stdout and 64 KiB stderr. Owned
child processes are killed and awaited on timeout/output/allocation violations.
Filler is one fixed file, bounded at 128 MiB, and writes only to the verified
disposable filesystem. Failure to reach ENOSPC/EDQUOT by that ceiling fails the
experiment. It never fills the host filesystem.

Before native operations, image ownership is verified through `hdiutil info`,
the mountpoint through `diskutil info`, and its APFS type, device, UUID and
private identity marker are checked. Native operations use no-follow directory
descriptors and fixed names. Only this invocation's exact verified image-backed
whole device can be detached; no force detach is used. Unknown attachment
shapes or failed detach remain explicitly uncertain, with artifacts retained.

## Experimental sequence

The ten broker slots use exactly the contract's payload caps plus 256 framing
bytes; the runner compares them against `journal-budget-v1.json`. One additional
scratch inode reserves 32768+256 bytes. Fixed reservation/final names are at
most 64 ASCII bytes. Reservation, filler and transient publication links stay
within the existing 24 named-file limit. These are synthetic maximal byte
patterns, not accepted production record encodings.

1. Create each future inode exclusively and request `F_ALLOCATEALL | F_ALLOCATEPERSIST` through `F_PREALLOCATE`. Do not truncate or write its payload. Require returned allocation at least its complete framed cap, then request `F_FULLFSYNC` with **no fallback**. Close/reopen and record inode, EOF and allocated blocks.
2. The child reports ready only after closing all reservation descriptors and flushing their directory. Kill that owned child with SIGKILL. Observe all ten slots plus scratch, requiring unique expected names, EOF zero and `st_blocks * 512 >= payloadCap + 256`.
3. Detach/re-attach the same image, verify the same volume UUID, and require identical per-slot inode identities and retained allocations. Device numbers may change after reattachment.
4. Fill the disposable filesystem to ENOSPC/EDQUOT **before the first payload write**. Repeat EOF-zero allocation observations. Write every slot and scratch to its maximum length with deterministic generation-one bytes and full flush, then rewrite the entire maximum length with generation-two bytes under the same low-space condition.
5. Publish each of the ten records by exclusive hard link, directory fsync, reservation-name unlink and directory fsync. The scratch inode stays separate. Observe inode/allocation identity; detach/re-attach again and verify exact maximum lengths and every deterministic generation-two byte, not only file statistics.

Any syscall, allocation, length, identity, content or flush failure ends the
success path. The runner attempts read-only observations and a verified safe
detach, preserving all files and logs. It does not reclaim filler to make a
later step pass. Full flush failure—including unsupported full flush—is an
explicit negative result. No process-crash or remount result is a power-loss
claim. Actual macOS 13 execution remains required before claiming its support.

## Optional snapshot boundary

`--snapshot` is an explicit separate invocation, never an automatic fallback.
It calls `fs_snapshot_create` on the already verified disposable filesystem's
root descriptor after generation one and before generation two. Apple requires
appropriate privileges and entitlement for snapshot operations. This lab never
uses sudo or adds entitlement workarounds: EPERM/unsupported/no-space is a
retained negative result, and no successful snapshot test is claimed. It never
snapshots, deletes snapshots from, or changes an existing host volume.

## Explicit paired comparison

Adding `--comparison` to the explicit inventory invocation selects exactly one
fresh **64 MiB** fixed image, with the same
allocation flags, full flush and identity checks; it cannot combine with
`--snapshot`. The first 128 MiB successful image remains retained. Creation
does not silently fall back to a larger image if 64 MiB is unsupported.

The comparison creates eleven reserved inodes and eleven unreserved control
inodes at EOF zero, plus one filler: 23 named entries. Exclusive publication
temporarily reaches 24. Each group uses the same ten contract slot capacities
plus scratch. Control baseline requires zero allocated blocks, and the reserved
group requires its complete allocation. After the common filler refusal, run
the **unreserved group first**, then reserved first writes, with no reclaim.
Retain exact refusal errno/syscall, requested/written bytes and before/after
allocated blocks for every control. Record available blocks before and after
each group. A control ENOSPC/EDQUOT refusal is an observed comparison outcome;
other I/O errors stop the experiment. The reserved group retains ordinary
fail-closed behavior. Then continue the reviewed rewrite/publication/remount
checks only if it succeeds.
Control completion also requires exact deterministic content readback; a full
write alone cannot report completion.

This is an ordered same-volume comparison. Partial control allocations remain
and can increase pressure for the later reserved group, so the groups are not
independent identical-state trials. If both groups pass, no allocation
causality is claimed. Independent counterbalanced trials require a separately
reviewed resource plan. The one reviewed comparison and all retained failures are recorded in
[EVALUATION.md](EVALUATION.md). Further execution requires separate review;
this optional code never starts another experiment automatically.

## Primary primitive references and limits

[The macOS 13-era XNU header](https://github.com/apple-oss-distributions/xnu/blob/xnu-8792.61.2/bsd/sys/fcntl.h)
defines the allocation flags; [the syscall handler](https://github.com/apple-oss-distributions/xnu/blob/xnu-8792.61.2/bsd/kern/kern_descrip.c#L3055)
passes them to the filesystem allocator. Apple's SDK `fcntl(2)` manual warns
that a filesystem may ignore persistence, which is why close/remount checks
are required. [Apple's APFS reference](https://developer.apple.com/support/apple-file-system/Apple-File-System-Reference.pdf)
describes copy-on-write metadata: file allocation alone does not reserve all
future directory/B-tree/checkpoint transactions. Neither measured blocks nor
this bounded experiment guarantees future writes under arbitrary snapshots,
other activity or hardware failure. Production backend selection, crash format,
metadata bounds and full lifecycle integration remain separately reviewed work.
There is no automatic extent-transfer alternative in this first experiment.

The initial 2026-10-12 attempt stopped at image creation because the command
incorrectly used `-format UDRW` without source data. No image was created;
compile/link passed, and the failure log remains under its unique attempt root.
The documented `-type UDIF` correction received separate single-run review;
it is not an automatic fallback or an erased failure.

## Explicit archive-only utility

`archive.py --archive-reviewed-images` is a separate, operation-specific utility
for the two exact reviewed detached synthetic image paths. It never mounts,
fills, deletes, overwrites or retries. It exclusively creates owned 0600 gzip
archives and verification receipts, with 32 MiB per-archive and 40 MiB combined
archive bounds, a 244 MiB all-root live guard and 300-second deadline. It verifies
complete decompression/hash/length/integrity/EOF and rereads each unchanged
original. Failure retains partial output. The paths and all five retained roots
are deliberately explicit; another operation requires reviewed changes.
The runner recognizes these bounded fixed archive/receipt names for future
accounting, including failed receipts. They never establish production authority
or permission to delete an original. See the retained archival receipts in
[EVALUATION.md](EVALUATION.md#verified-archival-without-removal).

`remove-archived.py --remove-reviewed-originals` implements the separately
reviewed operation for only those same two hardcoded original paths. It first
validates both unchanged original identities/hashes and archive hashes against
the immutable verified receipts, rechecks detached status, then removes those
originals and exclusively writes separate removal receipts. It does not remove
archives, logs or other attempts. This command requires its own explicit review;
archive verification alone is not deletion authority. There is no automatic
invocation, retry, path discovery, or untrusted-path deletion.

The separately reviewed [fixed-name successor plan](FIXED-NAMES.md) prepares
one bounded 64 MiB experiment. Its optional `--fixed-names` mode cannot combine
with comparison or snapshot modes; no execution is implied by source presence.
