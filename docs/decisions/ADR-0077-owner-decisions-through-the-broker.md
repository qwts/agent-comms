# ADR-0077: Grant-scoped owner decisions through the broker

**Status:** Proposed
**Date:** 2026-10-11
**Issue:** qwts/agent-comms#77

This proposal preserves the four requirements of
[#77](https://github.com/qwts/agent-comms/issues/77): authenticated relay,
signed receipts, restricted native credential custody and target-scoped
authorization. It authorizes no runtime or migration. Acceptance, companion
product contracts and conformance evidence are prerequisites to enabling it.

## Context

[ADR-0006 decision 8](ADR-0006-machine-broker-between-persona-accounts.md)
requires the human principal credential to remain in the signed host's
keychain item. The current client also writes a plain copy. The daemon's
principal owner check authenticates `health`, without binding an action or
checking the target grant. Existing launch relay and target grants supply
useful patterns but do not establish this security contract. The
[conformance proposal](../owner-decision-conformance.md) pins that evidence.

[ADR-0059](ADR-0059-host-apps-embed-agent-comms.md) preserves these requirements
and distinguishes host embedding from owner proof. The agent-bot-owned
[keyd contract](https://github.com/qwts/agent-bot-identity/blob/64b1c170ed25f4943e01a9f20334c065fd92d661/docs/keyd-protocol.md)
and accepted
[ADR-0753](https://github.com/qwts/agent-bot-identity/blob/64b1c170ed25f4943e01a9f20334c065fd92d661/docs/decisions/ADR-0753-owner-signed-statements.md)
remain authoritative for presence and owner statements. Their current
implementation limitations are not waived here.

## Proposed decision

### 1. Native custody and explicit platform limits

On macOS a signed native host creates and uses the comms principal in the
data-protection keychain under its entitlement and access group. The secret
never leaves native code: no file, environment variable, JavaScript loader,
Node bridge, `security` subprocess or generic secret-export RPC. The native
host submits principal requests itself over the custody-checked channel;
JavaScript receives results. Approved signing identity and access group are
installation trust inputs, never authority selected by a host name.

Fresh native presence is also required for each owner decision, with an
independently protected presence key. Reuse keyd's `p1` semantics through an
agent-bot-reviewed native adapter; the current legacy-keychain seed and
writable pin cache alone are insufficient for this proposed boundary.
Do not silently move comms credentials into today's keyd protocol.

The first supported broker path requires a broker in a separate service
account with no souls, owner-administered installation and private state.
Single-account installations and Windows lack the proposed evidence and
return `owner-decision-unsupported`. Their existing local owner ceremonies
remain available; ordinary comms continues under its existing contract.

### 2. Separate owner authority from ordinary grants

Require both the existing target grant and an explicit `ownerGrants` entry:
`{ account, souls, operations }`, where `souls` is `"*"` or a nonempty list
of soul IDs, and `operations` lists exact supported operation names. Missing
or empty entries authorize no owner operations; existing unrestricted
messaging grants acquire none. Each entry names its account explicitly.

Only owner-administered approval creates or changes these grants. Account,
daemon and soul bindings cannot request decisions as principals. Resolve
the target through the account daemon, including unjoined souls; the broker
checks the resolved account/soul against both grants. Mailbox receive
allowlists govern messages, not owner administration. Recheck principal,
account pairing and grants immediately before issuing a receipt.

### 3. Bound request, human proof and signed receipt

Use the existing authenticated account-watch relay for a daemon-prepared
challenge, then `owner-decision` confirmation. The native prompt names the
exact operation, account, soul and immutable payload digest. Broker and
daemon verify native presence for that challenge. The broker issues an
Ed25519 receipt with a distinct audience; the daemon verifies it before
calling existing validated owner mutation functions. No shell command or
caller-chosen authorization callback crosses the wire.

The [proposed wire contract](../owner-decisions.md) specifies the fields,
lifetimes, replay journal and operation boundaries. Revision approve,
reject, adopt, edit and cold-wake settings are in scope. Tool approvals,
GitHub reviews/merges, arbitrary daemon commands and cross-machine routing
are excluded. Broader owner powers need a separate proposal.

### 4. Protected trust and durable consumption

Owner-administered installation enrolls a dedicated broker receipt key and
the native presence key. The broker protects its private receipt key in its
service account; target daemons pin both public keys through their local
owner installation ceremony, never from a received request. Native presence
trust at the broker lives outside the owner's agent account. Changes require
explicit owner verification and audit evidence. No first-request trust,
automatic re-pin or reuse of the Windows channel-signing key is proposed.

Replay prevention is durable at the broker and daemon. Spend a challenge
before issuing or applying a decision. After a crash at an uncertain effect,
report `indeterminate`, retain the spent request and require explicit
reconciliation; never apply automatically again. Receipt revocation is
checked online before application. Unavailable authority refuses mutation.

### 5. Re-pair instead of adopting exposed credentials

An owner-enabled cutover revokes every legacy principal that has no proven
native custody, then pairs a fresh native-only secret and separately approves
owner grants. It never imports a plain principal or silently preserves its
authority. Revocation must be durable before a replacement is approved.
After replacement verification, remove only that installation's identified
legacy files/items; namespaced installations require separate cutovers.

Interrupted cutover stays revoked until the owner resumes. Record the old
and new principal IDs, namespace, phase and result, without secrets. A
rollback can disable the new capability but cannot restore a revoked secret.
Account/daemon pairings and message history are preserved. Credential and
receipt-key recovery are separate owner ceremonies.

## Consequences and alternatives

This requires native work and a reviewed compatible release set; a Node-only
host cannot implement it by changing a loader. Re-pairing interrupts existing
principal clients. An isolated service account and online revocation trade
availability for a clearer authority boundary. Same-account daemon code and
state remain cooperatively isolated under ADR-0003; this does not defend a
daemon against arbitrary code already controlling its OS account or root.

Deleting the plain file alone, an unrestricted login-keychain item,
CurrentUser DPAPI and broker health as owner proof are insufficient. Offline
receipts without revocation and retry after an uncertain mutation are rejected
for this proposal. ADR-0753 challenge support can be considered after its pin
integrity and trusted-display prerequisites are actually met.

## Owner review groups

Acceptance must record the reviewed revision and these choices explicitly:

1. **Custody and availability:** approve native data-protection custody,
   fresh presence, isolated broker and initial macOS-only support. Recommended:
   accept this boundary; keep unproven hosts on their existing local ceremony.
2. **Authority:** approve explicit operation grants intersected with existing
   target grants, with owner administration independent of mailbox allowlists.
   Recommended: no implicit owner authority for old principals.
3. **Cutover and recovery:** approve revoke-before-re-pair, separately enrolled
   receipt/presence keys, durable single consumption and online revocation.
   Recommended: accept explicit interruption and indeterminate reconciliation.

Merging this proposal is not acceptance or completion of #77. Product protocol
changes need agent-bot and native-host review; deployment policy spanning the
organization needs its own ENG record under the
[decision index](README.md). Accepted records are not rewritten by this draft.
