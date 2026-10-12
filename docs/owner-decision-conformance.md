# Owner decisions: evidence and proposed conformance

This is the evidence and implementation checklist for accepted
[ADR-0077](decisions/ADR-0077-owner-decisions-through-the-broker.md) and its
[wire contract](owner-decisions.md). It records gaps, not completed tests or
authorization to change runtime. Keep
[#77](https://github.com/qwts/agent-comms/issues/77) open until all four
requirements have release evidence and a lifecycle closeout.

## Current published implementation — 2026-10-11

[Comms 0.4.2](https://github.com/qwts/agent-comms/tree/v0.4.2)
(`1222ccd83ce1b8ffe3ad77cea679eb9be6398110`) and
[agent-bot 0.10.64](https://github.com/qwts/agent-bot-identity/tree/v0.10.64)
publish the [target-grant query and covered consumer](principal-target-check.md).
Comms 0.4.4 additionally releases the credential-free native transport factory.
These deliver partial requirement 4 and an embedding seam, not relay, receipts, atomic application
or native custody. Comms still writes the plain principal before platform
storage. No rollout is claimed.

The owner accepted all three ADR-0077 groups at `d4ee294`
([receipt](https://github.com/qwts/agent-comms/issues/77#issuecomment-6115201195)).
All four requirements remain in scope. Joint protocol/native review and
conformance remain prerequisites; no runtime enabling or migration is authorized.

Historical source snapshots and the original requirement-by-requirement table
are retained in [historical evidence](owner-decision-history.md). They do not
supersede the published target-query/transport evidence above.

## Dependency boundaries

[#594](https://github.com/qwts/agent-bot-identity/issues/594) is closed. Its
recorded decisions establish keyd protocol ownership, the documented
at-most-60-second grant replay window across helper restart, configured Team
ID/identifier and owner-verified trust loosening. ADR-0077 does not reopen
these choices. Durable broker/daemon request consumption is a different
invariant from keyd's in-memory grant nonce cache.

Bot [pin attestation](https://github.com/qwts/agent-bot-identity/blob/1b58a0191f0fd48593b6817cd452c8f092db71e6/owner-action.mjs#L35)
now asks keyd to vouch for the exact pin set per request and rechecks after
signing. Signed challenges can run with vouched pins; absent attestation keeps
the existing presence/dialog path. The older default-off description is historical.
Its challenge ledger (`owner-action.mjs:164-216`) and
[generation floor](https://github.com/qwts/agent-bot-identity/blob/1b58a0191f0fd48593b6817cd452c8f092db71e6/owner-presence.mjs#L414)
are in memory, not durable decision consumption. The
[native store](https://github.com/qwts/agent-bot-identity/blob/1b58a0191f0fd48593b6817cd452c8f092db71e6/keyd/src/store.rs#L323)
uses legacy login-keychain ACLs and documents deletion/planting limits; it
distinguishes the proposed data-protection/access-group boundary. These
improvements neither supply `d1` receipts nor complete #77 custody.

Comms [#127](https://github.com/qwts/agent-comms/issues/127) owns Windows and
bundle integration evidence. Passing its channel tests does not prove this
owner contract. No release compatibility or live native results are asserted
by this document.

## Proposed invariant to test matrix

These cases are unimplemented acceptance work. Existing suites named above
are reusable patterns, not passes for the proposed protocol.

| Invariant | Issuer / enforcing entry point | Focused required evidence |
| --- | --- | --- |
| Principal and target/operation grants | Broker prepare/confirm/check | Account/soul/daemon and mixed credentials refuse; missing operation grant, wrong account/soul, revoked principal/pairing and changed grant refuse without target disclosure. |
| Immutable operation binding | Daemon prepare; native prompt; broker and daemon verification | Alter every typed field, identity and digest: refuse without mutation. Validate stage expiry/digest/path and principal/target/request binding for adopt/edit/webhook; final-lock state races refuse. |
| Serialization and audience separation | Receipt codec; native presence adapter | Execute the [shared bytes and negative cases](owner-decision-fixtures.md): strict canonical JSON/base64url, Unicode and integer boundaries, correct signatures/keys/audiences and frame limits. A grant, presence or owner statement cannot be a decision receipt. |
| Human saw the exact action | Protected native issuer; both verifiers | Exact labeled grammar from validated bytes, quoted literals, 400-scalar/500-byte action boundaries and long-account/Unicode refusals; nonce/action mismatch, cancellation, timeout, unavailable helper and invalid assertion; no truncation or success-by-host-claim. |
| Expiry policy | Broker issuance; daemon application | Floor millisecond clocks to seconds; `iat = now + 30` passes, `iat = now + 31` refuses, `now = exp - 1` passes and `now = exp` refuses, subject to other checks. Reject zero/61-second receipt lifetimes and negative/fractional timestamps; receipt cannot outlive challenge/proof or be issued at their expiry. Presence issuer/verifier bounds tested separately. |
| Durable single consumption | Broker release and daemon journal | Concurrency, changed-content reuse, restart replay, lost replies and crashes around every effect; no automatic uncertain retry. Journal/fsync failure prevents effects; cancellation races, retained ID tombstones and status after expiry. Reconciliation needs request-linked proof, never a preexisting matching value. |
| Current authority at release | Broker daemon-authenticated check | Revocation/key rotation before release refuses; wrong daemon key/epoch/watch refuses; loss of broker fails closed; one live check response permits one attempt before the final-lock deadline; document revocation after release as already-authorized work. |
| Protected custody and bootstrap | Signed native store; owner setup/recovery | Real macOS allowed-host access; arbitrary Node/`security` denied, no secret in files/argv/environment/bridge/logs; protected presence seed and code identity; replacement/corrupt pin cannot silently bootstrap. |
| Explicit legacy cutover | Owner-enabled migration phases | Revoke before new approval; interruption at each phase; no old-secret resurrection; only selected namespace cleaned; account/daemon pairings and history preserved. |
| Visible unsupported capabilities | Host and broker setup | Single-account/Windows/older bundles refuse this feature; ordinary API availability does not advertise owner-decision support. |

## Review and implementation slices

1. Owner policy is accepted; agent-bot/native-host contract review remains
   pending. Organization deployment deltas use ENG records.
2. Jointly review the [exact wire schemas and adapter boundaries](owner-decision-wire.md) and [shared fixture specification](owner-decision-fixtures.md), then implement pure verifiers against those bytes; keep capability disabled.
3. Implement broker policy/relay/journal, then daemon verification/application
   against those fixtures. Each PR states covered operations and remaining gaps.
4. Implement the raw-p1 native adapter, protected custody/presence, immutable staging and explicit cutover with live negative
   access tests. Validate a pinned host/bot/comms release set before enabling.
5. Record issuer, verifier, test name, command, result and release for every
   matrix row. Only then record #77's solution as built and consider closeout.

Documentation checks for this proposal are Markdown lint and the pinned
docs-gov gate. They validate the documentation artifact, not the proposed
security guarantees. Runtime/native validation belongs to its implementation
PRs and cannot be inferred from a documentation merge.

The [fixture consistency command](owner-decision-fixtures.md) checks the static artifact, signatures and clock/display examples. Broker, daemon, custody, staging and mutation conformance remain unimplemented.
