# ADR-0059: Host apps embed agent-comms through a contract and platform seams

**Status:** Proposed
**Date:** 2026-10-01
**Issue:** qwts/agent-comms#59

## Context

agent-comms assumes its user installed it from a terminal on macOS:

- Node is already on the machine.
- An administrator created a group with `sudo`.
- `agent-comms broker install` wrote a LaunchAgent.

It also names the one app expected to read it. The principal credential goes
to the keychain service `qwts.GeniusBar.principal`, and the broker's job
label is `dev.qwts.agent-comms.broker`.

The goal is a product people download and use. A host app such as GeniusBar
bundles agent-comms and agent-bot, and its users never open a terminal. That
app may later move to another organization, so it must not depend on qwts
names, and agent-comms must not know which app is hosting it.
agent-bot-identity
[ADR-0274](https://github.com/qwts/agent-bot-identity/blob/main/docs/decisions/ADR-0274-product-is-mechanism-add-ons-and-sop-packs-carry-policy.md)
makes one-account operation the default and multi-account isolation an
add-on (`persona-accounts`).

## Decision

1. **A host app embeds a pinned release.** It ships an agent-comms release
   tag, and the matching agent-bot release, together with its own Node
   runtime. It never depends on a Node the user installed. The host app
   decides when to update. agent-comms keeps its CLI, so a host app can call
   the same commands a terminal user does.
2. **The host supplies every name a user sees.** These are configuration,
   with today's values as defaults:
   - the service label (`dev.qwts.agent-comms.broker`);
   - the stored-credential name (`qwts.GeniusBar.principal`);
   - the log and state directories.

   agent-comms never names a host app in code.
3. **One account is the default.** With `persona-accounts` off, the broker
   serves only the account that runs it:
   - no group is created, and no administrator is asked;
   - the socket is owned by that account with mode 0600;
   - a host app starts the broker during first-run setup.

   With `persona-accounts` on, today's group and ADR-0006 rules apply
   unchanged.
4. **Platform behaviour goes through four seams.** Each has an
   implementation per platform. macOS is implemented now; Windows comes
   later and changes no other code.

   | Seam | macOS | Windows |
   | --- | --- | --- |
   | Local channel | Unix socket, owner and group modes | Named pipe with an access list |
   | Secret store | Login keychain | Credential Manager |
   | Service startup | LaunchAgent, or the host's login item | Scheduled task, or the host's startup entry |
   | Account isolation | Accounts and groups (`persona-accounts`) | Accounts and groups (`persona-accounts`) |

   Custody checks such as ownership and permissions belong to each
   implementation. Code outside the seams does not branch on the platform.
5. **A host app holds no authority.** It acts as a principal client
   (ADR-0003) or through the CLI, with the same credentials and checks as
   any other client.

## Consequences

- A downloaded app can run agent-comms with no terminal, no Node install,
  and no administrator prompt.
- Every release must work embedded. CI needs a test that runs the CLI from a
  bundled Node with names chosen by a host.
- One-account mode drops the kernel boundary between agents that separate
  accounts give. Agents in one account can read each other's files. A user
  who needs isolation turns on `persona-accounts`.
- Moving the platform-specific code behind seams is a refactor of the
  custody and LaunchAgent code. Windows still has to be built.
- Existing installs keep their names. A host that picks new names starts
  with a fresh credential and service.

## Alternatives

- **Host apps install agent-comms through Homebrew or npm:** rejected. That
  returns the prerequisites the product exists to remove.
- **Run agent-comms on Electron's built-in Node:** rejected. Hosts commonly
  disable it for security (Electron's `runAsNode` fuse), and the broker must
  keep running when the app's window is closed.
- **A separate build per host:** rejected. Fixes would drift between builds.
