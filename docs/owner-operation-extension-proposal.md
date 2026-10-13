# Proposed extension of scoped owner operations

**Status: Approved policy for one permission-only phase; other families remain proposed.**

Runtime, grants and rollout remain disabled.

This proposal scopes [#250](https://github.com/qwts/agent-comms/issues/250).
[ADR-0077](decisions/ADR-0077-owner-decisions-through-the-broker.md) accepts
revision and cold-wake decisions and requires separate review for broader owner
powers. Existing custody, fresh presence, receipt, revocation and recovery
requirements remain prerequisites, not delivered capabilities; this approval
does not complete #77.

## Current boundary and source inventory

Agent-bot [#1097](https://github.com/qwts/agent-bot-identity/pull/1097), merged
as `7b5fa4208a4dcc218edaa7cbfb677871ce0ec033`, refuses a targetless principal
before contacting the broker. `owner-principal.mjs` accepts only an exact
`{agentId}` target for its current target-grant query. `owner-action.mjs`
wires that verifier to the existing owner gates. Presented targetless
credentials do not automatically fall back to a prompt. Local presence
remains the supported route for these actions.

The following inventory names caller families, not proposed wildcard grants.
It is based on that merged source and the #1097 refusal tests. The first
computer-use setting phase is owner-approved policy; every other listed action
requires its own exact typed parameters and consumer review.

| Caller/source | Actions requiring explicit disposition | Proposed selector | Phase |
| --- | --- | --- | --- |
| `agent-daemon.mjs`, `/v0/soul/computer-use` | Set enabled true or false for one exact soul; while disabled, deny subsequent computer-use tool calls without stopping the current turn | Soul | First |
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

Join/wake controls and assign remain deferred until their exact CLI/API
bindings are reconciled with the identity team. Other gates, including
approvals, soul creation/removal/fork, skill changes and credential migration,
gain no power. No generic `settings`, arbitrary command or action-string grant
is proposed.

## Recommended authority model

For the approved first phase, require fresh trusted human presence and an
operation-specific, effect-bound single-use receipt. Other actions remain
unapproved. A bearer principal,
broker health, successful target query, displayed action label or permission
to administer one account is insufficient owner proof. Do not restore
principal-only approval by merely adding an operation name to
`principal-target-check`.

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

Approved permission-only `soul.computer-use.set` sets enabled true or false for
one exact resolved account/Agent ID. While disabled, subsequent
computer-use tool calls for that soul are denied, but the current turn and
already-authorized or running tool calls continue. Gate each call, including after approval waits. Each later setting change, including re-enabling,
requires fresh trusted presence and its own single-use receipt. Other effects
remain unapproved, with no inherited authority.

See the [proposed wire extension](owner-computer-use-wire-candidate.md) for joint
technical review; it does not adopt runtime behavior.

Bind exact account/Agent ID, enabled/expected booleans, request,
installation/namespace, daemon epoch and effect plan in the receipt. Freeze
before challenge; mutable labels, credentials and caller accounts confer no
authority. The trusted prompt names the exact soul/account and resulting state.
Changed target/value/plan or stale boolean refuses; off→on→off returns to the
accepted expected boolean.

Exact prepared-turn cancellation is deferred until agent-bot exposes a reviewed
API that names and validates one prepared turn/effect identity, consumes its
own operation-specific single-use receipt, and supports exact reconciliation.
This operation must never invoke the current whole-soul stop side effect; the
existing local route and its behavior remain unchanged.

Use #77's reviewed receipt/presence/journal infrastructure when production
ready; do not duplicate or bypass it. Require the existing target grant plus
an explicitly owner-administered new operation grant. Check current principal,
account, daemon identity, enrollment and both grants at preparation, receipt
issuance and immediately before durable application. Revocation or unavailable
authority refuses; a prior successful query preserves no power.

Compare expected boolean before entered/spend. Compare, spend, write, exact
readback and completion share one population lock. Setting-domain pre-effect
refusals include follow the proposed bot-domain to #77 mapping in the [wire candidate](owner-computer-use-wire-candidate.md#setting-domain-refusal-mapping); authentication, grant and revocation refusals keep existing semantics. After entry, only completed or indeterminate is valid. A no-op still spends/completes; audit is
best effort. Recovery is observation-only without exact request-linked
completion; current state cannot prove outcome or trigger another write.
Off→on→off passes the boolean comparison. Disabled denies future calls without
cancelling authorized/running calls.

Agent-bot owns the permission-only consumer/API design. Bot and Comms must jointly review action, receipt and vectors before adoption. Runtime
implementation and acceptance remain pending.

## Limits and acceptance required before enabling

Retain existing transport, canonicalization, grant-count, payload, deadline,
replay and privacy bounds. Extending the vocabulary or selector schema must
not silently enlarge those budgets. Unknown operations/selectors/fields,
stale expected state and mismatched account/resource bindings refuse.

Before enabling, verify fresh presence and protected single-use custody, exact
target/value/expected boolean/plan binding and replay/stale-state refusal.
Resolve the 30-second stale-lock reclaim before claiming lock exclusion; verify
logical file/directory flush and exact readback (no physical-flush claim), and
proof-only recovery without repeat writes. While off, deny future calls and
continue current/authorized work. Re-enabling needs fresh presence and receipt.
Cover exact soul/account cross-scope and unjoined/departed canaries, revocation
at every boundary, replay/changed target-value-plan, concurrent setting/turn
races, crash/restart before and after durable spend/write, and supported local
presence. A fixture or target query alone is not installed acceptance.

## Remaining decisions requested

1. Define the future OS-account, broker-namespace and identity-registry
   enrollment identities jointly with agent-bot and the native host; no such
   selectors or operations are approved by the first phase.
2. Keep every other action and future computer-use effect denied until a
   separately reviewed operation and effect contract is approved. Exact
   prepared-turn cancellation remains deferred pending a reviewed API.
3. Require separately reviewed typed operation inventories and self-escalation
   controls before ACL, registry or account-global phases.

#250's provisional Comms-only 4–7 focused-day range is conditional on the
approved bounded policy scope. It excludes agent-bot/native implementation and
#77's shared infrastructure/installed acceptance. The approval does not enable
runtime behavior or rollout, approve other operation families, reduce #77's
estimate or authorize migration.
