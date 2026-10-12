# Disabled Darwin journal native bridge

The broker's existing [fixed-v1 journal](owner-decision-journal-core.md) has an
explicit, trusted `nativeBridge:true` constructor option. It uses the same
frames, fixed names, typed graph, lock and recovery methods; it adds no route or
capability advertisement. `authorizationSupported` and
`physicalAllocationSupported` remain **false**. This is an integrated disabled
primitive, not a supported physical-capacity backend or R1–R4 acceptance.

## Fixed artifact boundary

`lib/platform/owner-journal-native.mjs` loads only the adjacent
`native/owner-journal-darwin-helper-{arm64|x64}` executable, its `.json` manifest
and `owner-journal-darwin-helper.c`. There is no executable path option,
environment/PATH lookup, runtime compilation or fallback after native refusal.
This repository commits source, not a production executable/manifest. Missing
artifacts refuse before opening or creating journal state.

The exact manifest fields are `v:1`, `platform:"darwin"`, architecture matching
the running process, `minimumMacOS:"13.0"`, lowercase SHA-256 `sourceSha256` and
`binarySha256`, and printable ASCII `compiler` and `sdk` strings of 1–512 bytes.
Manifest/source/binary limits are 4096/65536/1048576 bytes. Every file must be a
regular, non-symlink, single-link file owned by root or the broker UID, without
set-ID/sticky bits or group/world write permission; the binary must have an
execute bit. Existing trusted-ancestry checks allow only root/broker-owned
ancestors and their established sticky-directory exception. These package
rules deliberately differ from strict broker-owned 0700/0600 state custody.

The bridge snapshots the exact manifest digest and all three file identities,
metadata and hashes. It revalidates them before and after every invocation;
replacement or changed provenance refuses even if executable bytes still match.
The manifest is trusted installation input, not independent binary attestation.
Reviewed reproducible arm64/x64 builds, pinned compiler/SDK provenance, installed
artifact integrity and the actual macOS 13 runtime matrix remain packaging
prerequisites. A deployment target and manifest string do not prove that matrix.
A nonroot broker loading root-owned artifacts is permitted by the code but was
not exercised here; no privileged installation change or sudo was used.

## Descriptor protocol and lock lifetime

The helper accepts no command-line arguments. Stdin is exactly 65 bytes:
`ODJNAT01` at bytes 0–7; operation 1 (initialize) or 2 (flush) at byte 8;
slot 0 for initialize or the fixed broker slot ID 1–11 for flush at byte 9;
zeros at 10–15; lowercase UUIDv4 request ID at 16–51; zeros at 52–63;
GO byte `0xa5` at 64, followed by EOF. IDs 1–10 follow the broker slot table in
the [fixed-slot contract](owner-decision-journal-fixed-slots.md); ID 11 is scratch.
This internal helper protocol changes no signed wire bytes.

Inherited FDs are lock 3, store directory 4, request directory 5, and all eleven
slot FDs 6–16 for initialize, or selected slot FD 6 for flush. The helper checks
types, owner/mode, link count, exact EOF and device/inode identity before
mutation. It binds `.journal-lock` to the store FD, opens only fixed `requests`
under that FD, verifies its custody and same volume, and binds the validated UUID
component to the inherited request FD. Every slot is compared with its exact
fixed name through `fstatat(...,AT_SYMLINK_NOFOLLOW)`. Files are broker-owned
0600, single-link, read/write without append; directories are broker-owned 0700.
The filesystem must identify as APFS. No arbitrary path or general syscall RPC
is available.

The child inherits the parent's **same open-file description** for the lock,
checks its identity, and never unlocks it. All unrelated descriptors are closed;
selected descriptors are marked close-on-exec. The single-threaded child uses
`proc_pidinfo(PROC_PIDLISTFDS)` on its own PID with a fixed 4097-entry buffer.
Failure, saturation, misaligned byte count, negative or duplicate descriptors
refuse. It closes every listed unrelated FD, then enumerates again and requires
only the fixed retained descriptors and standard streams. No asynchronous
opens occur between lists. Existing high FDs can survive a lowered soft limit;
the list, rather than that limit, establishes closure. The
[macOS 13-era XNU implementation](https://github.com/apple-oss-distributions/xnu/blob/xnu-8792.61.2/bsd/kern/proc_info.c#L487)
returns copied-entry bytes and exposes saturation at the caller's buffer bound.

An independent soft-limit ceiling of 1,048,576 still refuses larger limits
before mutation. Current Node raises that limit to 1,048,575 despite the shell's
4096 limit. An initial 65,536 ceiling refused with stage 1/errno 45; that finding
was retained. Raising the ceiling did not establish descriptor closure: review
identified the lowered-limit gap and the actual-list implementation replaced
the earlier scan.

After validation the helper emits READY, consumes GO and EOF, revalidates, then
performs the requested primitive. EOF, extra bytes, changed identity or an
already orphaned initial parent PID refuse. Parent identity is rechecked before
mutation and flush; the inherited lock remains held even after parent death
until the child exits. The synchronous adapter sends complete bounded input,
limits output to 512 bytes and requests SIGKILL after ten seconds. It waits for
confirmed child terminal before returning, so the parent never releases its
lock while the helper is still running. An uninterruptible kernel call can
outlast that deadline; early unlocking is not a safe timeout alternative.

## Initialization, full flush and recovery

Initialization exclusively creates all eleven actual final names at EOF zero,
then flushes the names before invoking the helper. The helper requests
`F_PREALLOCATE` with `F_ALLOCATEALL | F_ALLOCATEPERSIST`, `F_PEOFPOSMODE`, offset
zero and each exact framed cap. It sets the final EOF, writes all zeros, requests
`F_FULLFSYNC`, and reads back every byte while requiring allocated blocks to cover
that cap. It then fsyncs the request directory, requests another file
`F_FULLFSYNC`, and rechecks all names/identities/EOFs. The parent closes every
owned FD, flushes the directory and rereads all initialized slots before writing
the original action. Partial creation/allocation remains a fully charged spent
orphan; no retry, cleanup or capacity inference follows a failure.

Header/body publication, trailer publication and each explicit recovery slot
flush use the same helper's selected-FD `F_FULLFSYNC`. A refusal has no weaker
Node fallback. Node directory fsyncs and existing exact readbacks remain; a
visible valid frame does not prove completed flush. Reopen still requires
explicit recovery, which validates all slots before and after flushing. Close
failures attempt each remaining owned close once, preserve the first failure
and poison the instance; unknown descriptor state is never treated as success.

Apple's [fcntl documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)
and [macOS 13-era XNU header](https://github.com/apple-oss-distributions/xnu/blob/xnu-8792.61.2/bsd/sys/fcntl.h)
define these primitives. Here “completed flush” means the requested syscall
returned success. It does not mean measured power-loss persistence. Preallocated
data blocks and APFS identity do not prove future metadata capacity, copy-on-write
capacity, snapshot behavior, replacement capacity or universal disk-full
success. Existing allocation lab evidence and the physical-support prerequisites
remain unchanged. Observation replacement is still a separate contract/core gap.

## Fixed failures and validation

Each helper reply is 32 bytes: `ODJNRES1`, status (0 READY, 1 completed, 2 refused),
stage, slot, one zero byte, uint32 big-endian errno, then sixteen zeros. Success
requires exactly READY plus completed, zero numeric diagnostic fields, exit zero
and empty stderr. Refusal stages are 1 descriptor/stat/limit, 2 lock, 3 allocation,
4 EOF/write, 5 full flush, 6 directory flush, 7 readback, 8 custody/identity and
9 protocol/parent. Numeric diagnostics remain internal. Missing/unusable
artifacts map to `owner-decision-unsupported`; storage-time failures map to
`storage-failed` without paths, provider text or fabricated lifecycle outcomes.

Run `node --test tests/owner-decision-journal-native.test.mjs`. Darwin tests compile
only isolated synthetic artifacts under private temporary directories. They
exercise real allocation/full flush/recovery, fixed protocol and custody
refusals, changed artifact bytes/identity/provenance, all-owned-FD cleanup,
compile-time synthetic ENOSPC/EIO failures, and actual SIGKILL publication
prefixes. A stopped READY helper retains the lock after parent SIGKILL; a
contender remains blocked until helper terminal. A test-only exec wrapper proves
FD 65537 exists before helper exec; bounded observation after READY confirms it
closed while fixed FD 6 remains, including after lowering the soft limit to
4096. A real overfull inherited descriptor list refuses before READY or mutation.
Measured enumeration plus eleven allocations/full flushes was approximately 0.3 seconds on this macOS 27 host, not a platform SLA.
Other platforms skip native tests; a privileged-current-owner smoke test skips
when not root and is not evidence of differing root/broker UID installation.
