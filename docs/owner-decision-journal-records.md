# Owner decisions: proposed bounded journal slots

This proposed, disabled storage graph supports [finite admission and retention](owner-decision-journal-capacity.md).
Payload caps below apply to canonical bytes or complete original ASCII tokens;
the reservation separately charges framing, scratch and filesystem objects.
An empty slot is explicit absence, never proof that an effect did not enter.
No production framing or storage codec is selected by this design.
The [shared fixed-frame vectors](../tests/fixtures/owner-decisions/fixed-frames-v1/README.md)
provide independent synthetic broker/daemon byte parity and cross-role refusal
checks; they do not validate typed lifecycle payloads or physical capacity.

## Exact administrative records

Use the merged UUID/digest/identity/seconds/epoch primitives, exact-object rules
and canonical local JSON; bounds are storage caps, never arbitrary spare fields.

- Acceptance is `{v:1,kind:"acceptance",requestId,principal,account,soul,operation,payloadDigest,namespaceDigest,acceptedAt,daemonKey,daemonEpoch,watchId,reservationBytes}`. namespaceDigest is the enrolled stable-namespace binding described in the capacity companion; reservationBytes is exactly 262144 at the broker or 524288 at the daemon, never caller input. This contains action references, not a second raw action.
- Authorization is `{v:1,kind:"authorization",requestId,payloadDigest,nonce,actionDigest,challengeDigest,presenceDigest,receiptDigest,exp,daemonKey,daemonEpoch,watchId}`. Every digest references its retained exact bytes; nonce/expiry/watch binding must match challenge and receipt.
- Outcome is `{v:1,kind:"outcome",requestId,payloadDigest,state,receiptDigest,outcome,source,reportingDaemonKey,reportingDaemonEpoch,at}`. state is applied/refused/cancelled/expired/indeterminate; outcome is the existing exact code/effectDigest object. source is broker/daemon. Reporting key/epoch are both null only for broker origin. Broker-origin applied is forbidden, and broker-origin refusal is possible only before release, never inferred after a possible effect. receiptDigest is null only before issuance. Daemon local outcome uses source daemon and its authenticated reporting identity; evidence validation still governs the finding.
- Reconciliation reference is `{v:1,kind:"reconciliation-reference",requestId,payloadDigest,originalDaemonKey,originalDaemonEpoch,reportingDaemonKey,reportingDaemonEpoch,at,finding,auditId,evidenceDigest}`. finding is indeterminate/applied/refused; all key/epoch fields are required, auditId is UUIDv4 and evidenceDigest is the existing canonical evidence reference. No untransmitted daemon fields are invented.

Every record must agree with immutable acceptance and its graph. No authority
comes from a caller supplying one of these administrative objects.

## Producer-owned slots

The broker retains only the bytes it actually owns. Its selected binding is
from its authenticated watch registry; reporting bindings come from independently
authenticated daemon requests. Neither echoed IDs nor an evidence digest proves
custody of the daemon's canonical evidence.

| Broker slot | Payload cap | Exact retained meaning |
| --- | ---: | --- |
| Acceptance | 4096 | Immutable original request ID, principal, account, soul, operation, payloadDigest, acceptedAt, selected daemonKey/epoch/watchId and local namespace binding. |
| Original action | 32768 | Exact canonical action bytes, not parsed/re-serialized transport input. |
| Prepared challenge | 32768 | Exact canonical local serialization of the challenge's existing exact field set. This is not a new transport encoding. |
| Presence | 4096 | Complete original ASCII p1 token. |
| Receipt | 4096 | Complete original ASCII d1 token. |
| Authorization | 4096 | Durable spent nonce and exact proof digests, receipt expiry, selected binding and authorized state, referencing the immutable preceding slots. |
| Release | 4096 | The existing exact successful check response, bound to this receipt and one live awaiting check; never reusable offline authority. |
| Initial outcome | 4096 | One monotonic lifecycle outcome plus its bounded authenticated report/reference, or a broker-origin cancellation/deadline/uncertainty finding without invented daemon evidence. |
| Indeterminate observation reference | 2048 | One bounded reporting key/epoch, auditId/evidenceDigest and unchanged original request/daemon binding. Replaceable only while indeterminate. |
| Terminal resolution reference | 2048 | One immutable applied/refused resolution reference with original and reporting key IDs/epochs and the existing auditId/evidenceDigest pair. |

No arbitrary JSON, credentials, daemon error text or unbounded history can
occupy these records' spare bytes. The action/challenge/proof and
check-response schemas remain the merged contracts. Public result codes remain
those in [the envelopes](owner-decision-envelopes.md).

| Daemon u16 ID / exact slot name | Payload cap | Exact retained meaning |
| --- | ---: | --- |
| 1 `acceptance-context` | 4096 | Immutable authenticated original action references/acceptance, enrolled broker namespace and selected daemon/watch binding. |
| 2 `original-action` | 32768 | Exact canonical action bytes. |
| 3 `prepared-challenge` | 32768 | Exact daemon-generated challenge in canonical local serialization. |
| 4 `presence` | 4096 | Complete original p1 token received with the decision. |
| 5 `receipt` | 4096 | Complete original d1 token received with the decision. |
| 6 `preparation` | 4096 | Exact typed preparation evidence, including fixed daemon-generated effectId and expected state. |
| 7 `successful-check` | 4096 | Exact verified live check response; restart never turns it into permission to resume. |
| 8 `pre-effect-refused` | 4096 | Exact effect.refused record; impossible after entered. |
| 9 `entered` | 4096 | Immutable effect.entered; consumption and uncertainty, not completion. |
| 10 `completed` | 4096 | Exact effect.completed with retained entered and whole-effect proof. |
| 11 `observation-pair` | 4352 | Exact combined indeterminate reconciliation and its typed observation preimage; replacement only through reviewed recovery. |
| 12 `terminal-pair` | 4352 | Exact combined immutable applied/refused reconciliation and its typed preimage. |
| 13 `linked-authoritative-event` | 16384 | Retained bounded revision source-event bytes verified against its authoritative journal and ownerDecision linkage; empty for cold changes. |
| 14 `local-lifecycle-outcome` | 4096 | Fixed typed local outcome/report metadata; no arbitrary errors or appended attempts. |

Each daemon pair is exactly canonical `{preimage,record,v:1}`. `record` is the
existing exact reconciliation object, at most 2048 canonical bytes; `preimage`
is its exact revision/cold observation, independently at most 2048 bytes.
Wrapper bytes (the complete pair length minus both component lengths) are at
most 256; the entire pair cap is exactly 4352. There are no extra keys or
relaxed component limits. SHA-256 of canonical preimage equals observedDigest.
Observation finding is indeterminate; terminal finding is applied/refused and
requires its retained completed/pre-effect refused basis before publication.
One frame binds both components; no separately visible preimage file exists.
The terminal pair publishes once before its terminal outcome/report. Observation
replacement remains a prerequisite; it cannot erase immutable proof.

Fixed names append `.record` to each exact slot name, plus `scratch.record`:
15 daemon names and 11 broker names. No extra preimage or reconciliation files
are permitted. The maximum 24 named entries/eight directories still applies to
all other charged artifacts. Frame role is fixed daemon/broker as appropriate;
ID overlap cannot cross that domain. Daemon directory keys remain the enrolled
namespace/request hash: recover requestId only from bounded acceptance-context
payload, validate its UUIDv4 and expected directory hash, then validate the full
context-bound frame and original-action agreement before trusting any finding.
Missing/invalid context refuses; the hashed directory is never parsed as UUID.

Preparation/effect/reconciliation/preimage shapes are exactly the
[effect companion](owner-decision-effect-evidence.md) and its private-descriptor
contract. Source-event capacity is an additional final-adapter prerequisite:
current approve copies an unbounded legacy proposal reason. The owner adapter
must bound its complete legacy input and generated linked event before entering,
or refuse with the existing local ceremony path retained. Existing local writer
semantics are unchanged. Package object/history bytes remain producer-owned
ordinary bot storage, not fictitious broker evidence or free staging capacity.

For exact publication order, interrupted admission and crash rules, see
[durable ordering and recovery](owner-decision-journal-recovery.md).
