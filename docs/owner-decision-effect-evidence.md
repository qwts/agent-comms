# Owner decisions: proposed typed effect evidence

Source: bot main `2f4f9343e7f5713f7442c974e3f3f3fbd6602164` plus reviewed revision-core PR986 `0a16d7ca80ba99d15e4aac33b1ef4de78f9d3a58`. This companion to [the lifecycle](owner-decision-lifecycle.md) is proposed for joint review. It adds no route, custody, production crypto or mutation enablement. All #77 R1–R4 requirements remain open.

All objects have exactly their listed keys. IDs, digests, revisions, account/soul/principal, seconds and daemon epoch use the merged comms primitives. `seq` is an integer 0–9,999,999,999 matching the existing ten-digit journal filename; refuse exhaustion. Boolean fields are explicit. `stage` and other nullable fields use explicit null. Canonical bytes and their SHA-256 digest are retained together; an external caller cannot supply evidence JSON. Evidence contains no URL, webhook key, paths, reason/error text, token, log, changed-path list or raw harness session ID. The authenticated action/challenge/receipt bytes are separately retained in the reserved request journal.

The [preparation record](owner-decision-preparation-evidence.md), [private digest preimages](owner-decision-private-descriptors.md) and [lock/crash matrix](owner-decision-locking.md) are part of this proposed specification.

## Early preparation refusal

A broker admission refusal has no daemon preparation/effect evidence. A daemon that rejects preparation before a valid preparation record reports the existing typed validation/authority/deadline outcome with effectDigest=null (and receiptDigest=null before issuance); broker retains its accepted-ID tombstone and selected-watch report. It must never manufacture a preparationDigest or effect.refused. Once a valid preparation exists, the effect.refused shape below can prove that the final attempt refused before entering any effect. Neither path interprets absence of completed as proof of refusal.

## Request-linked authoritative effect records

Every evidence record has common fields `{v:1,kind:"effect",requestId,payloadDigest,preparationDigest,receiptDigest,effectId,phase,at,detail}`. effectId is the UUIDv4 fixed in this request's durable preparation, receiptDigest is a digest (null only for pre-issuance refusal), at is Unix seconds. phase is `refused|entered|completed`. Each canonical record is at most 4096 bytes. No freeform strings/JSON/errors. Request journal reserves slots for all three phases; at most one of refused/entered is possible, and completed requires entered. Durable entered is consumption and the start of an uncertain effect, not success.

`refused` detail is exactly `{code}` with a fixed reason enum: `expired|expected-state-changed|proposal-not-pending|stage-invalid|target-unavailable|validation-failed|storage-unavailable|trust-unavailable`. Refused may be written only before any authoritative revision/settings/secret/working-file change. A failed durable entered write cannot proceed to an effect. If any visible publication may have happened, do not invent refused.

`entered` detail is `{kind:"revision",beforeRevision,afterRevision,proposalId,apply}` or `{kind:"cold-wake",beforeDigest,afterDigest}`. Nullable fields are explicit. before/after cold digests hash the exact typed `{setting,webhookDigest,resume,v:1}` state above. afterRevision is known from immutable validated package/proposal; reject keeps beforeRevision. Adopt has beforeRevision=null. apply is true only edit(true).

`completed` revision detail is exactly `{kind:"revision",journalSeq,journalRecordDigest,beforeRevision,afterRevision,proposalId,working}`. The new authoritative revision/decision journal event includes a narrow typed `ownerDecision:{requestId,payloadDigest,receiptDigest,effectId,preparationDigest}` field. It is the request linkage; a coincidentally matching unlinked legacy event proves nothing. `working` is null except edit(true), then `{rootDigest,inventoryDigest}` after durable bounded publication and revalidation. For approve/reject/adopt/edit(false), one linked authoritative event and durable immutable objects establish the requested semantic mutation; history mirror remains best effort. Reject links its decision even though head stays unchanged.

`completed` cold detail is exactly `{kind:"cold-wake",beforeDigest,afterDigest,settingsDigest,webhookDigest}`. settingsDigest hashes the resulting normalized selected-soul setting, not the whole mutable global settings map. webhookDigest is null when deletion completed, otherwise the resulting frozen configuration digest. Completion record is appended only after settings and secret publications/deletion and required file/directory flushes, then exact selected-soul state readback under the same locks. Existing audit strings alone never constitute completion.

## Reconciliation

Exact record `{v:1,kind:"reconciliation",requestId,payloadDigest,effectId,auditId,originalDaemonKey,originalDaemonEpoch,reportingDaemonKey,reportingDaemonEpoch,at,finding,basisDigest,observedDigest}` at most 2048 bytes. auditId is UUIDv4; effectId is the saved preparation UUIDv4, or null only for indeterminate when that durable preparation is unavailable; key IDs/digests are lowercase64hex, epochs positive safe integers, at seconds. finding is `applied|refused|indeterminate`. basisDigest references one typed durable request-linked effect/authoritative event: completed for applied, a proven pre-effect refused record for refused. It is null only for indeterminate with absent proof. The [lock/crash rules](owner-decision-locking.md#lock-and-crash-rules) define how an explicit owner-local ceremony may derive completed evidence for record-only revisions from an already linked authoritative event, without performing an effect. Missing completed, equal preexisting settings, or entered without completion cannot justify refused. observedDigest hashes the typed current revision or cold state. Local owner gate is required, with no principal override and no soul caller. The ceremony reads and reports only; no apply/repair/replay/rekey/ID reset. Repeated unchanged reconciliation reuses the existing record and does not append unbounded attempts. At most one indeterminate observation slot and one terminal resolution slot are reserved; subsequent changed but still-indeterminate observations replace the bounded observation slot via atomic durable update, never discard or replace the original immutable entered record, authoritative linked event, completed/refused proof, or unsettled snapshots. Original proof retention is independent of the replaceable observation slot. Terminal outcomes never change.


## Normal result digest mapping

The jointly reviewed disabled daemon producer reports `effectDigest` as SHA-256
of the exact canonical completed record for applied, or the exact canonical
pre-effect refused record for proven final refusal. It hashes neither the frame,
receipt, preparation nor a reconstructed summary. Early preparation refusal has
no effect record and uses null. The producer also emits null for indeterminate:
entered alone proves neither application nor refusal. The broker's broader
nullable-digest storage schema is unchanged; this producer rule does not narrow
its parser. These hashes require validated durable causal evidence, not caller
JSON. Reconciliation `evidenceDigest` separately hashes its canonical
reconciliation record; `basisDigest` references the completed/refused proof.

[effect-outcomes-v1.json](../tests/fixtures/owner-decisions/effect-outcomes-v1.json)
fixes normal-result mappings for all shared completed/entered variants,
all eight final refusal reasons, three early refusal codes and absent proof.
It pins the source fixture hash; the consistency command below checks exact
UTF-8 preimages. Live report admission remains producer integration work. No d1/check field or mutation authority is added.

Final refused codes are fixed: expired → deadline-expired; expected-state-changed,
proposal-not-pending, stage-invalid, target-unavailable and validation-failed →
validation-refused; trust-unavailable → authority-refused; storage-unavailable →
storage-refused. Target disappearance is a changed precondition, not a new broker
authority decision. Trust is rechecked under the final mutation locks. The new
storage-refused code requires a daemon-origin durable pre-effect refusal digest;
broker-origin or null-proof storage refusal is invalid. Failure to persist that
refusal remains storage failure/uncertainty, never evidence that no effect occurred.

## Shared specification vectors

[effect-evidence-v1.json](../tests/fixtures/owner-decisions/effect-evidence-v1.json)
records canonical bytes, digest and encoded length for every existing operation's
preparation/entered/completed shapes, final pre-effect refusal and reconciliation.
Maximum-width templates enumerate the same legal operation unions, including a
current resume setting with retained webhook configuration. They exercise record
field widths independently, not a signed live transaction. The enforced caps
remain 4096/4096/2048 bytes; the largest templates are recorded by this command:

```sh
node tools/acceptance/owner-decision-effect-vectors.mjs
```

The command checks exact fixture field sets/types, canonical bytes/hashes,
preparation linkage, byte caps and nine recovery classifications, including
missing proof, preexisting matching cold values and edit(true) head-only proof.
It imports no production parser/adapter/journal. It proves specification
consistency, not durable storage, real owner ceremony, race safety or runtime
reconciliation conformance. Those implementation/live gates remain required.
