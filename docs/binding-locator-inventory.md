# Binding locator migration inventory

**Issue:** [#281](https://github.com/qwts/agent-comms/issues/281), blocked on
[agent-bot-identity#1360](https://github.com/qwts/agent-bot-identity/issues/1360).
This is preparation only. It changes no runtime behavior and invents no
locator format; the cutover waits for #1360's contract.

## Today's legacy path

A bound session reads `agent-binding.json` from the git directory, or from the
path in `AGENT_BOT_BINDING`. The file holds `agentId`, `parent`, `account`,
`daemon` (URL), and the raw `secret`. Anyone who can read the worktree can
read the secret. The secret never crosses the wire: each daemon request
carries `x-agent-binding-proof`, an HMAC keyed by `sha256(secret)`
([ADR-0008](decisions/ADR-0008-daemon-vouching-and-the-wake-plane.md)
amendment 1).

## Producers and consumers

| Site | Role | Uses |
| --- | --- | --- |
| `lib/client.mjs` `resolveBinding` | Reads the file; `AGENT_BOT_BINDING` selects any path | `secret`, `daemon`, `agentId`, `parent` |
| `lib/client.mjs` `soulContext` | Binding, then `AGENT_BOT_ID`/`QWTS_AGENT_ID`, then `git config agentBot.agentId` | `agentId` |
| `lib/client.mjs` `bindingPost` | Signs `x-agent-binding-proof` to the binding's daemon URL | `secret`, `daemon` |
| `lib/client.mjs` `vouch` | `POST /v0/vouch`; caches by daemon and secret | `secret`, `daemon` |
| `lib/asides-report.mjs` | `POST /v0/asides/delivered` through `bindingPost` | via `bindingPost` |
| `lib/binding-proof.mjs` | Client half of the proof; byte copy of agent-bot's | key from `secret` |
| `bin/agent-comms.mjs` | `join`, `send`, `inbox`, `watch` take `soulContext` and `vouch` | via client |
| `lib/worker/index.mjs` | Worker turns vouch and report asides | via client |
| agent-bot daemon (other repo) | Verifies the proof; writes the file | registry `sha256(secret)` |

Tests on the legacy path: `binding.test.mjs`, `client-binding-deadline.test.mjs`,
`asides-delivered.test.mjs`, `spawn.test.mjs`, `worker.test.mjs`,
`task-turn.test.mjs`.

## Cutover matrix

| Client | Daemon | Expected once #1360 lands |
| --- | --- | --- |
| New | New | Locator plus daemon-authenticated caller; no raw secret read |
| New | Old | Refuse `binding-unsupported`; never fall back to the secret, env, or git identity |
| Old | New | Daemon refuses legacy proofs once its cutover is enabled |
| Old | Old | Legacy behavior, unchanged |
| Any | Absent, stale, or mismatched locator | Refuse; `soulContext` must not fall through to env or git claims |

`AGENT_BOT_ID`, `QWTS_AGENT_ID`, `git config agentBot.agentId`, and an
`AGENT_BOT_BINDING` path stay hints for which soul to ask for, never proof.
The broker's soul-token check
([ADR-0276](decisions/ADR-0276-soul-tokens-signed-by-the-identity-service.md))
keeps its audience, authority, and owner grants.

## Tests to add with the cutover

- Copied locator in another worktree or account is refused.
- Caller-selected path or agent id cannot select another soul's binding.
- New client against an old daemon refuses with no legacy retry.
- Downgrade: a daemon that has cut over refuses a replayed legacy proof.
- Mixed versions during upgrade keep each pair in one row of the matrix.
