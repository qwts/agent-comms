# Shared native source receipt fixture

This private debug fixture connects the actual compiled observer and receipt
worker to one real fixed-slot enrollment source. Normal protected capability
construction and readiness still refuse. It proves neither installed provenance
nor signing custody, daemon authority, physical durability or activation.

The new source fixture uses the existing scanner and bootstrap projection. It
checks the command's actual namespace, revision, head and projection digest.
It never translates them into the legacy fixture's constants. The receipt key
is fixed and synthetic; its compiled public key must equal the scanned pin.
The explicit fixture capability class inherits the disabled test brand, but its
signing method invokes the child rather than the JavaScript synthetic signer.

The private input is exactly `GBRSFX01` (eight ASCII bytes), a big-endian u32
bootstrap byte length, canonical bootstrap bytes, a big-endian u32 command byte
length, and command bytes, with EOF. Bootstrap is 1–4096 bytes and command is
1–131072 bytes; total input is at most 135184 bytes. The existing response is
at most 1024 bytes. No path, UID, key, compiler or clock selector is accepted.
The debug clock begins at the verified command's issuance time and advances
with monotonic elapsed time. Normal worker clocks remain unchanged.

Observer FD3 inherits the parent's lock description; observer FD4 supplies the
explicit fixture root. The asynchronous source receipt child receives only the
root capability as FD3 and opens the existing lock independently, noncreating
and nonblocking. The parent closes its guard before launching or awaiting the
signer and retains its original root descriptor through independent terminal
completion. The receipt child closes owned duplicates and its lock before any
response. Original inherited FD3 remains process-owned until exit. There is no
explicit unlock, caller PID operation or retry after uncertain completion.

The child revalidates scanned source metadata and bytes before and after
signing, checks its original eight-second deadline, and refuses an uncertain
close. Parent death and closed output prevent success. A system call may outlast
a timer; only actual child and pipe closure certifies the terminal outcome.
The coordinator retains its ten-second attempt deadline and opens a fresh final
guard after candidate and terminal completion, through journal flush and send.

Fixture bootstrap bytes are immutable consistency input, not authenticated OD
receipts. Revalidation checks the held root capability and its named children;
replacing a pathname outside that capability is not detectable by this child
alone. The coordinator's fresh named-source guard supplies the separate final
check. External account mappings and root changes remain point-in-time checks.
Daemon observation v1 has a separate digest and chain version, never substitutes
for the native projection, and grants no authority. No expected-observation
writer or daemon versioning contract is assumed by this slice.

Local compiled acceptance supplies exact artifacts explicitly through
`COMMS_OWNER_OBSERVER_SOURCE_FIXTURE_BINARY`,
`COMMS_OWNER_RECEIPT_SOURCE_FIXTURE_BINARY`, and
`COMMS_OWNER_RECEIPT_SOURCE_STUCK_BINARY` to
`tests/owner-receipt-source-connected.test.mjs`. Tests cover all eleven commands,
unchanged bindings and deadlines, independent lock ownership, source mutation,
public-pin mismatch, malformed framing, cancellation, revocation, closed output
and native watchdog termination. The separate native artifact suite covers
parent death with open stdin and absence of normal receipt custody symbols.
No compiler fallback or production constructor is added.
