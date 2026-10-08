# ADR-0059: Host apps embed agent-comms through a contract and platform seams

**Status:** Proposed
**Date:** 2026-10-01
**Issue:** qwts/agent-comms#59
**Review:** [#126](https://github.com/qwts/agent-comms/issues/126),
2026-10-08; pending owner acceptance.

## Context

The original proposal removed terminal installation, host Node and manually
created groups as prerequisites for a downloaded host app. It also separated
host-specific names from broker behavior. Host configuration, one-account
mode, platform seams and principal-client operations have since landed;
closing #59 did not record acceptance of this decision.

Accepted agent-bot-identity
[ADR-0274](https://github.com/qwts/agent-bot-identity/blob/main/docs/decisions/ADR-0274-product-is-mechanism-add-ons-and-sop-packs-carry-policy.md)
owns product defaults and optional persona policy. This ADR defines the
agent-comms embedding contract; it does not create an alternative identity,
owner-authorization or sandbox policy. GeniusBar is one embedding host.

## Decision

1. **Embed an explicit compatible release set.** The host supplies pinned
   agent-comms and agent-bot releases and a supported Node runtime. Embedded
   operation must not depend on a user-installed Node. The host controls its
   update schedule and records the selected versions; a release tag alone
   does not prove compatibility with another component or existing state.
   Required unsupported capabilities must fail visibly. CLI and library
   clients retain the same broker authorization. Bundle and update evidence
   is tracked in [#127](https://github.com/qwts/agent-comms/issues/127).
2. **Host names configure locations, not authority.** Service label,
   credential name, log, channel, broker-state and client-state directories
   are supplied through the host configuration. Existing names remain
   compatibility defaults. Core code must not select privileges by host name.
   Setup, supervised services and clients must receive consistent settings.
   Changing a credential name selects a separate saved principal; it does
   not grant access. Changing a service label alone does not isolate shared
   state. A host creating an independent broker must choose and validate the
   complete namespace, and explicitly pair its clients. Do not silently
   overwrite another installation, adopt its credentials or reset its state.
3. **One-account operation is the default, with explicit limits.** No group
   creation or administrator prompt is required for broker setup in this
   mode. The macOS rendezvous is private to that account and its socket uses
   mode 0600. This excludes other accounts, not processes running as the same
   account. It does not establish that a human is present, or protect owner
   credentials from same-account code. Pairing, grants and owner-only actions
   keep their authorization requirements. Multi-account operation retains
   [ADR-0006](ADR-0006-machine-broker-between-persona-accounts.md)'s group
   contract where supported. Required isolation that is unavailable must
   refuse, never silently switch to one-account operation; persona launch
   policy remains agent-bot's responsibility under ADR-0274.
4. **Keep platform behavior behind four seams.** Shared callers use local
   channel, secret store, service startup and account isolation interfaces.
   Each adapter must enforce its actual platform's custody rules and report
   unsupported operations. A common interface is not proof of equivalent
   security or complete integration. The implementation snapshot is:

   | Seam | macOS | Windows |
   | --- | --- | --- |
   | Local channel | Unix socket ownership and modes | Named pipe; verify the pinned broker's signature before sending credentials |
   | Secret store | Login keychain integration | CurrentUser DPAPI file; account protection, not host-app isolation |
   | Service startup | Per-user LaunchAgent | Per-user logon scheduled task |
   | Account isolation | Account/group custody checks | SID/profile custody; group mode refused |

   [Windows](../windows.md) owns detailed implementation documentation.
   GeniusBar [ADR-0046](https://github.com/qwts/GeniusBar/blob/main/docs/decisions/ADR-0046-windows-pipe-transport-dpapi-store-and-logon-tasks.md)
   is related design context and is itself Proposed; its acceptance is
   separate. The earlier Credential Manager sketch is replaced here by the
   implemented DPAPI direction. Neither this table nor fixture tests claim a
   successful live Windows host installation.
5. **A host receives no intrinsic authority.** It acts through a principal
   credential and its grants, or the existing CLI contract. Hosting the UI,
   knowing a daemon address or providing a credential loader is not owner
   proof. Broker custody and authorization checks still apply. Launch is a
   request carried to the account daemon, as accepted
   [ADR-0007 amendment 1](ADR-0007-observability-and-geniusbar.md#amendment-1-any-principal-client-2026-10-01)
   requires; the client does not start another account's processes. Keep
   ordinary principal-authenticated messaging distinct from approving an
   owner-only action. [#77](https://github.com/qwts/agent-comms/issues/77)
   retains restricted credential custody, grant-scoped owner decisions and
   signed decision receipts. Embedding does not waive those requirements.
6. **Updates preserve custody and explain recovery.** Existing installations
   retain configured names, pairings and durable state. An intentional new
   namespace requires explicit setup; it is not automatic credential
   migration. A host must report incompatible components, failed startup,
   unavailable stores or untrusted broker identity without falling through
   to another credential or broker. Update/restart and recovery guarantees
   need evidence for the selected bundle; #127 tracks that work. Mailbox
   retention remains [#122](https://github.com/qwts/agent-comms/issues/122).

## Implementation evidence and remaining work

Source reviewed at released
[v0.3.15](https://github.com/qwts/agent-comms/tree/b44c134c4ef48a694733cc9c2a87ad5beb03d7cb).
These observations do not change the accepted records this ADR references.

| Contract area | Existing evidence | Remaining limit or issue |
| --- | --- | --- |
| Host configuration | `lib/host-config.mjs`, `tests/host-config.test.mjs`; #61/#83 delivered | OS commands are injected in the CLI fixture; actual bundle/update compatibility is #127. |
| One-account operation | `tests/broker.test.mjs`, `tests/launchagent.test.mjs`; #62 delivered | Same-account processes share authority over readable files; this is not a human-presence boundary. |
| Platform adapters | `lib/platform/`, `tests/platform.test.mjs`, Windows fixture suites; #63 delivered | No live Windows end-to-end run is documented; #127. |
| Principal-client and launch | `lib/principal-client.mjs`, `tests/principal-client.test.mjs`, `tests/launch.test.mjs`; #64/#65 delivered | Factory rejects SID-valued `brokerUid` and omits `brokerKey`; synthetic SID rejection reproduced without network, tracked in #127. |
| Principal custody | `lib/client.mjs` writes a plain local principal copy before the platform store | Keychain/DPAPI integration does not establish app-only custody; #77 remains open. |

[#123](https://github.com/qwts/agent-comms/issues/123) retains the broader
entry-point documentation refresh. Cross-machine hubs, routes and channels
(#28/#118/#119/#120) remain a separate decision group. The keyd protocol
review (agent-bot-identity#594) concerns native key custody and presence, not
this broker's embedding API.

## Consequences and alternatives

- Hosts can bundle the product without terminal prerequisites, while
  authentication and configured security requirements remain explicit.
- Compatibility defaults avoid forced renaming. Independent hosts must manage
  their full state/channel namespace, not just a label.
- Required Homebrew/npm installation remains rejected for embedded users.
  A host's embedded UI runtime is not the broker's lifecycle contract; the
  selected runtime must support the supervised process after windows close.
- Separate builds per host remain rejected because protocol and fixes drift.
  Platform adapters and documented capabilities carry differences instead.
