# Private daemon evidence admission

This disabled pure module validates byte and causal bindings. It has no network
route, journal writer, signature verifier, credential lookup or production
enablement. A successful result is evidence, never authorization or `mayApply`.

`createOwnerDecisionDaemonEvidenceContext` takes independently custody-checked
retained `originalActionBytes`, `acceptanceBytes` and `namespaceDigest`. It runs
the existing action/admission codecs and retains its own snapshots. Preparation,
effect and reconciliation results are opaque tokens owned by that context;
foreign tokens refuse. `inspect` returns copies, not mutable retained state.

## Distinct records and versions

- Daemon preparation is v2, at most 4096 bytes, with odd `trustVersion` from
  1 through 1023. Public challenge and broker `{challenge,stage,v:1}` retention
  stay unchanged. Native `brokerLocalRevision` is not daemon `trustVersion`.
- Effects remain v1, at most 4096 bytes. Preparation digests hash the exact
  daemon preparation bytes, never the broker wrapper.
- Reconciliation pairs remain canonical `{preimage,record,v:1}`, at most 4352
  bytes, with each component at most 2048 and wrapper allowance at most 256.
- Linked authoritative revision/decision events retain `schemaVersion:1` and
  the exact original writer JSON plus LF. Sorted canonical reserialization is
  not their digest preimage.

Preparation admission reuses the existing action, challenge and public stage
binding. Its clock check establishes historical consistency only.
`checkPreparationTrustVersion(token,{currentTrustVersion})` checks an explicitly
supplied fresh version for legal range and equality. It neither reads current
trust nor performs final effect-entry authorization.

## Retained graph and ceremony assertions

Effect admission requires `retainedGraph` with exactly `phase`, `enteredBytes`,
`completedBytes` and `refusedBytes`. Null is an explicit absence assertion.
Refusal requires absent entered/completed records and identical retained refusal
bytes. Entry requires identical retained entry and absent completion/refusal.
Completion requires matching retained entry and completion bytes with no refusal.
The entered token must belong to this context and this preparation/receipt.

Revision completion additionally requires `linkedEventBytes`, independently
retained `retainedLinkedEventBytes` and `retainedLinkedEventSequence`. Candidate
and retained bytes must be equal, match the completion digest and have the exact
request linkage. The retained sequence must match the completion sequence.
Applying edit completion still requires its working digests; a linked head alone
does not establish the entire effect.

Reconciliation requires an explicit separately validated `ceremony` assertion:
`requestId`, `namespaceDigest`, `reportingDaemonKey`, `reportingDaemonEpoch`,
`finding`, `retainedPhase`, `entered`, `matchingState` and `ownerLocalCeremony`.
Reporter fields must match exactly;
there is no fallback to original daemon identity or changed-reporter acceptance
without this context. Applied requires a completed basis; refused requires a
pre-effect refused basis and explicit no-entry assertion. Every finding requires
the explicit owner-local ceremony assertion. Applied additionally requires
matching state and retained phase `completed`; refused requires retained phase
`refused`. Those phases describe the validated graph, not its reported finding.
An indeterminate observation has no basis and remains indeterminate. Its graph
may be `absent` (no preparation or entry), `prepared` (preparation without entry),
`entered` (entry present), or `uncertain` (explicit caller-supplied entry presence).
It does not require entry merely because its finding is indeterminate.
Any assertion that entry exists requires a validated preparation. An uncertain
graph may explicitly assert no entry and no preparation; uncertainty supplies
neither missing evidence nor authority.

The pure module cannot authenticate these assertions, prove durable absence,
read actual state, establish owner presence, or validate caller custody. The
future authenticated caller must validate the complete retained graph, actual
current observation, owner-local ceremony and reporting authority before use.
No broker reconciliation route or reference publication is added here.

## Contract provenance and remaining acceptance

Preparation-v2 inputs are the separately pinned Comms
[specification vectors](../tests/fixtures/owner-decisions/preparation-v2/README.md)
from `bf0b705c`. They are specification inputs, not captured daemon writer output.
Daemon
[#1052](https://github.com/qwts/agent-bot-identity/commit/fc85d9bfcaca5f3bc73336dfd803834971907311)
adds expected-observation trust writers;
[#1053](https://github.com/qwts/agent-bot-identity/commit/13ab9a7878d4a0826162400986c21ccb7ca88d0c)
adds original linked writer events; and
[#1054](https://github.com/qwts/agent-bot-identity/commit/36a6ecde5a8a49d80d32895a120fb272e412ab2f)
adds disabled reconciliation pair writers against its existing v1 preparation.
The #1055 companion supplies observation negatives, not a preparation-v2 writer.
Subsequently merged
[#1056](https://github.com/qwts/agent-bot-identity/commit/0705b08f59ad8ac3a3a7e51630ff0c92fa2bfb47)
implements daemon preparation-v2 with a live trust version and the final entry
version check. Its existence does not establish composition with this module.

The existing v2 completed/reconciliation vectors contain summary digests without
the original linked event and observation preimages. Those summaries alone must
not pass completion/pair admission. The new
[synthetic companion](../tests/fixtures/owner-decisions/daemon-admission-v2.json)
provides typed observation preimages and original event framing with rebound
digests. Its [independent Python generator](../tests/fixtures/owner-decisions/daemon-admission-v2/generate.py)
pins its unchanged Comms inputs and the daemon writer/pair contract commits.
It is synthetic conformance evidence, not captured daemon-v2 writer output.
Actual
daemon-v2 producer composition, authenticated transport, durable delivery and
owner-local reconciliation remain separate acceptance gates.
