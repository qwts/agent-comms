# Proposed computer-use owner-decision wire extension

**Status:** Proposed technical contract for joint bot/Comms review; not adopted.
**Date:** 2026-10-12.
**Issue:** [#250](https://github.com/qwts/agent-comms/issues/250).

This candidate refines the approved permission-only policy in the
[#250 proposal](owner-operation-extension-proposal.md#first-coherent-phase-computer-use-setting).
It does not change that policy, add runtime behavior, or activate grants,
receipts, or routes. The existing owner-decision protocol remains disabled; the
candidate operation must fail closed until bot, Comms, and native-host review
and implementation are complete. Existing revision and cold-wake schemas and
vectors remain byte-identical.

## Action and display

Add only `soul.computer-use.set` to the strict operation vocabulary. Keep the
existing seven-field v1 action envelope. Its exact parameters are
`{"enabled":boolean}`; reject missing, null, coerced, or extra values. The
authenticated principal comes from broker context. Bind exact account, soul,
request ID, operation, and value in the canonical action bytes and digest.

The complete native action text includes the exact target, request ID, payload
digest, and one of these fixed summaries:

| Value | Summary |
| --- | --- |
| `false` | `enabled=false; future computer-use tool calls denied while off; current turn continues` |
| `true` | `enabled=true; current turn continues` |

The true summary makes no claim of authority beyond enabling the setting.
Display limits remain 400 Unicode scalars and 500 UTF-8 bytes; refuse before
prompting if the complete text does not fit. Never truncate. The p1 action hash
commits to the exact complete display text, not just the payload digest.

## Expected state, plan, and receipt link

At preparation the daemon atomically captures the effective boolean setting.
Candidate expected state has exactly two fields:
`{enabled:<captured boolean>,kind:"computer-use"}`. `enabled` must be a
Boolean, with no coercion. The JSON object below uses `true` illustratively.
At final application, compare the prepared boolean with the current boolean and
write the desired boolean under the existing setting lock. This phase adds no
setting revision, generation, epoch, migration, or new persisted counter. The
owner explicitly accepted that off→on→off between preparation and application
returns to the same expected boolean and therefore passes this comparison. This
CAS protects against a setting that differs at final application; it does not
claim ABA detection. Preserve existing daemon epoch binding in the existing
challenge.

Compute `effectPlanDigest` as SHA-256 of canonical UTF-8 JSON for this exact
candidate plan object (all keys required; no unknown keys). `payloadDigest` is
the existing SHA-256 of the exact canonical action bytes, not a second digest
preimage. Daemon epoch remains bound by the existing challenge, not a new setting
field:

```json
{"account":"qwts","behavior":{"disabled":"deny-later-computer-use-tool-calls","stop":"none","turn":"continue-current-turn"},"desiredEnabled":false,"expected":{"enabled":true,"kind":"computer-use"},"operation":"soul.computer-use.set","payloadDigest":"<64 lowercase hex>","principal":"principal_00000000-0000-4000-8000-000000000002","requestId":"00000000-0000-4000-8000-000000000103","soul":"agent_00000000-0000-4000-8000-000000000001","v":1}
```

IDs and sample state are illustrative. The bot and Comms teams must agree the
canonical preimage before implementation. Candidate `computer-use` effect `entered` binds exactly
`{effectId,effectPlanDigest,beforeEnabled,afterEnabled}`. `completed` follows
durable write and exact boolean readback. A pre-effect `refused` cannot follow a
setting change; uncertain writes remain indeterminate until exact reconciliation.

For this operation only, add a strict conditional `effectPlanDigest` field to
the prepared challenge and its retained prepared wrapper. The daemon stores an
immutable tuple of challenge nonce, canonical action `payloadDigest`, expected boolean, and plan
digest. Confirmation, receipt issuance, and one-shot release resolve that
same tuple; mismatch refuses. The d1 payload can remain unchanged only if
joint review proves its nonce resolves to this durable immutable challenge and
therefore binds the plan. Otherwise stop for joint schema review; do not treat
an unrecorded digest or d1 nonce alone as sufficient. Existing operations keep
their exact challenge and prepared schemas.

## Authorization and integration seams

Require the existing target grant and a separately owner-administered explicit
`soul.computer-use.set` operation grant. Preserve current selector semantics:
`souls:"*"` within the named account can cover this operation only when it is
explicitly in the operation list; each action still binds its exact soul.
Missing operation grants and legacy `ownerOperations` confer no authority.
Recheck principal, account/daemon enrollment, target grant, operation grant,
daemon epoch/watch, and revocation at existing preparation, issuance, and
pre-application boundaries.

Source seams to extend jointly: `lib/owner-decision-codec.mjs` action schema
and summary; `lib/owner-decision-challenge.mjs` plus
`lib/owner-decision-prepared.mjs` conditional challenge binding;
`lib/owner-decision-proof.mjs`/issuer for unchanged d1 and strict tuple
verification; `lib/broker/owner-grants.mjs` and
`lib/owner-operation-grants.mjs` explicit grant vocabulary; preparation/effect
evidence contracts and bounded journal records; bot setting route and
permission gate. The current bot setting route invokes whole-soul stop when
disabling, so it cannot serve this operation without the reviewed
permission-only consumer/API. No stop, pause, or cancellation effect is allowed.

## Required shared vectors

- Positive true/false actions: exact canonical bytes, payload and plan digests,
  summaries, complete action text, p1 binding, challenge/wrapper conditional
  field, and d1-to-nonce linkage.
- Strict parser negatives: absent/wrong-type/extra parameter, unknown
  operation or conditional field on another operation, changed action/target,
  malformed digest, duplicate/noncanonical JSON, invalid UTF-8, and frame or
  display bounds.
- Authorization negatives: no new operation grant, legacy grant only, wrong
  target, stale epoch/watch, changed challenge nonce/action/plan, replay, and
  revoked authority. Include wildcard plus explicit operation as an allowed
  selector case scoped to the exact action soul.
- State/concurrency/recovery: change after prepare, off→on→off ABA acceptance,
  changed boolean refusal, restart uncertainty, crash before/after durable write,
  exact reconciliation, denial of later tool calls while off, and current-turn
  continuation. Assert no stop/pause call.
- Check bounded journal reservations for the added plan/evidence before runtime
  admission; exhaustion refuses without eviction or a new request.
