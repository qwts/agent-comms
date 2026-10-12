# State format compatibility acceptance

This opt-in harness tests actual source revisions on disposable state. It covers
the released v0.3.16 event-log reader, PR #141 checkpoint version 1, and PR #145
checkpoint version 2 with channel copies and retry outcomes. The exact commits,
generated fixture names and required assertions are pinned in
[the manifest](state-format-manifest.json). It does not establish full host
acceptance, Windows acceptance, power-loss guarantees or a supported downgrade.

## Run

Use a supported Node version, Git and `tar` on macOS or Linux. No package install
is needed. From this checkout:

```sh
npm run test:format-compatibility
```

The command performs no network access. All three pinned commits must already
exist in the local Git object database. A shallow CI checkout can fetch these
public source objects explicitly before running the command:

```sh
git fetch --no-tags origin \
  98a0abb1d507563655fad435bdd26b047bbc9586 \
  5d46dc7ea03ecfe8b3ec5963909b1d8b4a3f8c13 \
  cc9073db95db680cb4be2b5a42f845ec492fc79e
npm run test:format-compatibility
```

For an opt-in CI job, use a standard GitHub-hosted macOS or Linux runner,
read-only repository permissions, the repository's pinned checkout/Node actions,
the explicit fetch above and this separate command. It is excluded from default
`npm test`; that command gains no network or historical-source dependency.
Archive the output directory as evidence. No workflow is enabled by this change.

The runner prints its new temporary output directory. An explicit destination
must be new or empty:

```sh
npm run test:format-compatibility -- --output /tmp/comms-format-evidence
```

The directory contains exact source archives, the manifest, generated fixture
logs, `test.log` and `results.json` with environment, commit pins and before/after
SHA-256 hashes. Fixtures contain only newly generated identities, credentials'
hashes and synthetic messages. Temporary broker state is removed after testing;
the evidence directory remains for review and can then be deleted.

## What the evidence proves

The harness starts the actual released broker, pairs a disposable account,
joins two generated souls, accepts messages and acknowledges one copy. Actual
v1 and v2 brokers then migrate that history and return the original retry result.
The v2 broker creates a channel, commits two separate subscriber copies and
acknowledges only one. Restart must recover both copies, their independent
receipts, the membership snapshot and the original post outcome.

Older reader and broker-startup probes use copies of those emitted checkpoints
and event tails. They assert the exact refusal and every authoritative log byte.
Compatible restart must recover original IDs, bodies, receipts and retry
outcomes after each probe. Injected torn tails end without a newline, including
one inside a UTF-8 sequence; complete records are never reconstructed or guessed.

## Known downgrade limitation

**Never open upgraded state with an old binary.** The released reader refuses
intact v1/v2 checkpoints without modifying the log. With a torn suffix, however,
it truncates that suffix before discovering the unsupported checkpoint. The
harness confirms that every complete checkpoint and event byte survives, and a
compatible reader recovers all committed outcomes, but unconditional downgrade
non-mutation is false. Tests label this as a confirmed limitation, not downgrade
acceptance. The v1 reader validates first and refuses v2 even with a torn suffix
without changing any byte.

A future host migration guard should check the selected binary's supported
format against durable host metadata before opening authoritative state. Refuse
an incompatible launch before the old process runs; do not rely on its reader
to protect a newer format. This harness does not implement that guard, authorize
format rollback, restore a pre-upgrade backup or prove platform installation and
recovery behavior. Those host/release acceptance obligations remain separate.

## Local provider feasibility

The separate opt-in [Durable Object probe](../feasibility/durable-objects/README.md)
uses pinned dev-only vendor tooling and synthetic storage records. It measures
local atomicity, capacity, persisted outcomes and paging, not production federation
or cloud guarantees. It is excluded from the root runtime package and default
test command.
