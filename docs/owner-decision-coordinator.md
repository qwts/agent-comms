# Disabled connected owner-decision coordinator

The internal [coordinator](../lib/broker/owner-decisions.mjs) connects the real
broker pairing, scoped grants, selected account watch, fixed lifecycle journal
and [receipt issuer](owner-decision-receipt-issuer.md). Actual Broker ingress now
imports a separate refusing production factory. Only an explicitly selected trusted
synthetic fixture can construct the working composition. All authority and
physical capability flags remain false.
This is integration source and fixture evidence, not native custody, physical
reservation support or completed #77 acceptance.

## Authentication and target provenance

The coordinator uses the broker's existing pairing collaborator for presented
principal and daemon credentials. Credential kinds cannot mix; inbound A2A
principal impersonation is rejected. Exact operation envelopes accept no sender,
alternate principal, alternate authentication identity, verifier or authorization
callback. Internal object encoding is bounded before recursion at depth eight,
32 KiB and 32 keys per object; the exact operation decoders impose smaller
semantic bounds. Future transport framing remains independently required.

Before admission, a distinctly named selector-scope check intersects the current
approved principal's ordinary target grant and scoped owner grant with its exact
requested account, soul and operation. Account and daemon approval and one live
watch are also required. This does not prove that the target exists locally.
Only a prepared success authenticated as the selected account daemon establishes
that producer's local target-resolution claim, bound to the saved original
action, account, watch ID, key and epoch. No hub joined row or mailbox receive
allowlist supplies this provenance or authorizes the operation.

Joint daemon review confirmed that its producer must resolve the exact soul in
its own account through bounded census and identity checks, including unjoined
souls. Missing, retired, foreign and unresolvable targets must collapse to the
same early validation-refused report with null receipt/effect digests and no
detail. Final target loss maps to target-unavailable and validation-refused.
That C2 producer and its in-process identity reader remain separate daemon
implementation prerequisites. Synthetic broker tests assume that producer
contract; they do not establish live target ownership or daemon C2 conformance.

## Paired enrollment and current authority

[Synthetic enrollment state](../lib/broker/owner-enrollment.mjs) stores one
atomic receipt/presence key pair, stable namespace, broker service account and
nonzero unsigned-32-bit service UID, plus a monotonic pair revision. This is
neither a production enrollment record format nor a protected key provider.
Installing a pair permits revisions 1–1023; revision 1024 is reserved for
terminal revocation. Revocation/reinstallation requires a larger revision;
exhaustion cannot reset the namespace, retained IDs or reservations. The terminal
revocation safety property agrees with the daemon producer direction, but this
synthetic state is not that producer's persistence implementation.

Each accepted request retains exactly its selected socket and enrollment pair
revision in a bounded ephemeral map (at most 4096 entries). Issuance and release
read a fresh synchronous enrollment snapshot and recheck current principal,
ordinary/scoped grants, account/daemon approval, exact selected key/epoch/watch
and three-way receipt/presence/daemon key separation. Re-enrolling identical keys
with another revision cannot revive that attempt. Native protected custody and
current enrollment persistence remain missing, so production construction stays
unsupported. No request field selects enrollment or keys.

## Durable dispatch and one-shot release

The complete outgoing preparation frame is bounded before admission. The
journal durably records its immutable action/acceptance before one write attempt
to the selected watch. Identical preparation requests only read retained status;
they never send again, including after a failed write or restart. Reconnect
never replaces a request's saved socket. Prepared reports reconstruct the
challenge from broker-saved fields and strictly validate nonce, time and public
stage before persisting the existing prepared wrapper and acknowledging it.

Confirmation validates complete p1 through the existing issuer. The complete
outgoing decision frame is bounded before spending any proof. Presence, exact
receipt and authorization are journaled before one decision event; duplicate
confirmation never signs or dispatches another receipt. Partial proof prefixes
cannot be used to authorize again. Visible bytes after reopen require explicit
storage recovery; neither status nor duplicate handling auto-forwards work.

The first online check rechecks current authority and the complete proof, then
synchronously journals release with no asynchronous gap. Only a newly persisted
release can return mayApply true. The coordinator checks the current clock and
exact socket/enrollment/authority again after the requested flushes. Expiry or
loss during that interval suppresses the positive response and retains release
plus uncertainty; it never refunds the nonce. Repeated checks and released
records recovered after restart always return mayApply false. Receipt expiry is
strict; an effect that entered before expiry may finish after it.

Cancellation writes a terminal outcome only in preparing/prepared. Authorization
wins over a later cancel; no notification revokes released work. Lazy deadline
handling records expired before authorization and refused/deadline-expired after
authorization. No automatic retry or effect follows deadline handling.

## Results and limits

Daemon authentication and the original saved bindings select result origin.
The existing typed lifecycle validator controls legal states, digests and
causal graph. Exact result repeats compare the canonical daemon report body,
excluding broker-generated observation time, and return recorded false even
when the clock has advanced. Conflicting reports refuse; absence of completed
proof or an entered record never becomes a fabricated refusal.

Current principal and both grants are checked before returning status or
cancellation details. Unknown, foreign and unowned orphan/visible IDs use the
same non-disclosing unavailable result. Storage failures have fixed sanitized
messages and do not manufacture a lifecycle outcome.

Reconciliation mutation remains unsupported until the exact daemon owner-local
producer contract is integrated. An audit ID alone grants nothing. This slice
does not project a final reconciled reference into a new normal-result proof;
authorized reads of that unsupported record shape refuse explicitly, while
foreign callers still receive the same unavailable result.

Tests use real Broker state/EventLog, pairing/admin authentication, watch
binding and the actual fixed journal in disposable private directories. Only
socket sinks, key enrollment and daemon target-resolution claims are synthetic.
They cover all shared operations, revocation, cancellation, epoch/watch changes,
result idempotence, reopen recovery and failures at publication boundaries.
No native provider, physical capacity, authority activation, staging upload or
live cross-repository acceptance is claimed.

## Actual broker ingress

The private [ingress](../lib/broker/owner-ingress.mjs) is wired into Broker's
dispatcher before ordinary daemon routing. It maps exactly the seven owner
operations to their existing coordinator methods and authenticates the required
presented principal or daemon credential kind before checking readiness. It
cannot use the synthetic constructor. Unknown and foreign request IDs remain
indistinguishable while the production provider is unavailable; no journal is
created and no owner event is sent.

The line reader supplies privately attested original Buffer frame size,
including LF and CR when present. Owner ingress requires at most 32768 bytes,
including whitespace and escaped JSON; a request field cannot forge that
metadata. A trusted UTF-8 validity flag rejects malformed owner frames before
authentication or reconstruction; ordinary JSON parsing retains its existing
replacement behavior. Already decoded streams cannot attest original bytes. Ordinary comms
retains its existing 128 KiB line limit and JSON behavior. These owner routes
are reachable refusals, not an enabled owner capability.

The shared generic envelope JSON parser still accepts up to its existing
128 KiB bound before operation classification. The stricter owner 32 KiB check
then precedes authentication and typed canonical decoding; it is not a preparse
owner limit. The wire contract's before-decoding owner bound remains an enabling
prerequisite: a dedicated bounded ingress or jointly reviewed incremental
envelope classifier must satisfy it. This slice does not waive that requirement.

Preparation has a rolling monotonic 60-second limit of six attempts per
authenticated principal/account and twelve per principal. Both buckets share
one finite 4096-entry budget; all checks precede either charge. Invalid account
grammar creates no bucket. Limits refuse without waiting or creating a request
ID, and status/cancel/daemon reports bypass preparation limits. Rate buckets
are ephemeral, cleared on broker stop; they neither retire nor reset journal
reservations. Readiness refusal may consume preparation rate, never an ID.

The fixed readiness inspection checks Darwin/group mode, nonzero service UID,
private state ownership, absence of known same-UID paired soul accounts and
fixed native artifact provenance. These are necessary, insufficient predicates.
The protected installation/enrollment producer and physical support producer
remain explicitly unavailable, so readiness always refuses. No configuration,
request, environment variable or host assertion enables support or supplies keys.
Broker startup and ordinary operations continue; a future reviewed producer
must use this same factory/composition and preserve distinct local trust-chain
versions, exact namespace/key/service bindings and revocation checks.
