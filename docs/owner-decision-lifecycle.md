# Owner decisions: proposed lifecycle and native adapter

This disabled draft completes the [schemas](owner-decision-wire.md) and
[envelopes](owner-decision-envelopes.md); joint comms/bot/native review remains required.

## Durable transitions, races and reconciliation

All request IDs are scoped to the broker installation but globally unique
within it, including across principals. A conflicting ID refuses without
disclosing its owner. Persist an ID and payload binding before forwarding
preparation. The broker journals its selected watch, accepted challenge, issued
receipt bytes, release and result; the daemon journals its challenge, prepared
expected state, consumption and request-linked mutation evidence. Writes must
survive acknowledged process/OS restart: flush data and required directory
entries before acknowledging the transition or entering an effect. Write failure
refuses work; no best-effort audit log substitutes for either durable journal.

| From | Allowed transition / action |
| --- | --- |
| Absent | Authenticate/authorize, persist `preparing`, forward once to the selected watch. No watch refuses without creating work. |
| `preparing` | Accept exactly matching daemon preparation into `prepared`; validation failure becomes `refused`. Principal cancellation becomes `cancelled`; deadline/no recovered preparation becomes `expired`. No application is possible. |
| `prepared` | On valid fresh p1 and current authority, persist spent nonce, exact receipt and `authorized` before one delivery attempt. Principal cancellation becomes `cancelled`; deadline becomes `expired`. Missing selected watch returns daemon-unavailable without spending. |
| `authorized` | First valid daemon check atomically rechecks principal/account/daemon pairings, both grants, keys, epoch and all deadlines, persists `released`, then returns `mayApply: true` once. Revocation, expiry or validation failure before release becomes `refused`. Delivery loss never causes automatic reissue. |
| `released` | Daemon may report applied/refused/indeterminate. Lost check response, restart or loss after release without proven result becomes `indeterminate`; neither party automatically retries mutation. |
| `applied`, `refused`, `cancelled`, `expired` | Stable outcomes; identical requests/reports return retained status. No new presence, release or effect. |
| `indeterminate` | Retain all evidence; only explicit owner-local reconciliation may record proven applied/refused. Otherwise retain indeterminate. Never automatically retry an effect. |

This is same-machine routing using the common OS wall clock, not a distributed
clock agreement. Timestamp jumps fail closed; preparation allows symmetric
30-second reported-time skew. The authenticated prepare event carries the original broker `acceptedAt`. For
a request accepted at that time,
require `preparedAt >= max(0, acceptedAt - 30)` and
`preparedAt <= brokerNow + 30`. Preparation expiry is exactly the minimum of
`preparedAt + 180`, `acceptedAt + 180` and stage expiry (omit the stage term
when there is no stage). Accept prepared data only while brokerNow is strictly
before every applicable deadline; skew never extends the original broker/stage
deadline. All operands/results must remain nonnegative safe integer seconds. The native prompt queue/time limit never extends any
deadline. Cancelling races confirmation under the broker journal transaction:
exactly the first durable transition wins. Cancellation after authorization
reports authorized/released/outcome and cannot claim the work was cancelled.

The check is the authorization linearization point. Revocation that precedes
its durable release refuses; revocation after it cannot recall that already
authorized attempt. The successful response is bound to one live awaiting
check, not an offline permission to be saved/replayed. The daemon checks
`now < receipt.exp` again at entry to the final mutation; it refuses if that
deadline passed after release. An effect begun before expiry may finish after
it.

Bot's asynchronous per-soul coordinator verifies the receipt/presence/challenge,
serializes concurrent decision attempts and awaits the online check outside the
existing synchronous mutation lock. After its first matching success, a final
synchronous adapter acquires the same lock used by local writers, rechecks the
pending proposal/current head or prepared cold-wake/session/configuration state,
stage bytes and receipt expiry, durably marks consumed, then calls existing
validated mutation logic without an await. A local write racing that interval
causes refusal when expected state differs; release never bypasses that check.
The proposed [typed effect evidence](owner-decision-effect-evidence.md) defines
preparation, request linkage, private preimages and lock/crash requirements for
revision and settings/secret changes. Joint bot review must validate those
adapters before enabling any operation; static vectors are not runtime proof.
Never nest public lock-acquiring operations or introduce generic auth callbacks.

Retain compact tombstones for every durably accepted ID, including cancelled,
expired and refused preparations as well as spent/released IDs, until the
installation is explicitly decommissioned. IDs never become fresh after
receipt expiry or compaction. Reject before acceptance (for example, no live
watch) creates no ID binding or tombstone.
Retain full unsettled evidence and snapshots until owner-local reconciliation.
Unsettled package/webhook snapshots continue consuming the staging byte/count
quotas until reconciliation; neither journal compaction nor re-pair bypasses
those quotas. Before enabling the capability, companion broker/bot review must
fix finite installation limits for accepted-ID count, retained full-evidence
count and total journal bytes, plus a proved bounded reservation per accepted
request for every permitted transition, outcome and owner-local reconciliation.
Missing limits/reservation enforcement keeps the capability unsupported. Before
forwarding a new preparation, reserve its ID/tombstone and complete lifecycle
write capacity; refuse admission with `journal-capacity` if unavailable. Never
evict/reuse accepted IDs or drop unsettled evidence to admit new work. Existing
status and read-only reconciliation remain available at capacity, using reserved
write space. Compaction/recovery must preserve those reservations; exhausted
stage quotas likewise refuse new staging. Proposed [capacity](owner-decision-journal-capacity.md) and
[slot budgets](owner-decision-journal-records.md) remain unsupported until
backend review, reservation and recovery are implemented.

Detailed settled outcome retention follows the installation's explicit retention
policy; if details have been compacted, status returns the retained state with
`outcome: { code: "details-retired", effectDigest: null }`, never unknown/fresh.

Reconciliation is an explicit local owner ceremony in the target account using
agent-bot's existing local owner gate with no comms-principal override and no
soul caller, not a new principal wire operation or a new grant. It only inspects journals and actual revisions/settings and records
evidence; it cannot apply/repair an effect, restore a principal/key, reset an ID
or mint another receipt. The local owner may inspect a stranded request after
the original principal is revoked. The daemon reports the resolved outcome
under its current approved daemon pairing using the original request binding;
the broker permits an epoch change only for this owner-local evidence report,
never for check, preparation or application. `reconciliation` is exactly
`{ auditId, evidenceDigest }`, referencing the durable local owner-gate audit
and evidence record. It is accepted only for an indeterminate request. Broker
audit records both original and reporting daemon epochs. The echoed audit ID
alone proves no human ceremony; the reviewed daemon implementation must enforce
the local gate and read-only reconciliation boundary.

An applied finding needs durable request-linked mutation evidence plus matching
actual state. Matching a desired setting already present before the request
proves nothing. Refused requires durable evidence that this attempt never entered
an effect. Partial application, missing evidence, preexisting matching settings
or unknown concurrent changes retain indeterminate. Any new effect requires a
new ID, a fresh preparation and human ceremony under current authority.

## Native adapter boundary

The signed native host keeps the principal in its approved data-protection
keychain/access group and owns the custody-checked broker connection, namespace
and identity. JavaScript receives public results through typed operations; it
cannot select credentials, auth envelopes, brokers, channels or store items.
Ordinary transport availability does not advertise owner-decision support.

The reviewed native presence adapter takes a validated prepared challenge and
the exact action bytes, checks equality against its saved original request,
reconstructs the typed summary/action and validates the enrolled key/namespace
and both display bounds itself. It accepts no caller-supplied prompt or action
string override. It calls the protected native p1 issuer with that reconstructed
action and nonce, then returns the complete p1 token and public key ID for this
request to its native broker transport. It exports no principal/presence seed,
arbitrary signing facility or generic secret RPC. The existing JS
`keydPresence` convenience function returns authorization metadata rather than
the raw p1; reusing it unchanged does not implement this adapter.

Current legacy keyd storage is insufficient. A native implementation must retain
the existing p1 protocol and atomic first-use seed invariant while establishing
data-protection custody and approved code identity. GeniusBar ships a separately
pinned native helper; updating its bot JavaScript pin alone changes neither
native source nor entitlements. A compatible reviewed native/bot/comms tuple,
real allowed-host/denied-Node/denied-security tests and explicit revoke-before-
re-pair cutover are prerequisites to enabling this interface. Missing custody,
old helpers, unavailable presence, single-account and Windows paths fail visibly
without credential export, automatic fallback or runtime claims.
