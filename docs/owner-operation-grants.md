# Scoped owner-operation grants

This [#77](https://github.com/qwts/agent-comms/issues/77) prerequisite stores
explicit account/soul/operation `ownerGrants` required by
[ADR-0077](decisions/ADR-0077-owner-decisions-through-the-broker.md).
It enables no owner-decision route, receipt issuance, native presence or mutation.
Existing target checks and local consent behavior remain unchanged.

## Owner administration

Use the broker's existing private administrator channel:

```sh
agent-comms admin principal-owner-grants PRINCIPAL --grants-json '[{"account":"alice","souls":"*","operations":["revision.approve","revision.reject"]}]'
agent-comms admin principal-owner-grants PRINCIPAL --grants none
agent-comms admin principals
```

The plural command replaces the whole `ownerGrants` list for one currently
approved principal. Supply exactly one of `--grants-json JSON` and
`--grants none`; `none` clears every scope. The CLI bounds the input to 16,384
UTF-8 bytes before parsing. The broker validates and copies the typed list
before appending an event. Admin listing reports `ownerGrants`, the independent
target `grant`, and the deprecated global `ownerOperations` field.

Each entry has exactly `account`, `souls`, and `operations`:

- `account` is one explicit, case-sensitive account name, using the existing
  owner-decision grammar `[A-Za-z_][A-Za-z0-9_.-]{0,63}`. No account wildcard or
  inferred principal account is accepted.
- `souls` is `"*"` for that account, or a nonempty list of at most 32 distinct
  canonical soul IDs. IDs use the existing owner-decision grammar: `agent_`
  followed by a lowercase UUID, version 1 through 8 and RFC variant. This is
  separate from the request UUIDv4 grammar and does not change messaging pairing.
- `operations` is a distinct subset of `revision.approve`, `revision.reject`,
  `revision.adopt`, `revision.edit`, and `cold-wake.set`. An empty list grants
  nothing. Wildcards and unknown names refuse.

There are at most 32 entries and 128 explicitly enumerated soul IDs across the
list. Wildcard selectors consume an entry but enumerate no IDs. The normalized
list must also fit 16,384 canonical UTF-8 bytes: JSON object keys sorted
alphabetically, without whitespace. These structural bounds already constrain
the maximum below that secondary byte ceiling.

Soul and operation lists are sorted. Entries sort by account, then the JSON
spelling of the normalized soul selector, using ASCII order. Duplicate
account/selector pairs refuse, even if their operations differ. Distinct
overlapping selectors are allowed: matching operations union only inside the
same exact account. For example, `alice/*` can grant rejection while an
additional `alice/[SOUL]` grants approval; that soul receives both, another
soul in `alice` receives only rejection, and a target in `bob` receives neither.

Only private admin dispatch accepts this change. Principal, account, daemon
and remote bridge callers cannot enroll themselves through the ordinary broker
request channel. Grant replacement cannot create or revive an identity. This
uses existing administrator channel protection, without a new credential path.

## Persistence and legacy compatibility

New principals start with `ownerGrants: []`. Missing scopes in old events or
checkpoints authorize zero. Replacement survives event replay and checkpoints.
Revocation deletes the principal and its scopes; fresh pairing starts empty.
Malformed stored entries, unsorted lists, duplicate selectors and nonempty
scopes on pending principals refuse restoration. The field is nested in the
existing principal row; checkpoint format remains version 3.

The singular `principal-owner-grant --operations ...` command remains available
for compatibility and emits a deprecation notice to stderr. It only replaces
the legacy global `ownerOperations` list and keeps its existing result shape.
That field is **nonauthorizing**, even when an existing target grant is broad.
No migration or fallback converts it into scoped authority, and changing it
does not modify `ownerGrants`. Administrators must explicitly configure scopes
using the plural command. Legacy stored-list validation remains intact.

## Authority boundary

The internal pure `ownerGrantCovers(state, principalId, target, operation)`
helper checks current approved principal, account and daemon state, validates
the stored scopes, and intersects their matching operations with the existing
target `covers` semantics. Any malformed state refuses. It never consults
`ownerOperations`, mailbox receive allowlists, or whether a soul is joined.

Its `target` must be independently resolved through the authenticated account
daemon. An ordinary `{account, agentId}` object cannot prove its own provenance;
the helper is not a request handler and must never be exposed as accepting a
caller-asserted target. A stale or conflicting mailbox soul row cannot replace
that daemon resolution. The future adapter must also check enrolled keys,
daemon epoch, proofs, deadlines and all current grants at each required
boundary, including final durable release. A receipt cannot preserve an old
grant after the owner changes it.

This storage/admin slice does not implement that adapter or advertise
owner-decision support. Existing [principal target queries](principal-target-check.md)
continue their narrower current-target check. Full journals, native custody,
relay and cross-account application remain open.

## Broader-power policy status

The owner-approved permission-only first phase requires fresh presence plus
an operation-specific single-use receipt for one soul's computer-use setting.
When disabled, subsequent computer-use tool calls are denied, while the current
turn continues. A later setting change requires a fresh receipt. No authority
to stop a running turn or perform other computer-use operations is approved.
The remainder of the [#250 proposal](owner-operation-extension-proposal.md)
remains unadopted; runtime remains disabled pending implementation and
acceptance. Existing grants gain no new authority.

## Validation

`node --test tests/owner-scoped-grants.test.mjs tests/owner-operation-grants.test.mjs`
covers grammar and structural limits, canonical ordering and copies,
append/checkpoint replay, legacy absence and isolation, whole-list replacement,
revocation/re-pairing, malformed stored state, and refusal before append.
Coverage tests distinguish account/soul/operation scopes, overlapping selectors,
target-grant intersections and revoked/pending account/daemon/principal state.
Real CLI/socket tests reject ordinary wire self-enrollment and invalid or
overlong JSON, retain singular-command compatibility and its deprecation notice,
and clear scopes explicitly. These establish storage and pure grant coverage,
not live owner-decision acceptance.
