# Owner decisions: proposed bounded journal slots

This proposed, disabled storage graph supports [finite admission and retention](owner-decision-journal-capacity.md).
Payload caps below apply to canonical bytes or complete original ASCII tokens;
the reservation separately charges framing, scratch and filesystem objects.
An empty slot is explicit absence, never proof that an effect did not enter.
No production framing or storage codec is selected by this design.

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

| Daemon slot | Payload cap | Exact retained meaning |
| --- | ---: | --- |
| Acceptance/context | 4096 | Authenticated original action references/acceptance, enrolled broker namespace and selected daemon/watch binding; immutable after admission. |
| Original action | 32768 | Exact canonical action bytes. |
| Prepared challenge | 32768 | The exact saved challenge in canonical local serialization. |
| Presence | 4096 | Complete original p1 token received with the decision. |
| Receipt | 4096 | Complete original d1 token received with the decision. |
| Preparation | 4096 | Exact typed preparation evidence, including fixed daemon-generated effectId and expected state. |
| Successful check | 4096 | Exact verified live check response; restart never converts it to permission to resume an effect. |
| Pre-effect refused | 4096 | Exact effect.refused record; impossible after entered. |
| Entered | 4096 | Exact effect.entered record; immutable request-linked consumption and uncertainty, not completion. |
| Completed | 4096 | Exact effect.completed record; requires retained entered and whole-effect proof. |
| Indeterminate reconciliation | 2048 | Exact typed reconciliation record; replaceable bounded observation only. |
| Terminal reconciliation | 2048 | Exact immutable typed applied/refused reconciliation record. |
| Observation preimage | 2048 | Canonical typed revision/cold observation whose digest the current reconciliation references. |
| Resolution preimage | 2048 | Canonical typed observation for the terminal resolution; retained independently. |
| Linked authoritative event | 16384 | Bounded retained source-event bytes for a revision effect, verified against its actual authoritative journal and ownerDecision linkage; null for cold changes. |
| Local lifecycle outcome | 4096 | Fixed typed local outcome/report metadata; no arbitrary error strings or appended attempts. |

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
