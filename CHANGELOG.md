# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.12] - 2026-10-06

### Added

- `launch-progress` daemon op (qwts/agent-bot-identity#536): while a launch is
  pending the daemon may report a `stage` (`checking`, `account`, `joining`,
  `harness`, `session`); `launch-status` returns the latest one, kept on the
  terminal result. Forward-only, idempotent, `conflict` after the result.

## [0.3.11] - 2026-10-06

### Added

- Messages a session reads are now reported to the agent-bot daemon, so its
  asides record what entered that soul's context (#100, agent-bot-identity#404).
  After it prints, `inbox read` POSTs the ids on the page to
  `POST /v0/asides/delivered` as `{messageIds, via: "inbox-read"}`, authenticated
  with the binding proof its other daemon calls use. A session with no binding
  reports nothing. `inbox read --json` whose output a script consumes, and
  `inbox count` or `inbox ack` on their own, report nothing. The report is best
  effort: a daemon that is down, older than this route, silent past 2 s, or
  refusing changes neither the output nor the exit code, and `AGENT_COMMS_DEBUG=1`
  puts one line about the outcome on stderr. `AGENT_COMMS_NO_DELIVERY_REPORT=1`
  turns the report off, which the agent-bot daemon sets on its own mailbox reads.
- `agent-comms inbox hook [--after CURSOR] [--limit N] [--session-id ID]` prints
  the whole waiting inbox for a harness hook to inject into the session it runs
  in, and reports those ids as `via: "hook-inject"`, naming the session from
  `--session-id`, `AGENT_HOOK_SESSION_ID`, or `CLAUDE_SESSION_ID`.

## [0.3.10] - 2026-10-06

### Added

- Launch requests and `agent-comms launch --brief TEXT` accept an optional brief
  of 1–4000 trimmed characters, forwarded unchanged to the daemon; an empty
  string clears the saved brief (qwts/GeniusBar#120).

## [0.3.9] - 2026-10-06

### Fixed

- `task offer TO` resolves its assignee the way `send TO` does (#102). A
  recipient may be an `<account>/<agent_id>` address, a bare `agent_id`, or the
  peer name unique among the souls the caller may address; both commands share
  one resolver in the broker. Before, a name failed with `unknown-recipient`
  while the agent id worked. A name two souls share still resolves to nobody,
  and the `unknown-recipient` message names both accepted forms.

## [0.3.8] - 2026-10-06

### Added

- Launch requests may carry an optional short `model` string (qwts/agent-bot-identity#464,
  GeniusBar #128). The broker bounds it (120 printable characters), records it with the
  request and forwards it in the daemon's launch frame; `principal-client` `launch()`
  passes it through. agent-bot validates and stores it for the new soul.

## [0.3.7] - 2026-10-03

### Added

- Launch requests may carry an optional boolean `comms` (qwts/agent-bot-identity#381).
  The broker validates it, records it with the request and forwards it in the
  daemon's launch frame; `principal-client` `launch()` passes it through. agent-bot
  writes it to the soul's `soul.json` before starting the soul, so GeniusBar's
  launch form can turn agent-comms off before a soul's first turn.
- `AGENT_BOT_ID`, the name agent-bot documents, now selects the soul exactly
  like `QWTS_AGENT_ID`, which keeps working. Two that disagree fail with
  `soul-mismatch`. The `unbound` message points at `agent-bot join`
  (agent-bot-identity#382).

## [0.3.6] - 2026-10-03

### Added

- Task invocation execution facts, task briefs and current-state worker prompts
  (#88). Task events no longer generate result/error replies or change claims
  when a turn finishes. Downgrade is unsupported after writing the new
  `task-invocation` log record.
- Configured outbound A2A bearer routes (#90), with soul-scoped sends, a
  durable outbox, safe transport retries, visible uncertainty and task
  reconciliation, namespaced remote references, and explicit cancellation.
- Optional loopback A2A 1.0 JSON-RPC gateway (#89), with owner-selected
  capabilities, hashed bearer enrollment, and authorized task operations.

- Durable task offers and revision-checked assignee transitions (#87), with
  immutable terminal states, linked retries, task events in participant
  inboxes, CLI task commands, and principal-client methods.

## [0.3.5] - 2026-10-03

### Fixed

- Two hosts in one account no longer share a principal credential file (#83). `principal pair` under a non-default `AGENT_COMMS_CREDENTIAL_NAME` saves its local copy as `principal.<name>.json` instead of overwriting `principal.json`, and CLI `census`/`health` read the copy for the configured name. Before, a desktop host pairing its own principal replaced the owner's CLI principal in `principal.json`, and a host asking "am I paired?" through the CLI got the owner's answer, so it never paired. The default name keeps `principal.json`; nothing moves.

## [0.3.4] - 2026-10-03

### Fixed

- `broker install` no longer leaves the broker down when it re-installs (#80). launchd can still be tearing the old job down when `bootout` returns, and a bootstrap then is refused with `Bootstrap failed: 5: Input/output error`; the install now waits (up to 10s) for the old job to be gone and retries the bootstrap. If the new LaunchAgent still won't load, the previous one is put back and loaded again instead of being deleted, and the error says so.
- launchctl's own reason (for example `Could not find service`) now appears in `broker install` and `broker uninstall` errors. It was discarded before, which also made `broker uninstall` on a machine with no loaded broker fail instead of reporting `unloaded: false`.

## [0.3.3] - 2026-10-03

### Fixed

- The broker starts after an unclean shutdown. A `broker.lock` written before the current boot is stale even when its pid is alive again: macOS reuses pids across boots, so a crash, power loss or forced VM stop could leave the broker failing with `another broker holds …/broker.lock` until someone deleted the file. A second live broker is still refused by the socket probe.

## [0.3.2] - 2026-10-02

### Fixed

- `broker install` writes stable Homebrew `opt` paths for node and agent-comms instead of versioned Cellar paths (#74), so `brew upgrade` plus `brew cleanup` no longer stops the broker. `broker status` reports the unit's `program` and flags one that still pins Cellar paths, with `agent-comms broker install` as the repair. App-bundle paths are written as they are.

## [0.3.1] - 2026-10-02

### Added

- A failed launch carries the daemon's `detail` through `launchStatus` (#71).
  The broker normalizes it to at most 512 characters of display text without
  control characters, records it with the result, and treats a different
  detail as a `conflict`.

## [0.3.0] - 2026-10-02

### Added

- Host-supplied service label, stored-credential name, log directory and state
  directories through one environment configuration (ADR-0059 decision 2,
  #61). Existing names remain compatibility defaults. LaunchAgent installation
  preserves overrides across login; CLI lifecycle and principal pairing tests
  verify host-selected names. Setup documents the variables and migration.

- One-account broker mode (#62, ADR-0059 decision 3). `broker install` with
  no `--group` (or `--single-account`) installs a broker that serves only
  the account running it: no group and no administrator. The rendezvous and
  proof directories are 0700 and the socket is 0600. `account pair` with no
  `--broker` pairs with that account's own broker. Group mode is unchanged
  when `--group` and `--broker` are given.

- Principal client API (#64, ADR-0007 amendment 1). `lib/principal-client.mjs`
  lets a host app act as the owner's principal over the broker protocol:
  census, send, inbox, and ack. Principals have their own mailbox; their
  messages pass the recipient's receive rules and the principal's grant, and
  a principal can never act as a soul. `docs/principal-client.md` documents
  the API; an example client in tests drives the full flow.

- Launch as a broker request (#65, ADR-0007 amendment 1 decision 2). A
  principal client asks the broker to launch an existing soul or a package in
  an account. The broker authorizes it like a send, records it, and forwards a
  `launch` frame to that account's daemon watch. The daemon reports
  `launch-result`, and the client polls `launchStatus()`. Neither the client
  nor the broker starts a process, and an interrupted launch is never
  replayed.

### Changed

- Platform behaviour sits behind four seams under `lib/platform/` (#63,
  ADR-0059 decision 4): local channel, secret store, service startup, and
  account isolation. macOS behaviour is unchanged; each Windows adapter
  fails with `platform-not-implemented`. A test rejects `process.platform`
  outside the seams.

## [0.2.1] - 2026-10-01

### Security

- The soul-token fetch sends a one-time binding proof (`x-agent-binding-proof`)
  instead of the binding secret (ADR-0008 amendment 1,
  qwts/agent-bot-identity#270). A process holding the daemon's loopback port
  while the daemon is down no longer learns a reusable secret. Needs an
  agent-bot daemon that accepts proofs.

## [0.2.0] - 2026-10-01

### Added

- Verified souls (ADR-0008 decisions 4 and 5). A daemon pairs with the broker
  as its own credential kind (`daemon-pair-request`, approved by the owner like
  an account), and its Ed25519 key signs short-lived soul tokens. A soul
  request carrying a valid token is `verified` in join, whoami, peers, the
  census, and message senders; a bad or expired token fails with
  `soul-token-invalid` and never falls back to a claim. Without a token the
  soul stays `claimed`.
- `account harden ACCOUNT [--off]`: a hardened account refuses tokenless soul
  requests with `unverified`. The setting survives broker restarts.
- The CLI acts for the soul in the binding (ADR-0008 decision 6):
  `AGENT_BOT_BINDING`, else `<git-dir>/agent-binding.json`, must be a private
  file owned by this account. It fetches a soul token from the binding's
  loopback daemon and reuses it until near expiry; a conflicting
  `QWTS_AGENT_ID` fails with `soul-mismatch`, a bad binding with
  `binding-untrusted`, and an unavailable daemon with `daemon-unreachable`.
  `whoami` reports the soul's `source`. Without a binding, `QWTS_AGENT_ID` then
  git config remain the bootstrap claim.
- Spawned souls: `agent-bot identity spawn` joins the child with its own
  binding, verified, with the parent recorded. The skill documents bindings,
  verification, and hardening.
- `account-watch` and `wake-report`: a paired daemon receives one coalesced
  wake per soul and records the outcome (`warm`, `cold`, `waiting`, or
  `failed`) on each message and in the census `lastWake`. `broker status`
  and the census show whether that account's daemon is watching.

## [0.1.0] - 2026-10-01

### Added

- Machine broker between persona accounts (ADR-0006): the owner runs
  `agent-comms broker run`, accounts pair once with owner approval, and the
  broker verifies the account on every call.
- `agent-comms` CLI with `join`, `leave`, `whoami`, `peers`, `send`,
  `inbox read`/`watch`/`ack`, `account pair`/`status`, `broker run`/`pairings`/
  `approve`/`revoke`, and `skill` subcommands; one JSON document on stdout,
  stable error codes on failure.
- Every client request has a deadline (`broker-timeout`), and each command
  validates its flags and arguments before any broker call.
- `inbox watch` sends one coalesced `wake` per burst by default (`--full` for
  message events), reconnects with capped backoff after a broker restart, and
  reports each outage as a `disconnected` event.
- `broker install`/`uninstall`/`status`: the broker runs as a LaunchAgent in
  the owner's login, behind a socket owned by the agent group with mode 0660.
- Principals for the owner's read-only view: `principal pair`,
  `admin principals`/`principal-approve`/`principal-revoke`, and the
  grant-filtered `census` and `health` operations that GeniusBar reads.
- `worker run` turns a headless harness (Codex by default) into an inbox
  worker: one turn per message inside a credential jail, a reply with an
  idempotent key, then an ack.
- Subagents get their own soul from agent-bot and join with their parent;
  `join` takes the parent from the agent-bot identity record when `--parent`
  is omitted.
- Durable mailbox with per-soul cursors and a JSON Lines watch stream
  (ADR-0004); A2A handled at the broker edge (ADR-0005).
- `agent-comms` skill with `setup`, `messaging`, `subagents`, and `workers`
  references; souls are claims in this release and the broker verifies
  accounts (ADR-0003).
- Architecture decisions ADR-0002 through ADR-0007; the messaging plane runs
  on the agent-bot daemon contract with zero runtime npm dependencies.
- Homebrew formula at `Formula/agent-comms.rb`, tapped by URL and installed
  from the release tag with Homebrew's Node.
- Release pipeline: `scripts/release` prepares a release PR that bumps every
  version site, and the Release workflow tags and publishes it after merge.
