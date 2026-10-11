# Disposable Windows engine acceptance

[The runnable harness](../scripts/windows-acceptance.mjs) extends the native CI
probe with actual engine operations. It uses Windows APIs and production
adapters, not injected runners or a platform override. This change provides
the harness; live results must be read from the Windows CI job's
`windows-engine-acceptance` JSON artifact before claiming a passed case.

The test-only
[component snapshot](../tests/fixtures/windows-host-components.json) cites
GeniusBar `components.json` at commit
`4997eae75a3672846194987ff2f9f0fe36157be0`: Node 24.21.0, agent-comms
v0.3.16 (`98a0abb1d507563655fad435bdd26b047bbc9586`) and agent-bot
v0.10.62 (`19d7dfaa72cbbb259a988c55c65ac75c3425f3d0`). This is a fixture
derived from the host's metadata, not another shipping release registry.
The job downloads the selected Node zip, verifies its archive SHA-256,
and checks out the released engines by full commit. It runs both the
candidate and the released broker with that absolute Node executable;
no host-installed Node drives the acceptance operations.

Only use a disposable Windows account. The harness registers uniquely named
scheduled tasks and writes to a temporary directory under the actual user's
`LOCALAPPDATA`, retaining inherited profile custody. It tracks registration
attempts before running them, ends/deletes only its own task names in
`finally`, verifies task absence and removes its temporary files. Do not
redirect another user's profile or run it against an existing installation.

With the fixture checkouts and checksum-verified sidecar prepared as in
`.github/workflows/ci.yml`, run from PowerShell:

```powershell
$env:AGENT_COMMS_DISPOSABLE_WINDOWS = '1'
# Use the path and archive hash produced by the workflow's verified download.
& $env:AGENT_COMMS_ACCEPTANCE_NODE scripts/windows-acceptance.mjs --bot .windows-fixtures/agent-bot --released-comms .windows-fixtures/agent-comms --components tests/fixtures/windows-host-components.json --report .windows-results/acceptance.json
```

| Case | Actual operations and evidence boundary |
| --- | --- |
| Broker startup/lifecycle | CLI install, real scheduled-task execution, status through the answering broker, restart, uninstall and task absence; custom label and paths with spaces. Logon trigger execution and a non-admin token are not established. |
| Principal and credential store | Real account/principal pairing, native CurrentUser DPAPI persistence, default principal library over the real named pipe, corrupted-store refusal and wrong broker-key refusal. The disposable plain copy is removed solely to prove the read comes from DPAPI; production pairing still writes it (#77). |
| Custody and unsupported mode | Real SID/owner queries on each configured directory; wrong-owner expectation and non-directory refusal; group install refuses before registration. This is not proof that every same-owner location is private or that same-account processes are isolated. |
| Released daemon provider | Normal `pairDaemonComms` creates/loads its Windows vouch key with native ACL checks, signs a soul token, establishes an actual watch, receives a wake and reconnects after broker task restart. No injected public key or credential provider. This tests the daemon communications library, not a supervised full daemon or harness launch. |
| Existing state | Candidate/released/candidate broker restarts retain tested identity, account/principal credentials, mailbox and acknowledgement state; both brokers refuse an unknown future log record without changing those log bytes. New persisted formats require their own known downgrade-refusal evidence. |
| Supervisor dependency | Execute the released supervisor environment/task renderer, then real pairing under those pinned settings. Match the precise missing-shared-directory refusal; unexpected behavior requires retriage. Full daemon task restart remains blocked by that observed defect. |

The current compatibility case creates log-only state. When integrating
[#122](https://github.com/qwts/agent-comms/issues/122), extend it to create an
actual retention checkpoint and require the older broker to refuse without
changing state, then verify candidate recovery. Do not require a successful
downgrade across a newly incompatible format or infer checkpoint evidence from
the generic future-record probe.

Required engine case failures make CI fail. The supervisor's known negative
probe passes only when it reproduces the specific omission, and records the
dependent acceptance row as `blocked-observed`, never supported. The report
always keeps `completeEmbeddingAcceptance: false`. This upstream defect is
the missing broker settings in
[GeniusBar #46's evidence](https://github.com/true-line/geniusbar/issues/46#issuecomment-6104555216),
distinct from agent-bot #865's delivered keyd signer settings fix.

GeniusBar's Windows package, host namespace/service reconciliation, accepted
Windows product/migration contract, signed distribution and actual window
lifecycle remain host work. Native engine results can advance #127 without
establishing those guarantees or closing #46/#127. The result matrix records
the exact component commits, Node archive/executable hashes, tested SID and
unproven cases; it emits no credentials.
