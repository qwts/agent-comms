# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
