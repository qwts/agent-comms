# Proposed bounded broker observation recovery

This proposed [fixed-slot amendment](owner-decision-journal-fixed-slots.md)
applies only to the broker; daemon scratch-pending, sequence-1 framing is
unchanged. No runtime changes; authority/physical flags remain false. Joint
producer review precedes publication or code changes.

## Exact bounds and typed context

Broker destination D is slot 9, `observation-reference`, with a 2048-byte payload
cap and fixed EOF 2304. Scratch S remains its precreated single-link 0600 inode,
EOF 33024. S embeds the complete destination-bound 2304-byte frame at offset
zero, followed by exactly 30720 zero bytes. Nonzero tail padding invalidates the
whole scratch candidate; no embedded stored cap chooses allocation or decoding.


Only observation frames gain a generation: positive safe integer 1 through
9007199254740991, encoded exactly in the existing uint64 header/trailer sequence
fields. Check the header range before returning any uncommitted prefix; every
nonzero trailer must also have an in-range matching sequence. An all-zero
trailer denotes absent commit, not a committed sequence 0. Immutable slots,
including terminal reference,
remain exactly sequence 1. All other frame/context fields and digest preimages remain unchanged. Generation
is storage order, never receipt data or authority.
The producer chooses the next generation under its lock, never from wire input.

The complete canonical reference must fit 2048 bytes before any write. Its exact
schema remains the existing `reconciliation-reference`: v, kind, requestId,
payloadDigest, originalDaemonKey, originalDaemonEpoch, reportingDaemonKey,
reportingDaemonEpoch, at, finding, auditId and evidenceDigest. UUID/digest/epoch/
safe-second primitives and action/original-daemon bindings remain mandatory;
finding must be indeterminate. Validate it with the full retained immutable
lifecycle graph, whose initial outcome must be indeterminate. The trusted coordinator must authenticate producer/current reconciliation
authority and evidence before supplying a reference. This core grants no
authority and adds no generic verifier callback.

Daemon `observation-pair` remains ID 11 with payload cap 4352 and framed EOF
4608: canonical reconciliation/preimage, each component bounded 2048, wrapper
bounded 256. Its typed evidence/codec/recovery stay unchanged. A broker reference is never a daemon pair,
and broker scratch helper ID 11 is not daemon slot 11. No daemon adapter or
cross-store evidence transfer is implemented.

## Publication and retained mirror

Replacement uses the existing synchronous store lock, held through each native
helper's confirmed terminal. Recheck all names, custody, EOFs, inodes and bytes
before every operation. Immutable graph changes or unknown names freeze the
store normally; the exception below concerns only bounded observation contents.

1. Require zero S for an initial observation, or a validated S equal to D after explicit flush/readback. A legacy valid D with zero S also permits a next generation after explicit recovery. Never overwrite unique candidate or quarantined bytes.
2. For first observation choose generation 1; otherwise require valid D, no terminal and generation below the maximum, then choose D+1. Validate the candidate against all immutable retained records before writing.
3. If S is an old mirror, invalidate its embedded trailer and flush it before rewriting its body. D still retains the preceding observation. Write the new header/body and zero padding, flush S, write its embedded trailer, flush S and read back the exact complete typed candidate and zero tail. No destination byte changes before this succeeds.
4. Invalidate D's trailer and flush D, write the candidate header/body and flush D, then write its trailer and flush D. Read back D and S, verify full equality of the embedded frame and the unchanged complete immutable graph/custody.
5. Keep S as that exact validated mirror. Do not clear, unlink, truncate or rename it. Acknowledgement requires successful requested flush/readback and graph validation; a visible valid trailer alone never proves that.

Native flush binds scratch helper 11 to `scratch.record`, EOF 33024; destination
helper 9 to `observation-reference.record`, EOF 2304. Embedded parsing always
binds broker slot 9, including in S. Existing bridge/physical-capacity caveats remain; no fallback. Partial writes/errors preserve bytes, charge the ID and require
reopen. Mirror retention removes the torn-clear operation from new writers.

## Explicit recovery matrix

“Valid” below means complete frame integrity, exact generation/context/padding,
canonical typed reference and binding to the strictly valid immutable graph.
“Invalid” means nonzero bounded contents failing any of those content checks.
Wrong custody, missing files, unsafe links, wrong EOF or unknown names remain
ordinary store failures, not an observation exception. All rows first validate
every other slot; all recovery writes are explicit, never automatic on open.

| D | S | Allowed observation recovery |
| --- | --- | --- |
| Zero | Zero | No observation. An initial generation 1 may be published. |
| Zero | Valid generation 1 | First-observation crash prefix. Explicitly flush/revalidate S, copy it to D through the publication order, flush/read back both, then retain mirror. |
| Zero | Valid generation above 1 | Quarantine: no retained predecessor establishes this first-generation claim. |
| Valid N | Zero | Existing direct-write or prior clear prefix. Explicitly flush/revalidate D and the complete graph before acknowledging N. Future replacement first builds S=N+1. |
| Valid N | Valid N, exact same bytes | Mirror. Explicitly flush/revalidate both before acknowledging N after reopen. |
| Valid N | Valid N, differing bytes | Quarantine: equal generation never chooses a winner. |
| Valid N | Valid N+1 | New candidate retained before destination commit. Explicitly flush/revalidate S, copy only its validated frame to D, flush/read back both, then retain mirror. |
| Valid N | Valid M below N | Quarantine: no older-scratch fallback or automatic cleanup. |
| Valid N | Valid M above N+1 | Quarantine: skipped generation has no valid publication prefix. |
| Invalid | Valid N | Interrupted destination publication. If D has an intact structural header with generation H, require N=H or N=H+1; otherwise quarantine. With no intact header, the valid S remains the sole candidate. Explicitly flush/revalidate S and the immutable graph, copy its validated frame to D, flush/read back both, then retain mirror. No effect retry. |
| Valid N | Invalid | Quarantine, including torn next-candidate writes or legacy scratch clearing. Preserve D and all S bytes; N is not acknowledged as the latest observation. |
| Invalid | Zero or invalid | Quarantine; no reconstructable candidate. Preserve both exact byte arrays. |
| Any | Embedded valid frame with nonzero tail | S is invalid; use the corresponding invalid-S row. |

An intact structural header is exactly 128 bytes with correct magic, version,
slot ID, zero flags/reserved bytes, fixed cap, in-range payload length and
generation, and expected broker context digest. Body hash/padding and trailer
need not validate; the header never proves commitment. Compute H+1 only below
the maximum. A failed structural check supplies no generation claim.

At maximum generation, an exact duplicate remains readable/recoverable; a new
observation refuses before touching either inode. The independently reserved
terminal slot remains available. Recovery changes only observation storage, never generation, deadlines,
signatures, authority or daemon effects. Every observation means indeterminate.

## Quarantine and independent terminal resolution

Preserve exact D/S bytes and bounded hashes in existing inodes; never silently
zero them, choose an older observation, add history files or infer no effect. Ordinary
observation replacement refuses while quarantined. Reads may describe the
quarantine internally but cannot promote D to an authoritative latest record.

Explicit base recovery may flush/revalidate all retained inodes, including raw
quarantined D/S, without repairing or interpreting them. Raw-byte/inode
stamps stay in the bounded volatile cache; every later operation rereads all
slots and invalidates changed stamps. This establishes flush completion without accepting an observation generation. Reopen requires explicit recovery again. Status remains indeterminate absent a valid
terminal record; timestamp values do not settle the uncertainty.

`recordResolution` may publish the independently reserved immutable terminal
reference when all immutable causal records are strictly valid and its exact
canonical schema/current authenticated reconciliation evidence is verified by
the trusted coordinator. Validate the terminal graph independently of D/S;
neither their validity, generation nor payload is a terminal prerequisite or
evidence. Observation quarantine cannot supply or weaken that evidence. Terminal publication retains D/S unchanged
and uses ordinary body/flush/trailer/flush/readback at sequence 1. A visible
terminal prefix still requires explicit recovery before acknowledgement.

After valid terminal resolution, report its applied/refused finding from that
independent record while retaining the observation quarantine. No further
observation replacement or recovery-copy mutation is allowed, including a
previously valid scratch candidate. Terminal availability grants no effect retry, cleanup or authorization. Corrupt
immutable records still refuse all writes.

## Implementation checkpoint and adversarial tests

Reuse the broker core/codec/lock/helper/validator/quotas/stamps for replacement,
explicit candidate recovery and independent terminal publication. Older codecs refuse
non-1 generations; no deployed replacements exist and no migration is inferred.

After joint producer review, test every matrix row, generation bounds, payload
cap, scratch padding, cross-context bindings, terminal coexistence/freeze and
changed cache stamps. Use actual SIGKILL plus short-write/EIO/ENOSPC/EDQUOT at
every candidate/destination/flush boundary. Include historical torn-clear bytes,
exact native slot 9/11 bindings and unchanged quotas/names. Tests establish
neither physical support nor power-loss persistence.
