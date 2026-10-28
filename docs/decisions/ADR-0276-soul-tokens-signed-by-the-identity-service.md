# ADR-0276: The broker accepts service-signed soul tokens

**Status:** Accepted
**Date:** 2026-10-28
**Issue:** qwts/agent-comms#276

Amends [ADR-0008](ADR-0008-daemon-vouching-and-the-wake-plane.md) decisions
3–5.

## Context

ADR-0008 pairs the agent-bot daemon with the broker by its host Ed25519
vouch key (`vouch-key.pem`, decision 4) and has it sign `v1.` soul tokens
locally (decision 3). The security split of the agent-bot runtime — the
daemon becomes an HQ that keeps no long-lived signing secrets a member
host could lose — moves soul-token signing to the identity service
(`true-line/agent-bot`), which mints a five-minute ES256 JWS per request
through its daemon API. The daemon then carries no vouch key at all on
hosts enrolled in server mode, and a stolen host holds nothing the broker
still trusts.

The daemon side is opt-in
(`qwts/agent-bot-identity`, `AGENT_BOT_SOUL_TOKENS=v2` /
`settings.soulTokens: "v2"`): in server mode it sends
`daemon-pair-request` with `soulTokens: { v: 2, issuer, device }` instead
of `publicKey`, and asks the service for each token via
`POST /api/daemon/soul-token` (`true-line/agent-bot` PR #36). The broker
must accept both credential forms during the transition.

## Decision

1. **A daemon pairs with either a host key or an issuer descriptor —
   exactly one.** `daemon-pair-request` takes `publicKey` (v1, unchanged)
   or `soulTokens: { v: 2, issuer, device }`. The issuer must be an
   absolute `https:` origin (no credentials, query, or fragment;
   normalized without a trailing slash) listed in the broker's
   `soulTokenIssuers` setting — default `["https://agents.true-line.ai"]`,
   overridable by broker config or `AGENT_COMMS_SOUL_TOKEN_ISSUERS`;
   loopback `http://127.0.0.1:<port>` / `http://localhost` issuers are
   accepted only when explicitly listed, for tests. The device id is a
   short single token. Re-pairing still replaces the credential only
   after owner approval.
2. **The broker verifies v2 tokens against the issuer's published keys.**
   The service exposes `GET <issuer>/.well-known/agent-bot/soul-keys.json`
   (JWK EC P-256 ES256 keys, current first). The broker caches it in
   memory: refreshed at broker start for every v2-paired issuer, when a
   v2 pairing is approved, periodically while a v2 pairing exists, and —
   throttled — when a token names an unknown `kid`. A failed refresh
   keeps the last good keys; nothing on disk learns the key material.
3. **Device binding replaces key binding.** A v2 token is a compact JWS
   (`alg: ES256`, `typ: soul+jwt`, `kid`) verified over
   `header.payload` with the paired issuer's key, and its claims must
   match the request exactly: `v: 2`, `iss` the paired issuer,
   `aud: "agent-comms"`, `sub` the soul, `account` the account, `device`
   the paired device, and integer `iat`/`nbf`/`exp` inside the same
   30-second skew and 300-second lifetime bounds as v1. It is a bearer
   token for its five minutes — every soul request presents it and the
   `jti` is informational, not a nonce. `cnf` is unenforced here.
4. **The two forms are never interchangeable.** A `v1.` token on a
   `soulTokens` pairing is invalid, as is a v2 JWS on a `publicKey`
   pairing; both fail `soul-token-invalid`, never downgrade. v1 stays
   valid for host-key pairings during the transition and can be retired
   early with `AGENT_COMMS_SOUL_TOKEN_V1=0`.

## Consequences

- Paired machines whose daemon opted into v2 keep souls `verified`
  without a host vouch key; revocation moves to the identity service
  (`device` claim) rather than to a file the host still holds.
- Broker restarts re-warm the JWKS cache from the journal's `soulTokens`
  descriptors; old journals with `publicKey` pairings replay unchanged.
- Removing v1 is a later release: flip the daemon default, set the env
  gate, then drop the `publicKey` pairing form when no v1 pairings
  remain.
