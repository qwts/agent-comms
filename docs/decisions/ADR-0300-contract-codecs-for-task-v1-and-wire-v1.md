# ADR-0300: Contract codecs for task/v1 and wire/v1, checked against pinned soul-contracts fixtures

**Status:** Proposed
**Date:** 2026-11-07
**Issue:** qwts/agent-comms#300

Implements platform
[PDR-0024](https://github.com/true-line/agent-bot-platform/blob/main/docs/04-decisions/PDR-0024-comms-mirrors-task-v1-and-frames-wire-v1.md),
which leaves the comms-side choices to this repository.

## Context

PDR-0024 has agent-comms mirror HQ's `task/v1` records and frame routed
messages in `wire/v1`, and run every fixture of both from
[soul-contracts](https://github.com/true-line/soul-contracts). Three choices
were left here:

- how to validate JSON Schema, given that agent-comms has no runtime
  dependencies;
- how the codecs get the schemas at runtime;
- how the tests get the fixtures, which soul-contracts says implementations
  load from a pinned revision and never copy.

One part of PDR-0024 cannot be built yet. Every `wire/v1` frame needs
`destination_epoch`, the receiving Soul's installation epoch from HQ
admission. That is Stage 1 work. agent-comms' per-account daemon epoch
(`lib/state.mjs`) means something else.

## Decision

1. **A subset validator, failing closed.** `lib/contracts/json-schema.mjs`
   implements only the draft 2020-12 keywords that the vendored schemas use,
   plus RFC 3339 `date-time`. It refuses any other keyword or format when it
   compiles a schema. A soul-contracts update that needs more of the
   specification fails the tests instead of being half-checked. No validator
   dependency is added.
2. **Strict parsing before validation.** `lib/contracts/strict-json.mjs`
   refuses duplicate object keys at any depth (draft 0.4 section 6) and
   otherwise defers to `JSON.parse`.
3. **Schemas vendored with provenance; fixtures never.** The five `wire/v1`
   and `task/v1` schemas ship in `lib/vendor/soul-contracts/`, with
   `source.json` recording the tag, commit and SHA-256 of each file, as
   `lib/vendor/agent-bot-presence` does. The runtime reads only these files and
   never fetches.
4. **Tests read the pinned revision.** `tests/contracts-fixtures.test.mjs`
   fetches soul-contracts at `source.json`'s commit, caches it under
   `node_modules/.cache`, and checks four things:
   - the vendored schemas are byte-identical to that revision;
   - every schema under `wire/v1` and `task/v1` there is implemented;
   - every positive fixture is accepted unchanged;
   - every negative fixture is refused with the error code it names, or with
     `bad-request` when it names none.

   With no cache and no network the test fails; it never skips. Moving to a
   new soul-contracts release is one PR that updates the vendored files and
   `source.json`.
5. **Contract error codes pass through.** A refusal carries the code that
   soul-contracts registers (`frame_too_large`, `message_expired`,
   `required_capability_missing`) as a `CommsError` code, unchanged. This
   repository's own codes stay kebab-case. The contract's codes are snake_case
   because they belong to the contract.
6. **Admission always checks expiry and capabilities.** `admitFrame` requires
   a clock and the negotiated capability set; it has no lenient mode.
7. **Live framing waits on installation epochs.** `frameRoutedMessage`
   requires the caller to supply `destination_epoch` and guesses nothing.
   Broker delivery starts framing routed messages once HQ admission supplies
   installation epochs. Until then DRIFT-004 stays open on the platform.

## Consequences

- agent-comms meets the published fixtures today, with no dependency added
  and no change to installed clients, stored state or the local protocol.
- The tests need network access once per soul-contracts revision. CI has it;
  an offline first run fails loudly.
- The vendored schemas are a copy. The byte-equality test keeps them honest,
  but a release still has to bump them deliberately.
- soul-contracts has no LICENSE file yet, although the platform registry
  intends platform repositories to be MIT. The vendored schemas carry no
  separate licence until it adds one.
- The validator is deliberately small. It is not a general JSON Schema
  implementation and must not be used as one.
- PDR-0024 decision 4 holds: this work changes neither `wire/v1` nor
  `sealed-inner-v1`, checks a `sealed` object for shape only, and enables no
  federation.

## Alternatives

- **Add Ajv as a dependency:** rejected. agent-comms has no runtime
  dependencies, and a general validator would accept keywords the contract
  never meant to use.
- **Fetch schemas at runtime:** rejected. The broker must work offline, and
  its behavior must not change with a remote repository.
- **Copy the fixtures:** rejected. soul-contracts forbids it, and a copy
  drifts silently.
- **Frame live deliveries with the daemon epoch:** rejected. It would give
  `destination_epoch` a meaning the contract does not have.
