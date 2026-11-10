# ADR-0306: Broker mode as an HQ plugin, on a vendored agent-bot-hq SDK

**Status:** Proposed
**Date:** 2026-11-09
**Issue:** true-line/agent-bot-comms#306

Implements the agent-comms half of row 13b in the agent-bot-hq migration plan
([§4.9 and §9](https://github.com/true-line/agent-bot-hq/blob/main/docs/daemon-plugin-split.md)).
The owner decided on 2026-11-08 that agent-comms ships its broker mode as an
HQ plugin and that HQ hosts it. The HQ half merged in
[agent-bot-hq#102](https://github.com/true-line/agent-bot-hq/pull/102).

## Context

HQ core opens `broker.sock` and hands every frame on it to the one plugin
that serves the broker. A member's first frame is `bind`, carrying the
runtime ID and channel binding from its admission result. hq-admission's
`verifyBinding` decides whether that binding speaks for a live runtime. Every
later frame is delivered to the plugin that registered its kind, such as
hq-tasks for `task.commit`, with the bound runtime ID alone. The consumer
re-checks liveness, epoch and lease generation on each delivery.

Three choices were left here:

- how agent-comms gets the SDK that defines a plugin, given that it has no
  runtime dependencies and the SDK is not published;
- where the plugin lives in this repository;
- how to show the row's exit evidence, which needs the real HQ, from a
  repository that does not contain it.

## Decision

1. **The SDK is vendored with provenance.** `lib/vendor/agent-bot-sdk/` is
   agent-bot-hq's `sdk/` directory, byte for byte, at the commit in
   `source.json`, with the SHA-256 of each file and agent-bot-hq's MIT
   notice. This is the same arrangement as `lib/vendor/soul-contracts/`
   (ADR-0300). Moving to a new SDK is one PR that replaces the files and
   `source.json`.
2. **The plugin lives in `lib/hq-plugin/`.** `plugin.mjs` has the single
   default export the SDK requires. `broker.mjs` builds it: name and version
   come from `package.json`, and it requires `hq-admission` `^0.1.0`.
3. **The plugin authorizes the binding and nothing else.**
   - A first frame other than `bind` is `caller_mismatch`.
   - A second `bind`, or one while a bind is in flight, is
     `host.invalid_request`.
   - hq-admission's own refusals pass through unchanged.
   - A connection that closes during its bind is left unbound.
   - `bind.challenge` goes to hq-admission's `bindChallenge` with the
     connection, and so does the `bind` that answers it. HQ needs the
     connection to tell which member account is calling (agent-bot-hq plan
     §9 row 16a, added 2026-11-10). A bound connection gets no challenge.

   Every later frame goes to `ctx.broker.deliver` with the runtime ID. The
   channel binding never leaves the plugin. Deciding whether a runtime is
   still live stays with the consumer, which is what refuses a superseded or
   expired runtime on a connection that is already bound.
4. **The tests run the real HQ.** `tests/hq-broker-plugin-hq.test.mjs`
   fetches agent-bot-hq at `source.json`'s commit, caches it under
   `node_modules/.cache`, and starts HQ from it with this plugin serving
   `broker.sock`. It checks the row's exit evidence over the socket:
   - a member bound by its channel binding commits a task;
   - a wrong, superseded or expired binding is refused;
   - T05 holds over the socket.

   `tests/hq-broker-plugin.test.mjs` checks that the vendored bytes match
   that commit, runs the SDK conformance suite, and covers the plugin's own
   refusals on the SDK test host. With no cache and no network the tests
   fail; they never skip.
5. **Errors cross copies of the SDK.** The plugin raises errors through its
   vendored copy. agent-bot-hq recognises them by a registered-symbol brand
   ([agent-bot-hq#104](https://github.com/true-line/agent-bot-hq/pull/104)),
   so a member receives `caller_mismatch` rather than `host.internal`. The
   vendored revision includes that change.

## Consequences

- HQ can run agent-comms as its broker today. Nothing changes for installed
  clients, the per-account daemon, stored state or the local protocol. HQ
  loads plugin objects; reading `plugin.json` from disk and the
  `governance/plugins.json` digest check arrive with the bundled HQ release
  (plan §9 row 27).
- In the cooperative profile a channel binding is a bearer secret in the
  member's environment, so a member that reads another member's binding can
  speak for it. HQ reports `managed-cooperative` for that reason. Row 16
  adds caller-bound handles; this plugin's interface does not change.
- The vendored SDK is a copy, kept honest by the byte-equality test. The
  tests need network access once per agent-bot-hq revision.
- Routed messages between Souls are not part of this. They are framed in
  `wire/v1` at the delivery and relay layer (PDR-0024) once HQ supplies
  installation epochs (#300).

## Alternatives

- **Depend on agent-bot-hq through npm or a git URL:** rejected. agent-comms
  has no runtime dependencies, and the SDK is not published.
- **Copy only `plugin.mjs` and `errors.mjs`:** rejected. The conformance
  suite and test host are how a plugin repository tests itself (plan §4.6),
  and a partial copy drifts silently.
- **Test only against a stand-in HQ:** rejected. The row's exit evidence is
  about the real socket, admission and task service. A stand-in would show
  only that the plugin agrees with itself.
