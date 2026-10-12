# Explicit owner-operation grants

This [#77](https://github.com/qwts/agent-comms/issues/77) prerequisite stores the
operation grants accepted in [ADR-0077](decisions/ADR-0077-owner-decisions-through-the-broker.md).
It enables no owner-decision route, receipt issuance, native presence or mutation.
Existing target checks and local consent behavior remain unchanged.

## Owner administration

Use the broker's existing private administrator channel:

```sh
agent-comms admin principal-owner-grant PRINCIPAL --operations revision.approve,revision.reject
agent-comms admin principal-owner-grant PRINCIPAL --operations none
agent-comms admin principals
```

The operation replaces the entire list for one currently approved principal.
`none` clears it; omitting `--operations` is an error. Supported names are
`revision.approve`, `revision.reject`, `revision.adopt`, `revision.edit` and
`cold-wake.set`. No wildcard, duplicate, unknown operation or inferred default
is accepted. The broker stores a sorted copy; admin listing shows
`ownerOperations` alongside the separate existing target `grant`.

Only the private admin dispatcher accepts this change. Principal, account,
daemon and remote bridge callers cannot enroll themselves through the ordinary
broker request channel. The caller cannot create or revive an identity by
setting its grants. This uses existing administrator channel protection; it
introduces no new credential or enrollment path.

## Persistence and authority boundary

New principals start with an empty list. Legacy records/checkpoints lacking
`ownerOperations` also mean no operation grant. Explicit changes survive event
replay and checkpoints. Revocation deletes the identity and its operation list;
a new pairing starts empty. Malformed stored lists, noncanonical ordering and
nonempty lists on pending principals refuse restoration rather than granting
extra power. The field is nested in the existing principal checkpoint row;
checkpoint format remains version 3.

An operation grant does not replace an account/soul target grant. The future
owner-decision adapter must check their intersection, current principal/account/
daemon approvals, enrolled keys, daemon epoch and receipt deadlines at every
required boundary, including the final durable release. Mailbox receive
allowlists never become owner-administration authority. A previously issued
receipt cannot freeze an old grant after the owner changes it.

This storage/admin slice does not implement that adapter, and configuring the
list does not advertise owner-decision support. Existing
[principal target queries](principal-target-check.md) continue their narrower
current-target check; they do not become complete owner authorization. Durable
single-use journals, native custody and cross-account application remain open.

## Validation

`node --test tests/owner-operation-grants.test.mjs` covers finite vocabulary,
copying and canonical ordering, append/checkpoint replay, legacy absence,
revocation/re-pairing, corrupt stored state, refusal before append and private
admin CLI replacement/clear behavior. A real broker socket test rejects a
principal's attempt to self-enroll. These tests establish grant storage and
administration, not live owner-decision acceptance.
