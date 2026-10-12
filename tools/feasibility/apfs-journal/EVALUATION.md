# APFS final-inode allocation: retained results

The first corrected **single no-snapshot attempt passed its defined checks** on
macOS 27.0.1 build 26A434, arm64, with Apple clang 21.0.0 and Node 24.19.0 /
libuv 1.52.1. This advances feasibility only. It does not enable production
admission or establish macOS 13, snapshot, whole-store metadata or power-loss
support. The [source and resource plan](README.md) remain test-only.
The later paired comparison isolated data-write benefit but **failed exclusive
publication with ENOSPC**. Thus final-inode data preallocation is insufficient
for the current hard-link publication scheme.

## Retained attempts

The initial attempt at 2026-10-12 03:22:26 UTC exited 1 before image creation.
Compilation/linking succeeded, but `hdiutil create -format UDRW` was invalid
without source data. The installed manual/help documents blank-image
`-type UDIF` as fixed read/write UDRW. The corrected command received explicit
review for one further attempt; there was no automatic retry or fallback.
The original result remains at:

```text
/private/var/folders/w9/qmhxw8jx00d7tg6fxlyfbxgr0000gp/T/owner-journal-apfs-f2edefb7-0144-44fa-81b9-c128188a9df8/results.jsonl
```

The corrected run used terminal session 80959, started at 03:23:42.427 UTC and
finished at 03:24:01.605 UTC on 2026-10-12, exit 0. Its 128 MiB fixed UDRW APFS
image and full failure/success records were retained at terminal under:

```text
/private/tmp/owner-journal-apfs-90f39813-6e22-4ed2-abee-90edfbdec6fa/
```

The exact image-backed whole device `/dev/disk6` was detached and its absence
from `hdiutil info` confirmed. No attachment uncertainty remained. No snapshot was run. The later comparison is recorded separately below. Global `hdiutil info` output can contain unrelated
system image paths; raw local logs are not a portable publication artifact.

## Measurements and checks

| Synthetic framed capacity | Count | Allocated bytes per inode |
| --- | ---: | ---: |
| 4096 + 256 | 6 | 8192 |
| 32768 + 256 | 2 contract slots + scratch | 36864 |
| 2048 + 256 | 2 | 4096 |

All ten exact broker slot caps matched the shared journal-budget fixture.
Including the separate full scratch inode, total observed file allocation was
**167936 bytes**. Inodes 18–28 retained identity and full allocation at EOF zero
after close/reopen, owned-child SIGKILL and detach/remount. The same allocations
remained after the following operations:

1. The fixed filler reached the program's ENOSPC/EDQUOT refusal branch at 118489088 bytes, before the first payload writes.
2. All eleven inodes received maximum-length generation-one contents, then whole-file generation-two rewrites under that low-space condition. Every requested `F_FULLFSYNC` succeeded; no weaker fallback exists in this native probe.
3. All ten record names published through exclusive links, directory fsync, reservation-name unlink and directory fsync. Scratch remained separately reserved.
4. A final detach/remount preserved exact maximum lengths, inode/allocation identity and every deterministic generation-two byte, verified through read-only descriptors.

Maximum reported task-owned live allocation was **134631424 bytes**, below
the 192 MiB guard and 256 MiB ceiling. The original no-image failure retained
86016 allocated bytes. No existing volume was filled or changed.

## Limits that affect the recommendation

The no-control source recorded neither the precise errno nor whether the
write or full-flush operation returned it. Its source accepts only ENOSPC or
EDQUOT there. Immediately afterward, `statfs` still reported 3445 available
4096-byte blocks (14110720 bytes). Consequently this is an observed allocator
refusal, not proof of zero remaining reported space or reserved future metadata.
No unreserved-inode control was run, so this result alone does not quantify the
benefit against identical operations without preallocation.

The journal's ten framed slots plus scratch are physically larger than their
unrounded payload/framing sum. Filesystem allocation and logical accounting
must remain distinct. This one-request test does not measure 4096 request
directories, root index growth, global metadata, all lifecycle crash points,
observation replacement generations, snapshots or other producer staging.
APFS metadata still uses copy-on-write, and a successful extent reservation
does not guarantee subsequent directory/checkpoint transactions.

These limitations motivated the separately reviewed 64 MiB comparison below.
The no-control pass alone supports a final-inode allocation candidate, not a
shipping backend. Every additional image must respect the total retained
resource budget. There is no automatic new run, snapshot, deletion or reclaim
policy.

The first separately authorized paired-comparison attempt refused before
compilation or image creation: its bounded inventory scan encountered more than
65536 entries in a shared temporary parent. Its primary `lab-parent-scan-ceiling`
record remains at `/private/tmp/owner-journal-apfs-e72d2dda-5fea-47bd-ae43-d39951ae36b2/results.jsonl`.
Final reporting rethrew the same measurement error; no terminal JSON record was
written. This is a lab inventory failure, not an allocation result. The reviewed
correction uses an explicit bounded retained-root manifest and preserves primary
failure reporting when allocation is unknown. No failed attempt was deleted.

No-control tested source SHA-256 values:

```text
c8ff3a1e6fe30037503d45b121f346be92d9eabd62d7c870682e1c36158272ea  allocator.c
c34683580d7c62da11540f2242904cd46ce628dcf049046a407be9b2a920c597  run.mjs
```

## Paired comparison: data writes succeed, publication refuses

The reviewed corrected comparison ran once, session 4903, from
2026-10-12 03:35:14.911 to 03:35:32.106 UTC. It exited 1 and retained its fixed
64 MiB image and all artifacts at terminal at:

```text
/private/tmp/owner-journal-apfs-d2d00fbf-0fa1-4785-bfbf-668d313cbd36/
```

All prior attempt/preflight roots were listed in a reviewed bounded manifest.
Aggregate reported retained live allocation finished at **202305536 bytes**,
below the 248 MiB guard and 256 MiB ceiling. The exact image-backed device was
detached and absence confirmed. No attachment/allocation uncertainty remained.
The source did not change during the run; frozen source copies and SHA-256
values are retained in `evidence/comparison-tested-source/`:

```text
e35e7ac51bf4492280672d53e4e71d738604be772d602501a75ef496b2066111  allocator.c
ff8183057e9c5f98e5168ffc3e693663327d8ffa2c3064989d235a2bfd5ed971  run.mjs
```

The sequence retained eleven preallocated inodes, eleven unreserved controls
and one filler, with no reclaim. The filler received **write ENOSPC (errno 28)**
at 64487424 bytes. Immediately afterward, and before/after the control group,
`statfs` reported 392 available 4096-byte blocks (1605632 bytes).

- All eleven unreserved controls received **pwrite ENOSPC**, wrote zero bytes, and retained EOF zero/zero allocated blocks.
- All eleven preallocated slots then completed their first maximum-length writes and full flushes, followed by whole-file generation-two rewrites and deterministic content checks. Their inode identities and allocated blocks stayed unchanged. Available-block observations remained 392.
- The first publication, acceptance, received **linkat ENOSPC (errno 28)** before creating a final name. The run stopped, retained all records/reservations/filler and performed read-only observations plus verified detach. No final published remount/content verification is claimed for this failed run.

The controls ran first on the same volume. Because they wrote zero bytes, their
attempts did not consume payload allocation; this is still an ordered trial,
not an independent counterbalanced experiment. It demonstrates data allocation
value under this tested condition and a concrete metadata publication failure.
It proves neither universal causality nor future directory/checkpoint capacity.
No fallback, snapshot, reclaim or additional attempt followed.

## Portable evidence and reproducibility

The four attempt JSON files under `evidence/` preserve selected owned native output,
observations, exact refusal/cleanup records and original raw-log SHA-256 values.
They omit global `hdiutil info` inventories and local command argument paths.
The no-control source archive matches the captured source hashes above exactly;
the paired source archive was copied before its run. Archived runners preserve
their original relative fixture path and must be restored with their matching
C source to this directory to reproduce, rather than run from the archive path.
No disk images, executables, raw global inventories or credentials are published.
The native allocator remains the tested paired version. The current runner has
a later bounded archive/verification-receipt accounting change; the frozen
comparison runner records the exact executed version. Its inventory must include
all retained roots from previous runs before a further reviewed invocation.
Source hashes were captured for the completed native runs; the two earlier
pre-native refusals retain their exact command/error evidence, not a claim of
a captured full source snapshot.

The next candidate and its explicit contract/packaging prerequisites are
[precreated fixed-name slots](NEXT-BACKEND.md). This is a design for review,
not an implemented backend or authorization for another lab run.

## Verified archival without removal

The separately reviewed archive-only command, session 28279, exited 0. Both
original images remained unchanged and detached through verification. Each archive passed complete
streaming decompression, gzip integrity/EOF/no-trailing-member checks, exact
restored length and SHA-256 equality to its original; the original was reread
and its identity/stat fields checked afterward. The portable
`evidence/archive-verification.json` contains both receipts and compressed
hashes. No disk image or archive is committed to this repository.

| Image | Original/decompressed SHA-256 | Gzip bytes |
| --- | --- | ---: |
| 128 MiB | `33cd8c2a33810128757807de987f4c6cd2571d4e8275d41cecc590f7d54496fc` | 1063497 |
| 64 MiB | `724dcf37003b95d7c2e3e983c7ac9bcd681431dde2e92411d78b696098e7e2d6` | 379520 |

Final aggregate reported live allocation including both originals and archives
was **203759616 bytes**, below the 244 MiB archival guard and unchanged 248 MiB
lab ceiling. No reclaimed-space claim followed from compression alone. After independent
review of both receipts and independent full decompression, a separately
authorized removal command rechecked detached status, exact original identity
and hash, and archive hash. It removed only the two original `journal.dmg` files,
retaining both lossless archives and all logs. The original verification receipts
remain immutable; separate `evidence/archive-removal.json` records this later
action. Aggregate reported live allocation became **2441216 bytes**, a net
reduction of **201318400 bytes** after the two new removal receipts. This is
lossless archival of the failed attempt too; it discards no experimental bytes. Raw logs, sources and failed attempts stay
retained. Per-file allocation still excludes unattributable host snapshots and
outer filesystem metadata.
