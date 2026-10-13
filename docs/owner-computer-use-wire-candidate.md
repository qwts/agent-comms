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
| `false` | `enabled=false; deny future computer-use calls while off; current turn and authorized/running tool calls continue` |
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
At final application, compare the prepared boolean with the current boolean
before durable `entered`/spend. Comparison, entered/spend, setting write, exact
readback and completion evidence run under one population lock held
throughout. Before entry, the named refusals include
`stale-expected-state`, `soul-not-found` and `invalid-request`; after entry,
never emit refusal. Off→on→off returns to the same boolean and passes, as the
owner explicitly accepted. This phase adds no population format, revision,
generation or counter; existing daemon-epoch binding stays in the challenge.

A no-op still spends and completes with equal before/after booleans. Publish
completion evidence only after the setting file and parent directory have been
logically flushed and the exact boolean read back under lock. Claim logical file
and directory flush only, never physical-flush guarantees. Existing `setSoulComputerUse` skips a same-value
write and its writer only renames a temp file; bot review must design the
no-op and flush/readback seam. Audit logging is best effort after
completion and never retries or changes the result.

The current population `withLock` has a blocking stale-lock issue: in
`agent-bot-identity/file-lock.mjs`, `STALE_LOCK_MS` is 30 seconds and the
default `keepLiveOwners` is false, so a long-held live lock can be reclaimed.
Resolve that behavior before claiming the held population lock excludes
concurrent writers. A `beforeWrite` seam may compose entered/spend after comparison and before
write or no-op completion; it is only a proposed internal seam, not a route or
public callback. Lock safety applies only to fixed reviewed adapters with the
existing order. Reserved journal, trust, identity and completion adapters must
not re-enter population; generic callbacks are prohibited. No per-effect
population schema/counter is added, but strict journal preparation/challenge/
effect unions and capacity review remain required.

Compute `effectPlanDigest` as SHA-256 of canonical UTF-8 JSON using the
existing `ownerDecisionCanonical` rules; all keys are required and unknown
keys refuse. `payloadDigest` is SHA-256 of exact canonical action bytes. Distinct
`actionDigest` is SHA-256 of the exact reconstructed display text used by p1.
Reconstruct that text from the retained action at preparation and verify both
digests; syntax validation alone is insufficient. Recompute the plan from the
retained action and expected boolean, then require exact plan-digest equality at
preparation, challenge, receipt, release and effect. Daemon epoch remains bound
by the existing challenge, not a setting field:

```json
{"account":"qwts","actionDigest":"<64 lowercase hex>","behavior":{"activeCalls":"continue-authorized-or-running","disabled":"deny-later-computer-use-tool-calls","permissionCheck":"each-call-and-after-approval-wait","stop":"none","turn":"continue-current-turn"},"desiredEnabled":false,"expected":{"enabled":true,"kind":"computer-use"},"operation":"soul.computer-use.set","payloadDigest":"<64 lowercase hex>","principal":"principal_00000000-0000-4000-8000-000000000002","requestId":"00000000-0000-4000-8000-000000000103","soul":"agent_00000000-0000-4000-8000-000000000001","v":1}
```

IDs and state are illustrative. Evidence shapes remain proposed for joint
review. An uncertain write is observation-only during reconciliation, unless an
exact retained request-linked completion already proves the outcome. The
current boolean alone never proves applied or refused and never triggers a
second write.

For this operation only, add strict conditional `effectPlanDigest` inside the
prepared challenge. The existing prepared wrapper embeds that challenge
verbatim; do not duplicate the field in its wrapper. Retain an immutable tuple of challenge nonce, both action digests, expected boolean and
plan digest. A strict journal preparation/challenge/effect union is required;
other operation schemas stay unchanged. Confirmation, receipt issuance and
one-shot release resolve that tuple; mismatch refuses. The d1 payload can remain unchanged only if joint review proves its nonce
resolves to this immutable challenge and binds the plan. Otherwise stop for joint schema review; do not treat
an unrecorded digest or d1 nonce alone as sufficient. Existing operations keep
their exact challenge and prepared schemas.

## Authorization and integration seams

Require the existing target grant and a separately owner-administered explicit
`soul.computer-use.set` operation grant. Preserve current selector semantics:
`souls:"*"` within the named account can cover this operation only when it is
explicitly in the operation list; each action still binds its exact soul.
Missing operation grants and legacy `ownerOperations` confer no authority.
Recheck principal, account/daemon enrollment, target grant, operation grant,
daemon epoch/watch, and revocation at existing preparation, issuance and pre-application boundaries.

Source seams to extend jointly: `lib/owner-decision-codec.mjs` action schema
and summary; `lib/owner-decision-challenge.mjs` plus
`lib/owner-decision-prepared.mjs` conditional challenge binding;
`lib/owner-decision-proof.mjs`/issuer for unchanged d1 and strict tuple
verification; `lib/broker/owner-grants.mjs` and
`lib/owner-operation-grants.mjs` explicit grant vocabulary; preparation/effect
evidence contracts and bounded journal records; bot setting route and
permission gate. The current bot setting route invokes whole-soul stop when
disabling, so it cannot serve this operation without the reviewed
permission-only consumer/API; local route behavior remains unchanged. No stop,
pause, or cancellation effect is allowed.

## Required shared vectors

- Positive true/false actions: exact canonical bytes, payload and plan digests,
  summaries, complete action text, p1 binding, challenge field embedded in the
unchanged prepared wrapper, and d1-to-nonce linkage.
- Strict parser negatives: absent/wrong-type/extra parameter, unknown
  operation or conditional field on another operation, changed action/target,
  malformed digest, duplicate/noncanonical JSON, invalid UTF-8, and frame or
  display bounds.
- Authorization negatives: exact soul/account cross-scope, unjoined/departed
  target resolution, no new operation grant, legacy grant only, wrong target,
  stale epoch/watch, changed nonce/action/plan, replay, and revoked authority.
  Check revocation at every boundary. Wildcard plus explicit operation covers
  only the exact action soul.
- State/concurrency/recovery: stale boolean refuses before entered; after entered
  only completion or indeterminate; off→on→off passes; no-op spends/completes;
  recovery requires linked completion; current value never proves outcome; no
  second write. Cover concurrent setting/turn races, crash/restart before and
  after durable spend/write, per-call/after-wait gates, running-call continuation,
  unchanged local presence, and no stop/pause.
- Check bounded journal reservations for the added plan/evidence before runtime
  admission; exhaustion refuses without eviction or a new request.
