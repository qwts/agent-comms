# ADR-0309: A soul-token v2 pairing identifies its daemon by issuer and device

**Status:** Proposed
**Date:** 2026-11-10
**Issue:** true-line/agent-bot-comms#309

Amends [ADR-0276](ADR-0276-soul-tokens-signed-by-the-identity-service.md)
decision 3 and the watch identity of
[ADR-0077](ADR-0077-owner-decisions-through-the-broker.md).

## Context

The account watch's `ready` event and every owner-decision record carry
`daemonKey`, defined as SHA-256 of the approved daemon's Ed25519 public
key in DER SPKI form
([owner-decision envelopes](../owner-decision-envelopes.md)). ADR-0276 let a
daemon pair with `soulTokens: { v: 2, issuer, device }` and no host key, but
left `daemonKey` as it was. The first real host to switch (2026-11-10) could
no longer open its account watch: the broker tried to parse a key the pairing
does not have and answered `internal`. Wake reports, launch results and
owner-decision delivery all travel on that watch.

Two fixes were possible. A v2 pairing could also carry the host key, which
keeps `vouch-key.pem` on the host and defeats the purpose of ADR-0276. Or the
identity could come from what a v2 pairing does have. The owner chose the
second.

## Decision

1. **`daemonKey` names the pairing's credential, in either form.** For a
   host-key pairing it is unchanged. For a v2 pairing it is

   ```text
   SHA-256( "agent-comms/daemon-identity/v2" LF issuer LF device )
   ```

   as 64 lowercase hex characters, over UTF-8 bytes, with `issuer` the
   normalized origin and `device` the id exactly as journaled at pairing.
   Neither can contain a line feed, so the encoding is unambiguous, and the
   label keeps it apart from any SPKI hash.
2. **One function derives it.** The account watch and the owner-decision
   coordinator both call `daemonIdentityKey`
   (`lib/broker/daemon-identity.mjs`). An approved daemon row with no usable
   credential is refused as `unauthenticated` (watch) or `preparation-stale`
   (owner decision), never `internal`.
3. **A changed credential is a changed identity.** Re-pairing with another
   device, another issuer, or the other credential form changes `daemonKey`,
   so existing watch bindings and in-flight owner decisions stop matching,
   exactly as a host-key rotation does today. `daemonEpoch` still advances on
   every approval.
4. **The wire shape does not change.** `daemonKey` stays a SHA-256 digest in
   every envelope and journal record; only its preimage differs. No record
   version moves.

## Consequences

- A v2-paired daemon can hold an account watch again, so wakes and launch
  results work without a host key.
- **Owner decisions over a v2 pairing are not finished by this record.** The
  daemon compares the broker's `daemonKey` with a value derived from its own
  vouch key, and its owner-decision trust observation publishes that key as
  an Ed25519 public key. Until `agent-bot-identity` derives the same v2
  value and its trust records say what stands in for the host key, a v2
  daemon binds no watch identity and owner decisions for its account are
  unavailable. That is the safe direction: nothing is authorized on a
  mismatched identity.
- For a v2 pairing `daemonKey` is an identifier, not a key: nothing can be
  verified against it. The broker never verified a signature with it for
  owner decisions either, but readers of the journal should not assume a key
  behind the digest.
- The digest reveals nothing by itself, but issuer and device are low
  entropy. Anyone who knows both can recompute it; it must never be treated
  as a secret.
