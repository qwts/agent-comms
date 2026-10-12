# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Fixture-only bounded process adapter connects an actual compiled operation-specific native receipt worker to the broker journal/coordinator, with exact response correlation, independent process-close ownership, eleven command integrations, raw p1 JSON parity, and cancellation/revocation tests. Production artifact provenance, protected native observation, installed signing custody and physical readiness remain prerequisites; no owner route is enabled (#77).
- Disabled connected asynchronous receipt signing retains a durable presence intent before signing, verifies private candidates with a fresh clock, and requires one-use journal completion before dispatch. Bounded invocation lifetime, cancellation/revocation/restart tests and an operation-specific native contract advance integration without activating protected custody or physical support (#77).

### Fixed
- Preserve the Windows connector's closed local refusal stage through generic client error wrapping as nonenumerable internal metadata. Unknown/accessor and remote-response fields are excluded; public errors, authentication and deadlines remain unchanged (#164).
- Preserve the first client result or error before best-effort disposal, so a synchronous disposal throw or later close/error cannot replace it. Disposal attempts do not establish helper or descendant exit (#164).

### Validation
- Development-only Windows startup evidence can preserve the existing closed local connector stage through correlated fixture failure IPC, using an explicitly pinned reviewed source. Historical failures remain retained; native Windows capacity and installed host acceptance remain unqualified (#164).

## [0.5.3] - 2026-10-12

### Fixed
- Owner-action reason and complete display validation rejects frozen Unicode 17.0.0 `Cc`/`Cf`/`Zl`/`Zp` ranges, including bidi format controls. Ordinary RTL letters and combining marks preserve exact bytes without normalization; signed v1 fixtures remain unchanged. Native consumers must adopt the same explicit ranges before compatible display support is claimed (#221).
- Windows stale broker probes refuse an unexplained close instead of waiting indefinitely. An observed live connection stays `broker-running` even if disposal throws or emits a later error; late stream errors remain handled. This repairs constructor-level settlement defects without claiming the cause of earlier hosted capacity diagnostics (#164).

### Added
- Disabled bounded broker enrollment metadata store with immutable fixed-slot framing, separate one-use intent/audit/confirmation phases, explicit restart flush recovery and real filesystem crash/error tests. Protected native ceremony, private signing, physical reservation and runtime authority remain unsupported (#77).

### Upgrade notes
- This patch changes no durable checkpoint format and performs no credential migration, key provisioning or installed service activation. The 0.5.0 rollback guidance still applies to upgrades from 0.4.x.
- Broker enrollment metadata and native owner authority remain disabled/source-only; protected installation, signed app-only custody, fresh presence and separate-account cutover acceptance remain outstanding. Windows numeric capacity remains unqualified.

## [0.5.2] - 2026-10-12

### Fixed
- Broker readers enforce the owner-decision 32 KiB raw-frame and UTF-8 bounds before JSON payload parsing, including escaped and duplicate top-level operation fields. Ordinary comms retains its 128 KiB line limit; production owner authority remains unsupported (#77, #217).

### Added
- Immutable daemon-watch identity binding includes the daemon key, epoch and watch ID; reconnects receive a fresh binding and stale socket closure cannot remove its replacement (#210).
- Owner-decision prerequisites now include observation recovery, typed effect/refusal mapping, a canonical receipt issuer, and a coordinator with durable one-shot release and current-authority checks. Their synthetic conformance coverage does not establish live daemon effects or native custody (#211–#214).
- Authenticated owner-decision ingress and bounded prepare admission are connected to fixed production readiness checks. Production owner authority remains unsupported while protected enrollment, physical journal support and native acceptance are incomplete (#215).
- A public enrollment-chain codec validates bounded canonical records, audit/confirmation links, role-separated public pins and terminal revocation capacity. Parsing does not establish custody, durability or enrollment authority (#216).

### Upgrade notes
- The 0.5.0 checkpoint and rollback guidance still applies when upgrading from 0.4.x. This patch introduces no new checkpoint format and performs no credential migration, key provisioning or installed service activation.
- Windows numeric capacity remains unqualified. Native host custody, fresh presence, separate-account cutover and actual macOS 13 acceptance remain outstanding.

## [0.5.1] - 2026-10-12

### Fixed
- Exact principal approval uses the distinct private-admin `principal-approve-exact` operation, exposed by `admin principal-approve CODE --expected-principal ID`. A mismatched pending identity refuses without mutation, and older brokers refuse the unknown operation instead of ignoring its identity constraint. Ordinary code-only approval remains supported (#205).
- Journal publication clears owned descriptor bookkeeping before an uncertain close, avoiding an unsafe second close of a potentially reused descriptor (#207).

### Added
- Optional direct-send and principal-SDK `traceparent` propagation on live daemon mailbox wakes. A coalesced window and its rate hold carry context only when every contributor supplies the same valid value. Mixed/invalid batches, retries and catch-up/restart do not introduce context; messages, journals, outcomes, inbox events and receipts exclude it. Compatible daemon adoption and connected release acceptance remain separate (#164, #208).
- Disabled Darwin fixed-descriptor journal source bridge with pinned artifact checks, bounded actual-descriptor enumeration, persistent allocation and explicit full-flush primitives. No production helper binary or manifest is shipped; owner routes, physical-capacity support and native activation remain disabled. macOS 13 runtime, power-loss and installed app-only custody acceptance remain outstanding (#77, #207).

### Upgrade notes
- The 0.5.0 checkpoint and rollback guidance still applies when upgrading from 0.4.x. This patch does not introduce another state format or authorize credential cutover.
- Windows numeric capacity remains unqualified; retained supervisor/preflight diagnostics are separate development evidence, not Windows acceptance.

## [0.5.0] - 2026-10-12

### Upgrade notes
- Stop the broker and take a consistent backup before upgrading from 0.4.x. This engine reads checkpoint formats 1 and 2 and writes format 3; older engines refuse the new format. New owner-grant records also make downgrade against upgraded state unsupported. Rollback requires restoring the pre-upgrade backup and loses subsequent activity.
- Owner-decision routes remain disabled. Packaged codecs, proofs and journal prerequisites do not enable owner mutations, native presence, physical journal reservation or host credential custody (#77).

### Added
- Optional untrusted principal-launch `traceparent` propagation from the SDK through the broker to the live account-watch launch event. Exact lowercase version-00 values with nonzero IDs propagate; invalid values are omitted with a bounded local counter. Trace data is excluded from durable state, return/wake paths and diagnostic context. Host transport allowlist and daemon adoption remain separate; this is not installed end-to-end tracing (#164, #202).
- Dependency-free bounded local broker/client diagnostics for internal, storage, maintenance and transport failures, using fixed fields and an isolated stderr helper. Queue, event bytes, rate and drop accounting are finite; diagnostic failure or backpressure cannot alter real delivery. No remote reporting or exporter is enabled (#164).
- Explicit private-admin account/soul-scoped `ownerGrants`, separate from ordinary target grants, with empty legacy defaults and durable replay. The deprecated global `ownerOperations` list is nonauthorizing (#77, #200).

### Changed
- Retain daemon generation counters through revocation and re-pairing as an owner-decision prerequisite (#77). Checkpoint format 3 reads formats 1 and 2, but older engines refuse the new format; owner operations remain disabled.
- Revalidate the packaged messaging/setup/worker skill for 0.5.x against the current CLI and API, with explicit broker upgrade and rollback instructions.

### Validation
- Retained macOS total-runtime healthy, failed and unread diagnostic comparisons passed their scoped budgets using pinned complete runtime archives. CPU was recorded but ungated; earlier failed/confounded measurements remain retained. These results do not establish native Windows numeric capacity or host acceptance (#164).

## [0.4.4] - 2026-10-11

### Added
- A principal client factory for host-owned request transports, reusing typed ordinary operations without loading credentials into the factory. Native custody and owner-decision acceptance remain separate (#77).

## [0.4.3] - 2026-10-11

### Fixed
- Windows broker replacement and uninstall retain the previous broker process handle and require its exit plus a stopped task state before deleting or recreating the scheduled task. Stop/query/custody failures refuse replacement instead of reporting a successful restart (#127).

## [0.4.2] - 2026-10-11

### Fixed
- Add a principal-only target-grant query for agent-bot revision and cold-wake checks. Resolve registered soul accounts at the broker; pre-join targets require unrestricted or exact soul-ID grants. This narrows existing owner checks without adding signed decision receipts or changing credential custody (#77).

## [0.4.1] - 2026-10-11

### Fixed
- Run the Windows scheduled-task broker in a kill-on-close Job Object so stopping its launcher also stops descendants; fail closed if job setup fails. Acceptance waits for endpoint shutdown and preserves reports after cleanup errors (#148).

### Validation
- Signed-in, non-elevated Windows 11 desktop acceptance passed all 11 required engine cases on the #148 candidate, including scheduled-task restart and uninstall, DPAPI pairing, custody, native watch/wake, and checkpoint refusal/recovery. The independent native process-tree test also passed. Complete host embedding acceptance remains outstanding (#127); the observed supervisor namespace propagation regression is tracked separately in qwts/agent-bot-identity#934.

## [0.4.0] - 2026-10-11

### Upgrade notes
- Stop the broker and take a consistent backup before upgrading. Retention expires message bodies after 30 days, including unread messages; readers receive explicit loss notices.
- New checkpoints cannot be opened by older binaries. Do not downgrade against upgraded state; rollback requires restoring the pre-upgrade backup and loses subsequent activity. The released 0.3.16 reader can truncate an uncommitted torn suffix before refusing a newer checkpoint (#146).
- Packaged skill instructions now target 0.4.x. Live Windows desktop and persona-account acceptance remain outstanding (#127, #96).

### Fixed
- Isolate classic PowerShell child processes from inherited PowerShell 7 module paths so native Windows custody inspection, DPAPI and named-pipe helpers load the correct modules (#127, #140).


### Security
- CI sends a pull request from a fork, and every merge queue run, to GitHub-hosted runners even when a runner variable names a self-hosted runner, so outside code never runs on a self-hosted machine; `CONTRIBUTING.md` states the policy (qwts/agent-bot-identity#752).

### Added
- Local named channels with explicit invitations and subscriptions, atomic mailbox fan-out, seven-day snapshot retries, filtered inbox/watch/census, per-subscriber wake choices and separate principal capabilities. Version-2 checkpoints preserve channel identity and outcomes; older binaries cannot read the new format (#120).
- Bounded mailbox retention with owner-approved 30-day expiry including unread messages, 10,000-message/64-MiB limits, seven-day durable deduplication and explicit reader/watch loss notices. `inbox gap-ack`, principal `ackGap`, and bounded `cursor-expired` metadata make loss receipt and recovery explicit (#122).
- Versioned crash-safe checkpoints, independent task summaries, bounded expired-ID evidence, poisoned-writer refusal after uncertain storage failures, and `broker run --limits-file` controls. New state records make downgrade unsupported; back up consistently before upgrading (#122).

### Changed
- The README links the agent-bot [getting started guide](https://github.com/qwts/agent-bot-identity/blob/main/docs/getting-started.md), which sets up agent-bot and agent-comms together (qwts/agent-bot-identity#752).
- CI pins qwts-agent-ci at d9f8cf9, whose `Action Policy` admits a pull request from a fork when it runs on a GitHub-hosted runner in this public repository, so an outside contributor's pull request can pass CI once a maintainer approves its run (qwts/agent-bot-identity#752).

## [0.3.16] - 2026-10-10

### Added
- `launch-progress` accepts the conditional stages `runtimes`, `tool-home`, `provider` and `sign-in`, between `account` and `joining`, and `launch-result` takes an optional failure `code` (lowercase, at most 64 characters) that is kept across restarts, returned by `launch-status` and compared on duplicate results (#129, #130).

### Security
- On Windows, the default pipe connector uses a .NET client with an
  `Identification` impersonation ceiling before broker proof, with no
  unrestricted fallback (#133).

### Fixed
- The principal client keeps a Windows credential's broker SID and Ed25519 key pin instead of rejecting it for not having a numeric UID, so a Windows host can reach the authenticated named pipe (#127, #131).
- Reject a non-null failure `code` on a successful `launch-result` instead of silently dropping it, and explain the exact stable-code character rules (follow-up to #130).

## [0.3.15] - 2026-10-08

### Added
- `launch` accepts an optional `parent` (qwts/GeniusBar#261): `null` for an independent soul or an `agent_<uuid>` naming the companion parent, for both `soul` and `package` launches. The broker bounds the shape (`invalid launch parent` otherwise), records it on the `launch-request` and forwards it unchanged in the `launch` watch event; the daemon validates the parent against its census. The principal client forwards it when given (`undefined` omitted, `null` kept) and the CLI takes `--parent none|AGENT_ID`.
- Windows branches for two ADR-0059 seams, per GeniusBar ADR-0046 (qwts/GeniusBar#46): the secret store keeps the principal as a DPAPI-protected `principal.<credentialName>.dpapi` file in the `CurrentUser` scope, and service startup registers the broker as a per-user logon scheduled task from XML through `schtasks`, with the same operation names as the macOS branch. See [Windows](docs/windows.md).
- Windows branches for the other two seams (ADR-0046 decisions 1 and 2): account isolation identifies the account by its SID (`whoami /user`) and checks custody by owner through `Get-Acl`, one-account mode only; the local channel is the per-account named pipe `\\.\pipe\<serviceLabel>.<SID>`, on which the broker proves itself on every connection with an Ed25519 signature over the client's nonce and the pipe name, checked against the key pairing pinned from the broker's `identity.json`. Pairing records now carry `brokerKey` beside `brokerUid` where the channel pins one; a broker that fails to prove itself is `broker-untrusted`. New error code `account-unresolved` (the current SID could not be read).

## [0.3.14] - 2026-10-07

### Added
- `launch-result` accepts `sandbox: { resolution, account }` and `launch-status` returns it, so a client can show which account a soul runs as (agent-bot-identity #376).

## [0.3.13] - 2026-10-07

### Added

- `launch` accepts an optional `role` (qwts/agent-bot-identity#535): a short
  label for the new soul, 1–60 characters after trimming with no control
  characters, forwarded to the daemon unchanged, which writes it into the
  spawned soul's manifest. Invalid values fail with `invalid launch role`.

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
