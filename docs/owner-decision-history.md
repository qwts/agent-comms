# Owner decisions: historical source evidence

This preserves the historical baseline from the [conformance record](owner-decision-conformance.md).
It is source-review evidence, not a live test, release compatibility claim or
current owner approval status. Accepted [ADR-0077](decisions/ADR-0077-owner-decisions-through-the-broker.md)
still requires joint protocol review and evidence for all four requirements.

## Historical reviewed source snapshots — 2026-10-11 refresh

- [Comms a8761ac](https://github.com/qwts/agent-comms/tree/a8761ac3fca90acbefa0f1c756e1e5486a598685), after v0.4.0 and Windows lifecycle #148.
- [Agent-bot 1b58a01](https://github.com/qwts/agent-bot-identity/tree/1b58a0191f0fd48593b6817cd452c8f092db71e6), refreshed from live main; source evidence, not a bundled release claim.

Paths/lines in the historical table below use these snapshots. Current
release evidence supersedes its health-only and missing target-query claims.
Host source, native custody and compatible bundled releases were not revalidated.
Joint agent-bot/native-host review remains pending; these snapshots establish
no runtime authorization.

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
