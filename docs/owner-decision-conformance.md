# Owner decisions: evidence and proposed conformance

This is the evidence and implementation checklist for proposed
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
This delivers partial requirement 4, not relay, receipts, atomic application
or native custody. Comms still writes the plain principal before platform
storage. No rollout is claimed.

ADR-0077 remains Proposed; its additional presence, operation-grant and cutover
choices remain unapproved. All four original requirements remain in scope.
This refresh authorizes no runtime or migration.

## Historical reviewed source snapshots — 2026-10-11 refresh

- [Comms a8761ac](https://github.com/qwts/agent-comms/tree/a8761ac3fca90acbefa0f1c756e1e5486a598685), after v0.4.0 and Windows lifecycle #148.
- [Agent-bot 1b58a01](https://github.com/qwts/agent-bot-identity/tree/1b58a0191f0fd48593b6817cd452c8f092db71e6), refreshed from live main; source evidence, not a bundled release claim.

Paths/lines in the historical table below use these snapshots. Current
release evidence supersedes its health-only and missing target-query claims.
Host source, native custody and compatible bundled releases were not revalidated.
Owner policy review and joint agent-bot/native-host review remain prerequisites;
this evidence refresh changes no acceptance status or runtime authorization.

## Historical requirement evidence

| #77 requirement | Current behavior and test evidence | Missing evidence |
| --- | --- | --- |
| 1. Principal owner-decision relay | [Broker dispatch](https://github.com/qwts/agent-comms/blob/a8761ac3fca90acbefa0f1c756e1e5486a598685/lib/broker.mjs#L162) has no decision routes; `lib/principal-client.mjs:37-71` has no decision API. `lib/broker/launch.mjs:123-134` and `tests/launch.test.mjs:274` supply an authenticated relay pattern. Bot `comms-client.mjs:815-826` handles launch, not decisions. | Decision preparation, principal-only confirmation, target-owned staging, result/status and host entry point. |
| 2. Signed receipt verified before application | Bot [principal verifier](https://github.com/qwts/agent-bot-identity/blob/1b58a0191f0fd48593b6817cd452c8f092db71e6/owner-principal.mjs#L13) authenticates `health` without action/target. `owner-gate.mjs:191-193` rejects soul markers before invoking it; `tests/owner-gate.test.mjs:83-86` expects health. Comms `lib/state.mjs:15-40` has no decision journal or receipt trust. | Receipt issuer/key lifecycle, request-bound presence, daemon verifier, durable replay handling, revocation and no mutation on refusal. |
| 3. Host-only principal custody on macOS | [Pairing](https://github.com/qwts/agent-comms/blob/a8761ac3fca90acbefa0f1c756e1e5486a598685/lib/client.mjs#L140) creates the secret in Node and writes plain state before platform storage. `lib/platform/secret-store.mjs:17-42` uses unrestricted `security` creation/export; `tests/platform.test.mjs:58-83` preserves it. `lib/principal-client.mjs:23-34` copies the secret into JavaScript. | Signed native access-group custody, non-exporting requests, native presence-key protection, negative access tests and revoked legacy secrets. |
| 4. Grant-scoped owner decisions | [Principal approval](https://github.com/qwts/agent-comms/blob/a8761ac3fca90acbefa0f1c756e1e5486a598685/lib/broker/pairing.mjs#L282) stores ordinary target grants only. `lib/broker/shared.mjs:39-42` matches accounts/souls/addresses; launch `:90-99` also applies receive rules. `tests/launch.test.mjs:201` covers existing authorization. | Explicit operation grants; no inherited owner power; account/soul resolution for unjoined targets; rechecks on issuance and release. |

The bot's health path refuses a same-UID broker and single-account mode
(`owner-principal.mjs:24-25`; `tests/owner-gate.test.mjs:130`). Do not remove
this guard as a shortcut to broker decisions. The proposed path is separate.

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
| Immutable operation binding | Daemon prepare; native prompt; broker and daemon verification | Alter operation, reason, proposal, package digest, expected revision, session, account or soul; each refuses without mutation. Stage expiry/digest/path checks for adopt/edit. |
| Serialization and audience separation | Receipt codec; native presence adapter | Shared Rust/JS golden bytes: nested ASCII key order, raw non-ASCII scalar strings, required escapes and integer endpoints; reject non-ASCII/duplicate/unknown keys, invalid UTF-8/surrogates, alternate escapes, floats/exponents/negative zero/leading zeros/out-of-range integers, padding/nonzero trailing base64url bits, uppercase/alternate digest encodings, wrong version/audience/key and malformed/oversize input. A grant, presence or owner statement cannot be a decision receipt. |
| Human saw the exact action | Protected native issuer; both verifiers | Full prompt from validated bytes, nonce/action mismatch, cancellation, timeout, unavailable helper and invalid assertion; no truncation or success-by-host-claim. |
| Expiry policy | Broker issuance; daemon application | Floor millisecond clocks to seconds; `iat = now + 30` passes, `iat = now + 31` refuses, `now = exp - 1` passes and `now = exp` refuses, subject to other checks. Reject zero/61-second receipt lifetimes and negative/fractional timestamps; receipt cannot outlive challenge/proof or be issued at their expiry. Presence issuer/verifier bounds tested separately. |
| Durable single consumption | Broker release and daemon journal | Duplicate concurrent requests, changed-content reuse, restart replay, lost result/check reply and crashes on both sides of mutation; uncertain outcomes never auto-apply. Journal write failure prevents effects. |
| Current authority at release | Broker daemon-authenticated check | Revocation/key rotation before release refuses; wrong daemon refuses; loss of broker fails closed; document revocation after release as already-authorized work. |
| Protected custody and bootstrap | Signed native store; owner setup/recovery | Real macOS allowed-host access; arbitrary Node/`security` denied, no secret in files/argv/environment/bridge/logs; protected presence seed and code identity; replacement/corrupt pin cannot silently bootstrap. |
| Explicit legacy cutover | Owner-enabled migration phases | Revoke before new approval; interruption at each phase; no old-secret resurrection; only selected namespace cleaned; account/daemon pairings and history preserved. |
| Visible unsupported capabilities | Host and broker setup | Single-account/Windows/older bundles refuse this feature; ordinary API availability does not advertise owner-decision support. |

## Review and implementation slices

1. Owner reviews ADR-0077's three decision groups. Agent-bot and the native
   host review their contracts; organization deployment deltas use ENG records.
2. Fix cross-language fixtures and pure verifiers; keep capability disabled.
3. Implement broker policy/relay/journal, then daemon verification/application
   against those fixtures. Each PR states covered operations and remaining gaps.
4. Implement native custody/presence and explicit cutover with live negative
   access tests. Validate a pinned host/bot/comms release set before enabling.
5. Record issuer, verifier, test name, command, result and release for every
   matrix row. Only then record #77's solution as built and consider closeout.

Documentation checks for this proposal are Markdown lint and the pinned
docs-gov gate. They validate the documentation artifact, not the proposed
security guarantees. Runtime/native validation belongs to its implementation
PRs and cannot be inferred from a documentation merge.
