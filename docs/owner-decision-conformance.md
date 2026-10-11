# Owner decisions: evidence and proposed conformance

This is the evidence and implementation checklist for proposed
[ADR-0077](decisions/ADR-0077-owner-decisions-through-the-broker.md) and its
[wire contract](owner-decisions.md). It records gaps, not completed tests or
authorization to change runtime. Keep
[#77](https://github.com/qwts/agent-comms/issues/77) open until all four
requirements have release evidence and a lifecycle closeout.

## Reviewed source snapshots

- [Comms e105e52](https://github.com/qwts/agent-comms/tree/e105e52021b350b08e742a0b172d7e66e7892cc6), released version field `0.3.16`.
- [Agent-bot 64b1c17](https://github.com/qwts/agent-bot-identity/tree/64b1c170ed25f4943e01a9f20334c065fd92d661).
- [GeniusBar 4997eae](https://github.com/qwts/GeniusBar/tree/4997eae75a3672846194987ff2f9f0fe36157be0).

References below use paths/line numbers in these snapshots. Revalidate before
implementation; the user's checked-out source may be older. Source inspection
does not establish live macOS custody or a compatible bundled release.

## Requirement to current evidence

| #77 requirement | Current behavior and test evidence | Missing evidence |
| --- | --- | --- |
| 1. Principal owner-decision relay | Comms `lib/broker.mjs:103-149` and `lib/principal-client.mjs:37-59` expose launch but no owner-decision. `lib/broker/launch.mjs:123-134` records then delivers to an authenticated watch. `tests/launch.test.mjs:274` checks daemon targeting. Bot `comms-client.mjs:834` consumes launch events. | Decision preparation, principal-only confirmation, target-owned staging, result/status and host entry point. |
| 2. Signed receipt verified before application | Bot `owner-principal.mjs:13-29` authenticates `health`, without action/target arguments. `owner-gate.mjs:193-195` rejects soul markers then invokes that verifier. `tests/owner-gate.test.mjs:83-86` and `tests/soul-revision-daemon.test.mjs:90` expect the health call. | Receipt issuer/key lifecycle, request-bound presence, daemon verifier, durable replay handling, revocation and no mutation on refusal. |
| 3. Host-only principal custody on macOS | Comms `lib/client.mjs:149-150` writes the plain copy before platform storage. `lib/platform/secret-store.mjs:16-40` uses unrestricted `security` creation/read; `tests/platform.test.mjs:61-79` asserts that command and partial-save error. GeniusBar `bridge/bridge.mjs:1-8,105-107` holds the credential in Node. | Signed native access-group custody, non-exporting requests, native presence-key protection, negative access tests and revoked legacy secrets. |
| 4. Grant-scoped owner decisions | Comms `lib/broker/shared.mjs:27-29` covers account/soul/address targets; `lib/broker/launch.mjs:90-99` intersects target grants and receive rules. `tests/launch.test.mjs:201` checks launch credentials/grants. | Explicit operation grants; no inherited owner power; account/soul resolution for unjoined targets; rechecks on issuance and release. |

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

Bot `owner-action.mjs:27-38` keeps signed challenges default-off. Its
[owner-statement contract](https://github.com/qwts/agent-bot-identity/blob/64b1c170ed25f4943e01a9f20334c065fd92d661/docs/owner-statements.md)
reports that a valid signature under unprotected
pins is `owner-pins-unprotected`, not owner approval. Its
`owner-presence.mjs:160-176,184-202` documents residual same-account bootstrap
authority; a legacy helper installation is not proof of the strengthened
native custody proposed here. Product changes need agent-bot/native review.

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
