# Review plan: one fixed-name APFS experiment

This test-only successor isolates the late-name publication failure in
[EVALUATION.md](EVALUATION.md). The one independently reviewed run completed; its
[qualified result](EVALUATION.md#fixed-name-successor-qualified-pass) preserves
the exact executed source and all limits. Further execution needs a separate
concrete question and independent review. It enables no
production helper, journal codec, acceptance, route, daemon access or authority.

## Exact invocation and retained resources

The proposed one-shot command is:

```sh
node tools/feasibility/apfs-journal/run.mjs --fixed-names --inventory /private/tmp/owner-journal-apfs-retained-fixed-v1.json
```

The reviewed inventory lists all five earlier attempt/preflight roots, including
both losslessly archived images and their immutable verification/removal receipts.
It never drops an earlier failure. The new unpredictable owned 0700 root is
printed before work. Exactly one fixed **64 MiB** UDRW APFS image is allowed;
there is no size, allocation, flush, snapshot or publication fallback. Existing
192 MiB per-root, 248 MiB aggregate, bounded output/command and ten-minute guards
remain unchanged. With reported retained live allocation 2441216 bytes, the
preflight worst-case allowance of 64+32+20 MiB remains below 248 MiB. Inventory
file blocks and unattributable host snapshots/metadata remain within the existing
explicit resource-accounting qualification and guard margin.

Journal names are exactly the eleven `<slot>.record` names plus the bounded
filler: at most twelve entries, each within 64 ASCII bytes. The volume identity
marker is separate. No reservation-name alias or transient publication name is
created. Controls are not repeated; this experiment tests the changed publication
mechanism under the same fill-to-refusal condition.

## Bytes, order and uncertainty

`fixed-allocator.c` includes the existing reviewed lab's identity, fixed-name
open, filler and allocation utilities with its entrypoint renamed. The new
entrypoint accepts only the explicitly listed fixed-name operations; no legacy
publication or snapshot operation is callable through it. Both C source hashes
and the exact runner hash are recorded before compilation. CommonCrypto's public
SHA-256 function is used only for synthetic fixture integrity; its deprecation
warning is locally suppressed around that call. No new dependency ships.

Slot numbers 1–11 follow the existing local table: acceptance, action, challenge,
presence, receipt, authorization, release, outcome, observation, resolution,
scratch. Payloads fill each exact contract cap with deterministic bytes. They
are deliberately **not canonical production records**. The binary frame follows
[NEXT-BACKEND.md](NEXT-BACKEND.md#candidate-frame-and-commit-order); context uses
canonical `{namespaceDigest:nonce+nonce,requestId:"00000000-0000-4000-8000-000000000077",slot,v:1}`
with the local slot alias. These test values do not name enrolled authority.

1. Exclusively create and fully preallocate every final inode, set final EOF, write its complete zero initialization and request direct `F_FULLFSYNC`. Close/reopen and verify zeros, cap, blocks and identity. Flush directories, then kill the owned child after ready.
2. Require zero contents, complete allocation and stable identities after that SIGKILL and after detach/remount. Fill to exact ENOSPC/EDQUOT refusal before the first nonzero record write. Recheck every initialized slot.
3. Commit maximal action: header/body write, full flush, trailer write, full flush and readback. Then write/flush maximal acceptance body and write its trailer, report ready **before its final full flush**, and SIGKILL the owned child.
4. Record `uncertain`, the exact last successful write/flush phase and last completed flush phase. Native and independent bounded Node readers may verify the visible frame, but every report still says `acceptanceEstablished:false, authority:false`. A valid visible trailer is never accepted as durable admission.
5. Invoke the separate explicit prefix recovery operation. It requests `F_FULLFSYNC` on action/acceptance and revalidates the prefix before reporting only `verified-nonauthorizing`. Any failure preserves uncertainty and ends the success path; there is no automatic forwarding, acceptance or effect retry.
6. Commit each other maximal test frame with the same two flushes. Native readback and independent Node grammar/context/hash/payload checks must agree. Detach/remount, require exact framed contents, allocation and inode identities again, then detach the exact verified image device.

The Node check independently validates endian fields, zero reserved bytes,
lengths, slot/sequence/context bindings, payload digest, domain-separated frame
digest and every deterministic payload byte. It is a bounded maximal-fixture
check, not an exported general parser. No all-crash-point, observation replacement,
actual canonical protocol or power-loss claim follows from this single run.

The terminal record retains `lastSuccessfulPhase`, `lastDurablePhase` and
`fixedPublicationOutcome`. Here phase fields refer to successful native journal
write/flush events; command records separately retain exact command completion,
refusal phase and errno. `uncertain` survives a failed post-kill recovery. Even
an observed pass ends as `verified-test-frames-nonauthorizing`. Failure retains
all bytes/logs and attempts only read-only observations plus verified detach.

If fixed-name writes or full flushes still receive ENOSPC, the candidate fails;
no reclaim or weaker operation follows. If it passes, it shows one changed
mechanism's bounded feasibility. It still cannot establish unconditional APFS
metadata/snapshot capacity, all 4096 requests, actual macOS 13 support, complete
replacement recovery, native distribution, or production physical reservation.
