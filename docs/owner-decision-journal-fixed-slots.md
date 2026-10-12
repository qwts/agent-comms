# Owner decisions: proposed fixed-name journal backend

This disabled backend proposal amends the physical publication mechanism in the
[journal ordering companion](owner-decision-journal-recovery.md). It preserves
accepted policy, exact producer ownership, full retention, finite refusal and
live authority checks. The [bounded APFS evidence](../tools/feasibility/apfs-journal/EVALUATION.md#fixed-name-successor-qualified-pass)
supports a candidate; it establishes no production physical-capacity guarantee.
No route, production allocator, daemon access or authority is enabled.

## Admission before fixed names can become records

Under the existing broker-owned synchronous kernel lock, charge each surviving
request directory as a complete spent-ID reservation immediately. Count every
orphan toward the same 4096-ID limit. Exclusively create every final slot inode
and scratch name before acknowledgement; allocate each complete framed cap, set
its final EOF, initialize every byte to zero, flush all files and directories,
and reopen/validate identity, ownership, mode, names, cap and allocation. No
partial prefix can be reused, silently cleared, refunded or forwarded.

Only after the complete slot set is established can exact original action and
immutable acceptance publish, in that order. Any later protocol deadline check
uses original acceptedAt; allocation never refreshes it. Existing canonical
validation, selected daemon/watch binding, stable namespace and duplicate-input
rules remain required. Restart never automatically forwards a saved pair.

After initialization, permission-bearing transitions perform no explicit file
creation, link, rename, unlink, truncate or growing index append. Fixed slots
remain physically present when logically empty. Enumerating the bounded charged
request directories avoids depending on a late mutable index write. The store
lock and enrolled global namespace metadata must already be durable. This is
multi-file ordering, not group atomicity, and APFS may still need metadata
allocation for an in-place data write or flush.

## Exact proposed frame

Use the 128-byte header, payload-cap region and 128-byte commit trailer described
in the [frame candidate](../tools/feasibility/apfs-journal/NEXT-BACKEND.md#candidate-frame-and-commit-order).
All integer widths, endian rules, padding, digests and repeated fields there
are normative for this proposal. A parser reads only the known fixed cap for
the selected slot; a stored length never chooses its allocation or schema.

Broker slot numbers 1–10 are acceptance, original-action, prepared-challenge,
presence, receipt, authorization, release, initial-outcome,
observation-reference and terminal-reference, in the existing budget order.
Daemon numbering follows its sixteen-slot budget order and belongs to its own
producer implementation. Context digest is SHA-256 of canonical local
`{namespaceDigest,requestId,slot,v:1}`, using these full contract slot names.
The lab's shortened aliases and synthetic maximal patterns are fixture details,
not production record encodings or accepted authority.

Payload contains exactly the existing canonical local record bytes, original
canonical action bytes or complete original ASCII token for that slot, followed
by zeros through its cap. Header payload length excludes padding. Payload SHA-256
covers the unpadded bytes; frame SHA-256 covers the existing domain prefix,
header and full padded payload. Header/trailer sequences, identity, cap, lengths,
flags and every reserved byte must validate. Immutable slots use sequence 1.
Hash integrity supplements strict typed schema and complete graph binding; it
cannot replace them or authenticate a malicious same-account store writer.

## Publication, uncertainty and recovery

A write-once transition requires an initialized all-zero destination under the
store lock. Write header and complete padded payload, flush, then write the
trailer and flush again. Verify the exact complete frame through a read-only
descriptor before acknowledging, delivering or starting the next protocol step.
An exact duplicate never writes again. A changed duplicate, short write, wrong
EOF/inode, corrupt frame or flush error refuses; all evidence remains retained.
Here durable means that the requested flush completed, not that a power-loss
experiment measured persistence. There is no atomic-sector or atomic-pwrite
assumption.

Visible valid framing after process loss is insufficient proof of its final
flush. On reopen, require explicit full flush and revalidation of every saved
committed frame needed for any acknowledgement or subsequent write, including
an exact duplicate's saved action/acceptance pair. A failed recovery flush keeps
that prefix unsettled. No automatic forward, delivery, check release or effect
retry follows recovery. Status is non-authorizing; application still requires
current authority, original deadlines, live check and final expected-state locks.

A nonzero uncommitted slot, unknown name, wrong length, mismatched binding,
corrupt trailer or impossible graph cannot fall back to an older permission
state. Preserve the complete prefix and refuse ordinary writes. All-zero slots
mean no committed record, never proof of no effect. Uncertain released/entered
work stays indeterminate without durable whole-effect completion evidence.
Complete graph validation must inspect every slot; one valid frame is not a
valid lifecycle. Reads do not recreate missing initialized files.

Only indeterminate observation may replace bytes. The precreated scratch inode
has fixed EOF 33024 and embeds the exact destination-bound next frame at offset
zero, with its contract cap and zero bytes after its cap+256 frame. It is not an
independent new scratch slot schema. Preserve/flush that candidate before
invalidating the destination trailer, then flush body, trailer and final equality
before zeroing/flushing scratch. A crash with nonzero scratch freezes ordinary
writes. Exact recovery/retrieval semantics for an interrupted replacement remain
an explicit prerequisite; no routine cleanup may discard the newest unresolved
observation. Daemon observation/preimage must be one combined bounded frame.
Original entered/completed/refused evidence and terminal resolution never change.

## Next disabled integration and required tests

The next broker slice should add a strict frame reader/writer and fixed-name
admission-prefix backend behind the existing unconsumed journal module. Reuse
its exact acceptance/action validator, namespace binding, count accounting,
Darwin lock lifetime and sanitized errors. Keep unsupported lifecycle phases
explicitly refused until their graph validators are implemented. No daemon files,
request-selectable authority callback or owner-decision route belongs in this
slice. A reviewed Darwin allocation bridge is still required before supported
physical admission; the test-only C executable is not that bridge.

Meaningful interruption tests must cover creation, allocation, zero initialization,
each file/directory flush, partial body/trailer writes, their flushes, visible
trailer before final flush, immediately before acknowledgement, recovery flush,
close errors and wrong inode/EOF. Fresh child processes must verify charged
orphans, no duplicate acknowledgement from unflushed visibility, strict unknown
or corrupt graph refusal, no read recreation, exclusive lock contention/crash
release and deterministic finite refusal at 4096 IDs. Inject EIO, ENOSPC,
EDQUOT, short writes and short reads; test every header/trailer primitive,
digest, padding and cross-binding. Include actual canonical action/acceptance
bytes, not only maximal synthetic frames. Observation replacement needs its
own complete interruption matrix before that phase is claimed supported.

The logical 262144/524288 reservations and 256-byte framing charge are unchanged.
They are not physical byte guarantees: the lab's rounded eleven-inode allocation
was 167936 bytes, larger than its unrounded framed-byte sum. A supported backend
must separately budget actual block rounding, directories/inodes, global records,
filesystem checkpoint/copy-on-write costs, all retained IDs and separately charged
private staging. Actual macOS 13/architecture execution, full-flush behavior,
snapshot boundary, helper distribution/identity and supported allocation bounds
remain explicit prerequisites. Any storage error remains fail-closed; a bounded
lab pass never promises unconditional future writes or power-loss safety.
