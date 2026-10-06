# ADR-0008: The daemon vouches for souls and carries their wakes

**Status:** Accepted
**Date:** 2026-10-01
**Issue:** qwts/agent-comms#25
**Amended:** 2026-10-01 (binding proofs, qwts/agent-bot-identity#270)

## Context

[ADR-0003](ADR-0003-agents-are-souls-humans-are-principals.md) decision 3
says a soul stays a `claimed` sender until the daemon keeps the binding in
the worktree's private git dir and vouches for it to the broker.
[ADR-0004](ADR-0004-durable-mailbox-and-waking.md) decisions 6 and 7 move
waking to the daemon's wake plane and make cold wake opt-in. Neither record
fixes the wire contract between the daemon, the CLI, and the broker. Both
repositories build their halves of R2 at the same time, so they need one.

Three facts shape the contract:

- The daemon listens on loopback HTTP with a per-start bearer token in a state
  file. ADR-0002 decision 4 and ADR-0003 decision 8 forbid the CLI from
  reading daemon state files, so the CLI cannot use that bearer.
- The broker trusts only accounts and principals. It has no way to tell the
  daemon's vouch from any other process in the same account.
- Both projects have zero runtime npm dependencies. Node ships Ed25519, but
  no WebSocket server.

## Decision

1. **The binding is a file the daemon writes into the private git dir.** A
   successful bind writes `<git-dir>/agent-binding.json`, mode 0600, where
   `<git-dir>` is `git rev-parse --git-dir` for that worktree. The file holds
   `{ "v": 1, "agentId", "parent", "account", "daemon", "secret" }`. `daemon`
   is the loopback base URL, and `secret` is 32 random bytes in base64url. The
   daemon keeps only `sha256(secret)` with the agent ID, git dir, parent, and
   timestamps, in `~/.local/state/agent-bot/bindings.json` (0600). Bindings
   survive daemon restarts and expire after 30 days unused. At startup the
   daemon rewrites `daemon` in every binding file it still knows. The MCP
   server, the CLI, and hooks all present the same file. A bind token is
   consumed only when no binding exists yet.
2. **A spawned soul's binding is a separate file.** `agent-bot identity spawn`
   writes the child's binding to `<git-dir>/agent-bindings/<agentId>.json` and
   hands its path to the child as `AGENT_BOT_BINDING`. That variable, when
   set, wins over the worktree's own file. Processes the parent starts without
   spawning share the parent's binding, so they are the parent. That is the
   accurate answer, because nothing distinguishes them.
3. **The daemon vouches with an Ed25519 signature.** `POST /v0/vouch` takes the
   binding secret in `x-agent-binding` and needs no bearer. It returns a soul
   token `v1.<payload>.<signature>`, both parts base64url. The payload is
   `{ "v": 1, "aud": "agent-comms", "account", "agentId", "parent", "iat",
   "exp", "nonce" }`, with `exp` at most 300 seconds after `iat`. The signing
   key is a per-account Ed25519 pair the daemon creates once, at
   `~/.local/state/agent-bot/vouch-key.pem` (0600).
4. **The daemon pairs with the broker as its own credential kind.** The daemon
   runs `daemon-pair-request` with the same kernel-stamped proof file as an
   account pairing (ADR-0006), plus its SPKI public key. The owner approves it
   by code on the admin socket, exactly like an account. After that the daemon
   authenticates as `auth: { daemon: <account>, secret }`. One daemon is
   paired per account. Pairing again replaces the key only after the owner
   approves.
5. **The broker marks a soul `verified` only on a valid soul token.** A request
   that acts for a soul (`join`, `send`, `inbox`, `ack`, `watch`, `leave`) may
   carry `soulToken`. The broker checks the signature against the account's
   approved daemon key, `aud`, `exp`, the account, and that `agentId` names
   the soul in the request. A valid token makes the soul `verified` in the
   join result, the census, peers, `message.from`, and `whoami`. A token that
   is bad or expired is refused with `soul-token-invalid`, never downgraded.
   With no token the soul stays `claimed`, unless the owner has hardened the
   account (`agent-comms account harden <account>`). A hardened account
   refuses tokenless soul requests with `unverified`. Hardening is per account
   and reversible.
6. **The CLI resolves the soul from the binding first.** If `AGENT_BOT_BINDING`
   or `<git-dir>/agent-binding.json` exists, its `agentId` is the soul, and
   the CLI fetches a token from its `daemon` URL. A `QWTS_AGENT_ID` that
   disagrees fails with `soul-mismatch`. With no binding the CLI falls back to
   the bootstrap claim, `QWTS_AGENT_ID` then git config, and the result stays
   `claimed`. The parent comes from the binding or the token, never from
   daemon state files.
7. **The daemon is the paired client that wakes.** A paired daemon opens
   `account-watch`, which streams one coalesced
   `{ "event": "wake", "agentId", "count", "cursor", "messageIds" }` per soul
   of its account. It answers each with `wake-report { agentId, messageIds,
   outcome, detail }`, where `outcome` is `warm`, `cold`, `waiting`, or
   `failed`. The broker records the outcome beside each message and in the
   census `lastWake`. A soul's own `inbox watch` still counts as warm, so
   R1 workers keep working.
8. **Sessions arm a listener at the daemon; its sockets are the warm pool.**
   `GET /v0/wake` upgrades to a WebSocket and authenticates with the binding
   secret. The daemon implements the minimal server half of RFC 6455 itself:
   text frames, ping and pong, close. `agent-bot wake listen` connects and
   prints each frame as one NDJSON line, so any harness can run it under a
   persistent watcher such as Claude Code's `Monitor`. A dropped socket
   demotes the session to cold. The SessionStart hook tells each session in
   bot territory to arm the listener, on every start.
9. **Cold wake is off unless the owner turns it on per soul.** With
   `agent-bot soul cold-wake <agentId> on`, a wake for a soul with no warm
   socket starts one drive-plane turn through the daemon's ACP executor, in
   the soul's worktree. The turn's prompt names the message IDs and nothing
   else. The setting is a daemon principal operation with a secret-free
   receipt. With it off, the outcome is `waiting`.

## Amendment 1: binding proofs (2026-10-01)

**Issue:** qwts/agent-bot-identity#270

Decisions 3 and 8 had clients send the binding secret in `x-agent-binding`.
That presents the secret to whatever accepts TCP at the binding file's
loopback URL. While the daemon is down its port is free, so another local
uid can hold it and keep a secret that authenticates every binding route.
That uid is outside the same-account boundary in Consequences.

Clients now send a one-time proof instead, and never the secret:

```
x-agent-binding-proof: v1.<keyId>.<unix milliseconds>.<nonce>.<mac>
```

- The key is `sha256(secret)`, which the daemon registry already stores.
- `keyId` is `sha256("agent-binding-id\0" ‖ key)` in base64url, so the
  daemon can find the binding without the key being sent.
- `mac` is HMAC-SHA256 under the key, over the method, the path, the daemon
  `host:port` the client is calling (spelled as the binding URL spells it),
  the timestamp, and the nonce.
- The daemon checks the MAC against its own address. It accepts the
  timestamp only within 60 seconds and refuses any nonce it has seen.
- The daemon refuses proofs made before it started. Its nonce cache does not
  survive a restart, so a proof captured while it was down must not be
  replayable when it comes back on the same port.

A process squatting the port learns one spent proof that names the squatted
port. That proof fails at the daemon's real port. The squatter can still
answer a client falsely, for example with fake wake frames, but it cannot
act as the soul.

For compatibility, the daemon still accepts the bare `x-agent-binding` from
older clients. agent-comms 0.2.1 and agent-bot-identity's clients send only
proofs. The client half lives in a dependency-free module that both
repositories carry identically.

## Amendment 2: delivered asides (2026-10-06)

**Issue:** qwts/agent-comms#100

The daemon records an aside for every message that enters a soul's context
(qwts/agent-bot-identity#404). It sees the relay prompt, the thread it
reshows, and a soul's own sends. It cannot see a soul reading its own mail:
that read goes from the CLI to the broker, and the daemon is not on that path.
This amendment closes the gap from the client side.

1. **A session that prints messages tells the daemon which ones.** After it
   prints, `inbox read` and `inbox hook` POST
   `{"messageIds", "via", "harnessSessionId"?}` to
   `POST /v0/asides/delivered`, where `via` is one of the two values
   agent-bot reserves for them: `inbox-read` or `hook-inject`.
2. **The report carries the binding's proof.** It authenticates exactly as
   `POST /v0/vouch` does under Amendment 1: a one-time proof, never the
   secret.
3. **Only what a session read counts.** `inbox count` and `inbox ack` report
   nothing, a page reports only the ids on it, and `inbox read --json` whose
   output a script consumes reports nothing; a terminal behind it, a plain
   read, or the hook counts. `inbox hook` prints the whole waiting backlog for
   a harness session to inject and names that session from `--session-id`,
   `AGENT_HOOK_SESSION_ID`, or `CLAUDE_SESSION_ID` when it has one.
4. **The report is best effort.** A daemon that is down, older than this
   route, silent past 2 s, or refusing changes neither the bytes the command
   printed nor the code it exits with. `AGENT_COMMS_DEBUG=1` puts one line
   about the outcome on stderr.
5. **The daemon's own reads never report.** agent-bot reads a soul's mailbox
   through this CLI too (its relay, and the delivered route itself); it sets
   `AGENT_COMMS_NO_DELIVERY_REPORT=1` on those, so a report never recurses.
6. **Only a bound session reports.** With no binding there is no credential to
   prove the soul with, so an unbound session's read leaves no aside rather
   than an unattributable one.

**Added consequences:**

- A live session's inbound messages appear in GeniusBar like a cold wake's do.
- A report the daemon never receives leaves the blindness this amendment
  removes. Nothing is worse than before, because no read ever depended on it.
- A daemon that does not know the route answers 404, and the read carries on;
  a soul running an older agent-comms reports nothing, as it did before.

## Consequences

- A soul becomes `verified` without the broker reading any daemon state, and
  without the CLI reading the daemon's bearer token.
- Any process in the account can still read the binding file. Verification
  proves that a caller holds the soul's binding, not which OS process it is.
  Peer credentials can tighten this when ADR-0006's native helper exists.
- Persisting the binding reverses agent-bot-identity's rule that the bind
  secret is never written down. Its README and tests change with it.
- R1 workers that use `QWTS_AGENT_ID` with no binding keep working as
  `claimed` souls on accounts that are not hardened.
- A hand-written WebSocket server is a new surface. It only listens on
  loopback and only behind binding authentication.

## Alternatives

- **Push token hashes from the daemon to the broker.** This needs the daemon
  online for every vouch, and a hash per token. A signature needs neither.
- **Use the daemon's bearer token from the CLI.** ADR-0002 decision 4 forbids
  it, and any same-account process could then bind as any soul.
- **Use NDJSON over HTTP instead of a WebSocket.** It is simpler, but
  agent-bot-identity#147 and the spike behind it chose WebSocket for
  `Monitor`. `wake listen` hides the difference from harnesses either way.
