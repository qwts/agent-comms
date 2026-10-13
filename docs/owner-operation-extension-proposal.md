# Proposed extension of scoped owner operations

**Status: Proposed; no policy adoption, grants or runtime enabling.**

This proposal scopes [#250](https://github.com/qwts/agent-comms/issues/250).
[ADR-0077](decisions/ADR-0077-owner-decisions-through-the-broker.md) accepts
revision and cold-wake decisions; it explicitly requires a separate proposal
for broader owner powers. Its existing custody, fresh presence, receipt,
revocation and recovery requirements remain prerequisites, not delivered
capabilities. This proposal does not change that decision or complete #77.

## Current boundary and source inventory

Agent-bot [#1097](https://github.com/qwts/agent-bot-identity/pull/1097), merged
as `7b5fa4208a4dcc218edaa7cbfb677871ce0ec033`, refuses a targetless principal
before contacting the broker. `owner-principal.mjs` accepts only an exact
`{agentId}` target for its current target-grant query. `owner-action.mjs`
wires that verifier to the existing owner gates. Presented targetless
credentials do not automatically fall back to a prompt. Local presence
remains the supported route for these actions.

The following inventory names caller families, not proposed wildcard grants.
It is based on that merged source and the #1097 refusal tests. Each future
operation requires its own exact typed parameters and consumer review.

| Caller/source | Actions requiring explicit disposition | Proposed selector | Phase |
| --- | --- | --- | --- |
| `agent-daemon.mjs`, `/v0/soul/computer-use` | Set enabled true or false; disabling may stop a current turn | Soul | First |
| `agent-daemon.mjs`, `/v0/soul/resume` | Resume a paused soul | Soul | Deferred |
| `agent-daemon.mjs`, dream routes | Register schedule, pause, unschedule, run-now, cancel run, acknowledge notice | Soul, with run/notice resolved to it | Deferred |
| `sandbox.mjs`, daemon sandbox routes | Account sandbox enabled/account selection; per-soul override | OS account or soul, separately | Deferred |
| `identity/agent-principals.mjs`, `cli/principal.mjs` | Enroll, bind, allow, revoke | Broker namespace/ACL authority | Deferred |
| `identity/identity-apps.mjs`, `cli/identity-apps.mjs` | Create, connect, rotate-key, migrate-key, assign, remove, addon | Identity registry; exact affected App and binding | Deferred |
| `soul-mode.mjs` | Safe/Auto-Pilot mode | Soul | Deferred |
| `soul-secrets.mjs` | Set or clear secret; provider/store/name separately bound | Soul | Deferred |
| `soul-runtimes.mjs` | Install, upgrade, set/clear executable override | Soul | Deferred |
| `soul-env-migrate.mjs`, `soul-env-clean.mjs`, `soul-env-export.mjs` | Individual migration/clean steps, export and import | Soul plus exact destination/plan constraints | Deferred |
| `soul-template-refresh.mjs`, `soul-tool-home.mjs`, `soul-comms.mjs` | Refresh planned files, tool-home soul/global choice and fresh-session, comms on/off | Soul; wake/effect separately bound | Deferred |
| `soul-revisions.mjs`, `cold-wake-settings.mjs` | Existing revision and cold-wake operations | Existing soul scope | Already scoped by #77; not new #250 work |

Join/wake controls remain deferred from the issue inventory and need their
exact caller/target mapping before an operation is proposed. Assign is also
included in the requested product inventory; its exact supported
CLI/API binding and parameters must be reconciled with the identity team
before a schema is proposed. Other owner gates, including approvals, soul
creation/removal/fork, skill changes and credential migration, gain no power
from this table. Their inclusion would require a separate reviewed row and
operation. No generic `settings`, arbitrary command or action-string grant
is proposed.

## Recommended authority model

Require fresh trusted human presence and an operation/effect-bound single-use
receipt for every added remote action. A bearer principal, broker health,
successful target query, displayed action label or permission to administer
one account is insufficient owner proof. Do not restore principal-only
approval by merely adding an operation name to `principal-target-check`.

Use distinct tagged selectors, with no implicit conversions:

- **Soul:** an exact account and immutable Agent ID, independently resolved
  through its authenticated daemon; retain existing target-grant intersection.
- **OS account:** one enrolled installation and exact account identity,
  including its stable platform identity; no implied soul wildcard.
- **Broker namespace:** one protected broker installation/namespace, for
  principal ACL effects; account administration grants no ACL authority.
- **Identity registry:** one enrolled registry and exact App/binding resource;
  account or broker administration grants no registry authority.

These are policy categories, not an adopted wire schema. Existing
`ownerGrants.souls:"*"` continues to mean souls in one named account; it
must never be reinterpreted as account/global administration. No migration
from legacy `ownerOperations`, existing target grants or absent fields may
create authority. Existing principals start with zero new operations.

Only a separately authenticated owner administration ceremony can establish
these powers. A grant subject cannot create or enlarge its own grants, enroll
its own owner authority, change its trust roots or authorize a transaction
that indirectly does so. Registry/ACL operations must bind expected current
state, exact subject and resulting authority, including indirect App/soul
assignments. Until these checks are reviewed, those operations stay deferred.

## First coherent phase: computer-use setting

Recommend only `soul.computer-use.set` as the first new operation, subject to
owner and agent-bot/native-host protocol review. Bind the exact resolved
account/Agent ID, boolean enabled value, expected setting state/revision,
request identity, installation/namespace, daemon epoch and effect-plan digest.
Freeze these before challenge preparation; do not derive authority from a
mutable action label, credential field or caller-supplied account.

The trusted prompt must name the exact soul/account, resulting enabled state,
and the disabling side effect on a running turn. The prepared effect must
specify that side effect and its reconciliation identity. Reusing a receipt
must never stop a later unrelated turn. Whether disabling only sets the
permission or also stops the specifically prepared turn is an explicit
consumer-contract decision before implementation.

Use #77's reviewed receipt/presence/journal infrastructure when production
ready; do not duplicate or bypass it. Require the existing target grant plus
an explicitly owner-administered new operation grant. Check current principal,
account, daemon identity, enrollment and both grants at preparation, receipt
issuance and immediately before durable application/release. Revocation or
unavailable authority refuses; a prior successful query preserves no power.

The daemon durably spends the request before applying its validated effect.
After a crash or uncertain stop/write outcome, return `indeterminate` and
reconcile the exact retained request/effect. No automatic retry, re-prompt,
failover or newly generated request may conceal uncertainty. Reconciliation
may discover completion; it must not silently perform a second effect.

## Limits and acceptance required before enabling

Retain existing transport, canonicalization, grant-count, payload, deadline,
replay and privacy bounds. Extending the vocabulary or selector schema must
not silently enlarge those budgets. Unknown operations/selectors/fields,
stale expected state and mismatched account/resource bindings refuse.

Required acceptance for the first phase includes real authenticated broker
and daemon preparation/application; actual fresh native presence and protected
receipt custody; exact true/false payload tests; soul/account cross-scope
canaries; unjoined/departed resolution; principal/account/daemon revocation
at each boundary; duplicate/replay and changed-effect refusal; concurrent
setting/turn races; crash/restart before and after spend/write/stop; retained
indeterminate reconciliation; and unchanged local-presence behavior. A
fixture or target query alone cannot establish installed acceptance.

## Decisions requested, not assumed

1. Approve fresh presence plus single-use effect-bound receipts for every
   added operation, rather than principal-only current-grant checks.
2. Approve the four distinct authority categories and zero inherited power;
   define their installation/account/registry enrollment identities jointly
   with agent-bot and the native host.
3. Approve the single computer-use phase and explicitly defer every other
   table row. Resolve the disabling-turn effect contract before coding.
4. Require separately reviewed typed operation inventories and self-escalation
   controls before ACL, registry or account-global phases.

#250's provisional Comms-only 4–7 focused-day range is conditional on the
approved bounded protocol scope. It excludes policy waiting, agent-bot/native
implementation and #77's shared infrastructure/installed acceptance. It does
not reduce #77's estimate or authorize implementation, rollout or migration.
