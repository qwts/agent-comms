# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
