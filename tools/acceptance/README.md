# Opt-in local acceptance tools

## Diagnostic resource and latency budgets

The standalone diagnostic probe uses fresh single-account broker processes and
synthetic credentials/messages. It compares reporting disabled/enabled for
healthy, deliberately failed, and unread stderr destinations. Each process runs
100 requests per second for 60 seconds, followed by a 10-second burst of 1000
diagnostic reports per second while real requests continue at 100 per second.
The six sequential runs take about seven minutes. Coordinate a quiet interval
with other sessions before measuring; concurrent suites invalidate a clean
paired latency claim. This is excluded from default `npm test` and runtime imports.

On macOS with a supported Node executable, run explicitly:

```sh
node tools/acceptance/local-diagnostics.mjs > /tmp/comms-diagnostic-budgets.json
```

To select named destination pairs, use `--modes healthy,failed`. The diagnostic
counterbalanced run is separate and takes about five minutes:

```sh
node tools/acceptance/local-diagnostics.mjs --counterbalanced healthy > /tmp/comms-diagnostic-counterbalanced.json
```

This runs disabled/enabled/enabled/disabled with fresh processes. Both opposite
order pairs retain their individual pass/fail results under the same thresholds;
a passing average cannot cancel a failing pair. Each phase also reports fixed
100-request windows of latency and driver scheduling lateness, diagnostic
write/drop snapshots and sampled main/helper CPU deltas. These windows follow
the planned 100/s schedule rather than wall-clock bins if the driver falls
behind. Quantiles are computed after timing stops. Driver lateness and CPU can
help locate variation but do not establish its cause.

The baseline disables reporting in the same instrumented broker. It retains
request timing reads, so it does not measure their overhead against an older
source revision. One asynchronous `ps` invocation samples only the owned broker
and its known helper; PID, parent PID and executable must match. Main/helper
RSS and CPU are reported separately and their simultaneous RSS sum is compared
with the disabled baseline. Helper warmup is included before deliberate failure.
The failed destination must stay disabled without respawn. The unread destination
must reach a real queue plateau and stalled in-flight write.

The report includes both phases, latency/throughput deltas, finite queue peaks,
cumulative drops, synthetic outcome checks, and natural broker exit without
surviving helpers. It contains no credentials, message bodies, paths or stable
identity IDs. macOS accounting evidence does not certify Linux, native Windows
budgets, packaged host integration or the remainder of #164.

The bounded startup-failure and owned-child cleanup probe is separate:

```sh
node tools/acceptance/local-diagnostics.mjs --cleanup-check
```

On failure, cleanup signals a helper only while its owned parent is live and
identity still matches, then awaits the owned broker's terminal exit. If exit or
helper cleanup cannot be confirmed, disposable `ac-diag-budget-*` scratch is
retained for manual review; the original failure and cleanup failures stay
separate in the internal aggregate. No raw failure stack is printed.

## State format compatibility acceptance

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
