# Owner decisions: proposed schemas and state machine

This is an engineering draft for the accepted policy in
[ADR-0077](decisions/ADR-0077-owner-decisions-through-the-broker.md). It extends
the [proposed contract](owner-decisions.md), with no released API or runtime
enablement. Agent-comms, agent-bot and the native host must jointly review its
fields, fixtures and adapters before implementation. All four #77 requirements
remain in scope. Existing target checks and the credential-free transport
factory do not implement this protocol.

The [envelopes and daemon binding](owner-decision-envelopes.md) and
[durable lifecycle/native adapter](owner-decision-lifecycle.md) complete this
specification. [Shared fixtures](owner-decision-fixtures.md) record reviewable
bytes and required implementation evidence.

## Primitive and operation schemas

Every object below has exactly its listed fields. No unknown fields, defaults,
coercion or credential-kind mixing are allowed. A field called optional may be
absent; explicit null is allowed only where stated. All strings contain Unicode
scalar values. Complete frames, including the existing authentication envelope
and newline, are at most 32 KiB or the smaller existing daemon limit. Limits
apply before allocating or decoding a body; nesting is at most 8 levels.

| Name | Exact representation |
| --- | --- |
| `requestId`, `proposalId`, `stagingId`, `watchId` | Lowercase UUID version 4 with RFC variant: `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`. Random IDs must be generated with a cryptographic RNG. |
| `account` | Existing canonical paired account short name, matching `[A-Za-z_][A-Za-z0-9_.-]{0,63}`; compare exact spelling, never case-fold or resolve an alias. |
| `soul` | Existing bot ID grammar: `agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}` (whole string). Versions 1–8 are allowed; the authenticated target daemon resolves this exact ID, including unjoined souls. |
| `principal` | Existing bot ID grammar: `principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` (whole string), without a version/variant restriction. Taken from authentication, never trusted from a caller-supplied action. |
| Revision | `sha256:` followed by 64 lowercase hexadecimal characters. |
| Digest / key ID | Exactly 64 lowercase hexadecimal characters, without a prefix. |
| `nonce` | Exactly 32 random bytes encoded as 43 canonical unpadded base64url characters. |
| Time | Nonnegative safe integer Unix seconds; floor milliseconds before comparing. |
| `daemonEpoch` | Broker-assigned positive safe integer, durably increased for every daemon approval/replacement/revocation in this account; never reused or reset by recovery. |
| `reason` | Nonblank string, at most 500 UTF-8 bytes, with no Unicode control scalar (U+0000–001F, U+007F–009F). Preserve bytes; do not trim or normalize. Preparation may refuse a shorter reason if the complete action does not fit. |
| `host` | Canonical WHATWG HTTPS URL `.host`, including bracketed IPv6 and optional nondefault decimal port, from the validated webhook snapshot; nonempty lowercase ASCII, at most 253 bytes. Roundtrip `new URL("https://" + host + "/")` must preserve `.host` exactly and have only `/` as its path, with no query, fragment or credentials. Default ports, noncanonical spellings and other URL components refuse. This grammar check grants no staging or destination authority. |

`parameters` has one of the exact shapes below. The `operation` selects the
schema; a field valid for another operation still refuses.

| Operation | Exact parameters | Preconditions at prepare and final application |
| --- | --- | --- |
| `revision.approve`, `revision.reject` | `{ proposalId, expectedRevision, reason }` | `expectedRevision` is a revision. Proposal belongs to this soul, remains pending and its parent/head matches that revision. Reject also checks the head, even though the current local reject function only checks pending status. |
| `revision.adopt` | `{ stagingId, packageDigest, expectedRevision: null, reason }` | No revision head exists; immutable package snapshot belongs to this principal/account/soul/request namespace; package validation and existing genesis constraints pass. |
| `revision.edit` | `{ stagingId, packageDigest, expectedRevision, reason, apply }` | `expectedRevision` is a revision and `apply` is an explicit boolean. Snapshot and current head match; existing package and apply-path validation pass. False records the validated revision without publishing its files. |
| `cold-wake.set` with `mode: "on"` or `"off"` | `{ mode }` | Target exists and existing setting policy permits the change. Prepared expected state still matches. |
| `cold-wake.set` with `mode: "resume"` | `{ mode, policy }` | `policy` is exactly `"read-only"` or `"workspace"`; existing harness/resume checks pass. This selects a policy for the soul's own recorded session, not an arbitrary caller-selected session. Prepared expected state still matches. |
| `cold-wake.set` with `mode: "webhook"` | `{ mode, stagingId, configurationDigest, host }` | Immutable owner-prepared webhook snapshot matches the digest and public host; existing webhook validation passes. Prepared expected state still matches. |

`packageDigest` is SHA-256 of the existing validated package's canonical
inventory bytes, equal to its revision digest without `sha256:`. Do not hash
an archive container or a mutable directory independently. The separate typed
staging adapter must use agent-bot's package inventory implementation.

For webhook staging, validate and normalize the URL/key using existing bot
webhook validation first. `configurationDigest` hashes canonical UTF-8 JSON
`{ key, url, v: 1 }` of that frozen normalized snapshot. Those bytes and both
secrets stay in the target daemon's private staging; only the digest and public
`host` enter the broker, action or audit. The native host must have completed
the separate authenticated secret-preparation ceremony and checked its returned
descriptor before asking to enable that configuration. A digest alone is not
permission to accept an arbitrary replacement snapshot.

Staging is a separate, disabled typed adapter, not a generic file/export RPC.
It authenticates the native principal and both target/operation grants, fixes
the namespace, account, soul, operation and random staging ID, and copies input
into a daemon-owned immutable snapshot before returning a descriptor. Package
and webhook inputs use separate schemas. Never accept caller file paths,
symlinks, shell strings, a JavaScript secret loader or arbitrary auth callbacks.
Each descriptor expires 180 seconds after successful creation and binds one
request ID when preparation first consumes it. It cannot be rebound or reused
by another principal/target/operation. Preparation expiry is exactly the minimum
of `preparedAt + 180`, the original broker `acceptedAt + 180` and stage expiry;
staging never extends the original broker acceptance cap. Refuse exhausted
staging quotas before accepting input; limits are 64 MiB per package, 32 KiB per webhook snapshot,
4 live stages per principal/target and 256 MiB total per daemon. Expired,
cancelled and settled secret snapshots are removed; uncertain snapshots remain
private until owner-local reconciliation. Stream/upload framing and real
custody evidence belong to the companion bot/native-host staging contract;
none of these operations may advertise support until that contract is reviewed.

## Typed summary and native display

Keep the action's exact prefix and suffix from the parent contract. Between
them use the following exact ASCII labels, punctuation and order; substitute
only validated values. `J(value)` is the canonical JSON string encoding from
the parent contract, including its enclosing quotation marks. Boolean text is
`true` or `false`. Never trim, normalize, elide or abbreviate a value.

| Operation / mode | Exact summary |
| --- | --- |
| `revision.approve`, `revision.reject` | `proposal=J(proposalId); reason=J(reason)` |
| `revision.adopt` | `package sha256:<packageDigest>; reason=J(reason)` |
| `revision.edit` | `package sha256:<packageDigest>; apply=<apply>; reason=J(reason)` |
| `cold-wake.set` on/off | `mode=<mode>` |
| `cold-wake.set` resume | `mode=resume; policy=<policy>` |
| `cold-wake.set` webhook | `mode=webhook; host=J(host); configuration sha256:<configurationDigest>` |

The summary names the change with explicit labels. The complete payload digest
also binds omitted `stagingId` locators and `expectedRevision` concurrency
preconditions; neither may change after human confirmation. The daemon stores
the expected cold-wake state with its nonce: normalized current policy, current
webhook configuration digest or null, and current recorded resume-session
identity where relevant. The nonce binds that daemon-owned preparation; final
application compares all those fields, not merely the desired resulting value.
Never take expected state from an unverified host claim.

The complete action must have 1–400 Unicode scalar values, at most 500 UTF-8
bytes, and no control scalars, matching keyd's existing action acceptance plus
the broker byte cap. Count after JSON string escaping. For example, quotes and
backslashes in a reason appear as the literal escaped characters the owner
sees; a newline/control in the input is rejected rather than disguised. Include
these cases in shared fixtures. Long account names and Unicode reasons can
make otherwise valid typed parameters unpreparable. Refuse before prompting;
offer the existing separate local owner ceremony only as an explicit user
choice, never as automatic fallback for invalid or unavailable broker proof.
No p1 lifetime, audience, nonce-cache or trusted-display semantics change here.
