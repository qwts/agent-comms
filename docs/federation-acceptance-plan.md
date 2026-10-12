# Federation: proposed migration and acceptance plan

**Status:** Proposed preparation for [ADR-0028](decisions/ADR-0028-cross-machine-hubs-and-federation.md)
and the [custody/delivery contract](federation-contract-proposal.md), which owns
the policy and numeric limits. This plan adds no implementation authority,
schema, codec or runtime acceptance evidence. The owner accepted the policy
choices on 2026-10-11 in the
[decision receipt](https://github.com/qwts/agent-comms/issues/28#issuecomment-6115481556);
independent crypto and provider review gates remain. Deployment and spending
need separate authorization. #120/#122 acceptance does not establish federation
runtime acceptance.

The [provider feasibility review](federation-provider-feasibility.md) records
Cloudflare candidate limits, cost assumptions and bounded local probes. It is
proposed engineering analysis, not provider approval or runtime evidence.

## Existing seams and migration review

These anchors pin the inspected [main revision](https://github.com/qwts/agent-comms/tree/0393530c323895f4395040fdd84447b1d7f57bb8).
They identify boundaries to preserve, not federation implementations.

| Seam | Proposed integration and required migration evidence |
| --- | --- |
| [State/checkpoints](https://github.com/qwts/agent-comms/blob/0393530c323895f4395040fdd84447b1d7f57bb8/lib/state.mjs#L278) | Current reader accepts checkpoint v1/v2 and validates exact fields. Review an explicit next format before adding enrollment, queues, outcomes or clock evidence; preserve checksums and structural validation. No guessed fields or replay of unknown events. |
| [Channel identity](https://github.com/qwts/agent-comms/blob/0393530c323895f4395040fdd84447b1d7f57bb8/lib/channel-state.mjs#L5) | Keep persisted origin/channel IDs and local endpoint equality. Remote resolution adds relay/origin context; it must not reinterpret local addresses or turn remote membership into local channel fanout. |
| [Pairing](https://github.com/qwts/agent-comms/blob/0393530c323895f4395040fdd84447b1d7f57bb8/lib/broker/pairing.mjs#L70) / [mailbox admission](https://github.com/qwts/agent-comms/blob/0393530c323895f4395040fdd84447b1d7f57bb8/lib/broker/mailbox.mjs#L67) | Keep local daemon vouching, receive checks and principal boundaries. Add a distinct approved remote-assertion boundary; destination mailbox copy and protected transport outcome must commit together. Notify only after commitment. |
| [Tasks](https://github.com/qwts/agent-comms/blob/0393530c323895f4395040fdd84447b1d7f57bb8/lib/broker/tasks.mjs#L32) | Preserve the single authoritative revision/event commit. Review its atomic outbox seam for origin-qualified task commands, including stable command outcomes; no independently writable destination task replica. |
| [A2A routes/outbox](https://github.com/qwts/agent-comms/blob/0393530c323895f4395040fdd84447b1d7f57bb8/lib/broker/a2a-outbound.mjs#L29) | Reuse bounded configuration, private credential references and uncertainty patterns where applicable. Do not copy its principal authentication or ambiguous-send reconciliation as federation receipts. Never auto-convert an A2A route or queued request into trusted federation traffic. |
| [Retention](https://github.com/qwts/agent-comms/blob/0393530c323895f4395040fdd84447b1d7f57bb8/lib/retention.mjs#L44) / [census](https://github.com/qwts/agent-comms/blob/0393530c323895f4395040fdd84447b1d7f57bb8/lib/broker/census.mjs#L9) | Keep local API dedupe, body/gap/ack and discovery authorization unchanged. Add separately budgeted transport outcomes and scoped expiring advertisements. Test the proposed rollback refusal independently of the existing local monotonic clock behavior. |

Before the first format-writing build, review the complete durable inventory:
per-relay trust/configuration revisions and credential references; immutable
origin outboxes; relay custody; destination outcomes; task-command outcomes;
transmission/receipt/expiry evidence and clock floors. Select field names,
canonical encoding and storage layout through engineering review after policy
acceptance, not through this plan. Credential material remains outside exported
state; remote assertions never enroll a local soul.

Generate disposable histories using actual released readers, then upgrade and
restart through append, compaction and interrupted replacement. Preserve every
existing message ID/sequence, ack/gap, direct-send/post retry result, channel
snapshot/address, task revision/summary and A2A uncertainty outcome. Zero remote
configuration must preserve local operation. Enrollment remains empty until an
explicit approved ceremony; migrating a broker origin ID is not peer enrollment.

Use the [state-format acceptance harness](../tools/acceptance/README.md) as the
pattern for pinned sources, generated fixtures and before/after byte hashes.
Add the new compatible-reader cases after implementation; the current harness
does not cover federation. Unsupported/corrupt committed state must refuse
before mutation. Never open upgraded state with an old binary: the documented
released-reader torn-tail mutation prevents claiming unconditional downgrade
safety. A selected-binary compatibility check must precede any unsupported old
reader probe against authoritative state. Test probes use disposable copies.

## Handoff and failure matrix

Each case checks durable origin/relay/destination facts separately. Record
logical IDs, signed-envelope/receipt digests, outcome states, retained-byte/count
usage and mailbox/task revisions; logs and artifacts contain synthetic data and
no credentials. Repeat relevant cases after restart and compaction. A transport
receipt is neither a mailbox ack nor evidence of work.

| Failure or adversarial case | Required observable result |
| --- | --- |
| Origin admission fails before durable commit, or its response is lost after commit | No accepted state before commit; after commit, API-key retry returns the same logical envelope/outcome within its window. An ambiguous writer failure stops further mutation until recovery. |
| Relay commits custody but its receipt is lost; relay or origin restarts | Origin retains retry body/evidence. Same-ID handoff returns original custody; destination sees at most one committed copy. Relay custody alone cannot produce destination commitment. |
| Destination commits copy/outcome but receipt is lost | Retry/query returns the original signed commitment. Run on day nine, immediately before expiry, and after recipient body expiry; API-key expiry cannot erase transport protection. |
| Body, escaped record, queue or protected-outcome count/byte cap is full | Admission reserves neither partial body nor outcome. Origin refusal spends no API-key/rate admission; destination refusal advances no mailbox sequence. Downstream refusal does not undo an accepted origin outbox. Test exact boundaries, all-relay aggregate caps and lowering a cap without deleting accepted state. |
| Same logical ID arrives with changed digest, relay, origin or key epoch | Conflict or authentication refusal; no extra copy or widened authority. Legitimate rotation/restart cannot reset the dedupe namespace. Reject forged destination receipts. |
| Deadline/skew boundary or backward clock movement | Test immutable expiry, the 120-second creation skew, exact body deadline and protected-outcome deadline. Retry never renews lifetime; detected rollback refuses the specified expiry-sensitive operations. |
| Revoke peer/export/import or remove route before/after a possible transmission | Stop admission/retry/discovery where revocation is known. Never-transmitted loss is distinguishable from uncertain delivery; preserve protected outcomes and committed inbox copies. Confirm pending loss on removal; re-add never replays discarded mail. |
| Connection drops during task command or mailbox handoff | Queue/resume the same authenticated command/envelope. One origin owns task revision; duplicate/stale transitions cannot execute another revision. Destination inbox read/watch/ack remain local and independently authorized. |
| Destination commits while disconnected from its account daemon, or wake permission changes | Mail remains durable. Only destination-local authority dispatches a wake after commit; reconnect/timer cannot bypass current consent, grants or shared wake budgets. |
| Two concurrent hubs advertise identical soul names/IDs, or one is stale/revoked | Explicit selected route resolves one authorized origin. Filter before discovery counts/pages; no cross-hub content, keys, credentials or census leakage, automatic failover or channel bridge. |

## Ownership and execution order

The owner policy is accepted; the sequence below remains gated on independent
crypto review and the existing provider review boundary.
Every slice has a reviewer-visible storage/security boundary before the next
depends on it. The epic is not a third runtime implementation.

| Slice | Issue accounting and acceptance responsibility |
| --- | --- |
| Namespace, enrollment, configuration and migration | Shared prerequisite: #118 verification/address requirements and #119 scoped-hub requirements. Implement and estimate once; both leaves cite the same migration/authority evidence. |
| Durable origin/relay/destination state; outbound reconnect service/client | #118 owns delivery, bounded retries, receipts, task commands, local wake integration and two-machine partition/crash acceptance. #119 reuses this transport. |
| Multihub CLI/library operations and discovery | #119 owns add/list/remove, explicit selection, isolation and zero-config local behavior. #118 cites the same remote/reachable census evidence instead of a second census build. |
| Architecture/release closeout | #28 records accepted ADR, existing child mapping, provider custody/persistence/cost review and the owner's production sequencing gate. GeniusBar consumes broker APIs later; host packaging is not added to leaf implementation scope. |

Keep #28/#118/#119 open until their original requirements have runtime evidence
and solution-as-built closeouts. Preparation is shared work, not three repeated
estimates; this plan neither reduces remaining implementation estimates nor
adds a second roadmap. Remote channels and remote owner-presence authority
remain outside this proposed direct/task scope.
