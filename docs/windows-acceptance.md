# Disposable Windows engine acceptance

[The runnable harness](../scripts/windows-acceptance.mjs) extends the native CI
probe with actual engine operations. It uses Windows APIs and production
adapters, not injected runners or a platform override. This change provides
the harness; live results must be read from the separately dispatched Windows diagnostic's
`windows-engine-acceptance` JSON artifact before claiming a passed case.

The test-only
[component snapshot](../tests/fixtures/windows-host-components.json) cites
GeniusBar `components.json` at commit
`4997eae75a3672846194987ff2f9f0fe36157be0`: Node 24.21.0, agent-comms
v0.3.16 (`98a0abb1d507563655fad435bdd26b047bbc9586`) and agent-bot
v0.10.62 (`19d7dfaa72cbbb259a988c55c65ac75c3425f3d0`). This is a fixture
derived from the host's metadata, not another shipping release registry.
The diagnostic downloads the selected Node zip, verifies its archive SHA-256,
and checks out the released engines by full commit. It runs both the
candidate and the released broker with that absolute Node executable;
no host-installed Node drives the acceptance operations.

The production Windows adapters normalize only their classic PowerShell
child environments, removing inherited `PSModulePath` without changing other
settings or the caller. This repairs the ordinary `pwsh` → Node →
`powershell.exe` CLI path; it is not a harness-only workaround. A native
regression starts Node with actual PowerShell 7 modules and requires real
Get-Acl inspection, wrong-owner refusal and a CurrentUser DPAPI round trip.
Microsoft documents this inherited-module-path behavior and the child-only
remedy in [about_PSModulePath](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath#starting-windows-powershell-from-powershell-7).

Only use a disposable Windows account. The harness registers uniquely named
scheduled tasks and writes to a temporary directory under the actual user's
`LOCALAPPDATA`, retaining inherited profile custody. It tracks registration
attempts before running them, ends/deletes only its own task names in
`finally`, verifies task absence and removes its temporary files. Do not
redirect another user's profile or run it against an existing installation.

GitHub's built-in Administrator token created new shared directories owned
by `S-1-5-32-544` (Administrators), which the broker correctly refused against
the account SID. The CI-only `windows-acceptance-user.ps1` bootstrap creates a
unique Users-only local account and profile, stages read-only inputs for that
SID, and runs child-owned checkouts with the same verified Node binary. Its
random password remains in memory. No global Git trust, ownership takeover or
task logon-mode change is used. Both the harness and administrator bootstrap
remove only their unique tasks, processes, profile, account and input stage.

`Start-Process -Credential -LoadUserProfile -UseNewEnvironment` starts the
profile process and keeps it alive through the harness. Profile loading alone
does not prove Task Scheduler eligibility: the production `InteractiveToken`
and `LeastPrivilege` broker task must actually start and answer. Failure stays
a failed environment/engine acceptance case; there is no Password or S4U fallback.

The required `Windows pipe security` CI job checks native named-pipe security,
custody and DPAPI. It does not claim engine or desktop acceptance. The manual
[Windows desktop diagnostics](../.github/workflows/windows-engine-diagnostic.yml)
retains the hosted bootstrap and fails when any required engine case fails; its
result is independent of the merge gate. Dispatch it explicitly to collect new
hosted evidence. Moving this diagnostic does not resolve its observed failure
or establish Windows support.

For the CI bootstrap, with checkouts and the verified sidecar prepared as in
that diagnostic workflow, run from PowerShell:

```powershell
$env:AGENT_COMMS_DISPOSABLE_WINDOWS = '1'
# Use the path and archive hash produced by the workflow's verified download.
./scripts/windows-acceptance-user.ps1 -Report .windows-results/acceptance.json
```

The bootstrap refuses execution outside a disposable GitHub Actions runner.
For another disposable Windows account, run the Node harness directly with
`--bot`, `--released-comms`, `--components` and `--report` paths, as its workflow
invocation specifies. No bootstrap should create accounts on an owner's machine.

The latest native result, [run 38125543589](https://github.com/qwts/agent-comms/actions/runs/38125543589),
passed the named-pipe transport, native Get-Acl ownership checks, CurrentUser
DPAPI round trip, and the standard user's profile-root ownership check. Broker
startup still failed: the profile root belonged to the standard SID, but the
production `InteractiveToken` task never ran (`Ready`, result `0x41303`, with
the scheduler's never-run last-run sentinel). No shared, proofs, state or client
broker directories and no startup logs were created; the CLI reported
`broker-unreachable` and the harness recorded `broker-not-ready`. Teardown found the namespaced tasks absent and removed the
disposable account without errors. This remains failed engine acceptance, outstanding independently of the merge gate.

The owner confirms an existing Windows VM is available but has not identified
an access path for its signed-in desktop. No signed-in desktop run has
been performed. A successful signed-in desktop acceptance run remains required
for Windows issue closeout; hosted deterministic CI cannot substitute for it.

| Case | Actual operations and evidence boundary |
| --- | --- |
| Broker startup/lifecycle | CLI install, real scheduled-task execution, status through the answering broker, restart, uninstall and task absence; custom label and paths with spaces. Logon trigger execution and a non-admin token are not established. |
| Principal and credential store | Real account/principal pairing, native CurrentUser DPAPI persistence, default principal library over the real named pipe, corrupted-store refusal and wrong broker-key refusal. The disposable plain copy is removed solely to prove the read comes from DPAPI; production pairing still writes it (#77). |
| Custody and unsupported mode | Real SID/owner queries on each configured directory; wrong-owner expectation and non-directory refusal; group install refuses before registration. This is not proof that every same-owner location is private or that same-account processes are isolated. |
| Released daemon provider | Normal `pairDaemonComms` creates/loads its Windows vouch key with native ACL checks, signs a soul token, establishes an actual watch, receives a wake and reconnects after broker task restart. No injected public key or credential provider. This tests the daemon communications library, not a supervised full daemon or harness launch. |
| Existing state | Candidate startup writes a version 2 retention checkpoint. The historical v0.3.16 reader must refuse that checkpoint without changing intact log bytes or credentials; candidate recovery retains tested identity, mailbox and acknowledgement state. Candidate also refuses an unknown future log record unchanged. The historical engine runs in the foreground; its task launcher is not installed. |
| Supervisor dependency | Execute the released supervisor environment/task renderer, then real pairing under those pinned settings. Match the precise missing-shared-directory refusal; unexpected behavior requires retriage. Full daemon task restart remains blocked by that observed defect. |

The compatibility case requires an actual version 2 checkpoint, exact
historical-reader refusal, unchanged intact state bytes and candidate recovery.
It does not claim safe downgrade, unchanged torn suffixes, or a repaired
historical task launcher.

The candidate task enters an unnamed Windows job before launching the broker.
Closing its non-inheritable job handle terminates only that task's descendant
tree, including when Task Scheduler forcibly ends the wrapper. Existing tasks
created by older releases do not gain this lifetime protection retroactively.
Cleanup records failures and retains the JSON case report even when Windows
refuses to remove a directory with open handles. A retained runtime directory
may contain disposable credentials; it is identified by path, never copied
into the report.

Required engine case failures make the manually dispatched diagnostic fail. The supervisor's known negative
probe passes only when it reproduces the specific omission, and records the
dependent acceptance row as `blocked-observed`, never supported. The report
always keeps `completeEmbeddingAcceptance: false`. This upstream defect is
the missing broker settings in
[GeniusBar #46's evidence](https://github.com/true-line/geniusbar/issues/46#issuecomment-6104555216),
distinct from agent-bot #865's delivered keyd signer settings fix.

Startup timeouts retain the last CLI error code, native task state/result and
filtered startup-log classifications and hashes. Arbitrary command output and
log text are excluded so a later restart failure cannot expose credentials.

GeniusBar's Windows package, host namespace/service reconciliation, accepted
Windows product/migration contract, signed distribution and actual window
lifecycle remain host work. Native engine results can advance #127 without
establishing those guarantees or closing #46/#127. The result matrix records
the exact component commits, Node archive/executable hashes, tested SID and
unproven cases; it emits no credentials.
