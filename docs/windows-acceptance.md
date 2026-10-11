# Disposable Windows engine acceptance

[The runnable harness](../scripts/windows-acceptance.mjs) extends the native CI
probe with actual engine operations. It uses Windows APIs and production
adapters, not injected runners or a platform override. Read the exact reports
and scope below; the separately dispatched hosted diagnostic also retains a
`windows-engine-acceptance` JSON artifact. A harness alone proves no passed case.

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

Use a disposable Windows account. The harness writes beneath its actual
`LOCALAPPDATA`, retaining profile custody. It tracks registration attempts,
ends/deletes only its unique tasks, verifies absence and removes temporary
files. Never redirect another user's profile or target an existing installation.

GitHub's built-in Administrator token created new shared directories owned
by `S-1-5-32-544` (Administrators), which the broker correctly refused against
the account SID. The CI-only `windows-acceptance-user.ps1` bootstrap creates a
unique Users-only local account and profile, stages read-only inputs for that
SID, and runs child-owned checkouts with the same verified Node binary. Its
random password remains in memory. No global Git trust, ownership takeover or
task logon-mode change is used. Both the harness and administrator bootstrap
remove only their unique tasks, processes, profile, account and input stage.

Profile loading via `Start-Process -Credential -LoadUserProfile -UseNewEnvironment`
does not prove scheduler eligibility. The production `InteractiveToken` /
`LeastPrivilege` task must answer; failure remains failed acceptance, with no
Password or S4U fallback.

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

## Recorded native and desktop results

Hosted [run 38125543589](https://github.com/qwts/agent-comms/actions/runs/38125543589)
passed native pipe, Get-Acl, DPAPI and profile ownership checks, but its production
`InteractiveToken` task never ran (`Ready`, `0x41303`); no broker state/logs were
created. Scoped teardown succeeded. This remains a failed hosted engine result;
the later desktop passes do not relabel that environment as supported.

The [signed-in desktop engine run](https://github.com/qwts/agent-comms/issues/127#issuecomment-6111342700)
passed **11 required cases**, exit 0, on Windows 11 Pro 10.0.26200 x64 with a
non-elevated account, official Node 24.21.0 and signed comms candidate
`4a52a57b77d7787fe92d228dc73bba72e910f464`. The report is
`acceptance-pr148.json`, SHA-256
`ee387d99fd8acd4058e9e6fd39c90656b7c41d10cbbf20e2fb6bdfa8664f8f5b`.
It records `requiredEngineChecks=passed`; the released bot's supervisor omission
was separately `blocked-observed`, not a passed supervisor.

A [companion supervisor run](https://github.com/qwts/agent-comms/issues/127#issuecomment-6112051915)
passed **five required cases**, exit 0, with bot candidate
`63ad6f5b528b81ce0d8b42016875a1e758ef2861`, the same comms candidate and Node.
The production installer started the actual daemon; fresh wake/report, task
stop/restart and broker restart/reconnect preserved credentials and vouch key.
Report `bot934-supervisor-acceptance-63ad6f5b.json`, SHA-256
`0bd863ca5fa0b40e031f8671f4ce2a649543b26de1da692938b4c6ebfb16e963`,
records required supervisor checks passed. Native preflight also passed 3/3:
pipe/custody, binding persistence/refusal and task descendant lifetime. Both
desktop runs independently found zero test tasks and staged Node processes
after cleanup.

Supervisor scope is the installer and `runDaemon` API with explicit disposable
home and empty config. CLI default-home installation, actual logoff/logon,
packaged-host update and full harness launch remain untested.
[Bot PR #939](https://github.com/qwts/agent-bot-identity/pull/939) remains pending:
hosted CI still refuses its binding fixture's parent custody. The desktop pass
does not waive CI/review or establish a supported packaged tuple.

| Case | Actual operations and evidence boundary |
| --- | --- |
| Broker startup/lifecycle | CLI install, real scheduled-task execution, status through the answering broker, restart, uninstall and task absence; custom label and paths with spaces. The desktop used a non-elevated account; actual logon-trigger execution remains untested. |
| Principal and credential store | Real account/principal pairing, native CurrentUser DPAPI persistence, default principal library over the real named pipe, corrupted-store refusal and wrong broker-key refusal. The disposable plain copy is removed solely to prove the read comes from DPAPI; production pairing still writes it (#77). |
| Custody and unsupported mode | Real SID/owner queries on each configured directory; wrong-owner expectation and non-directory refusal; group install refuses before registration. This is not proof that every same-owner location is private or that same-account processes are isolated. |
| Released daemon provider | Normal `pairDaemonComms` creates/loads its Windows vouch key with native ACL checks, signs a soul token, establishes an actual watch, receives a wake and reconnects after broker task restart. No injected public key or credential provider. This tests the daemon communications library, not a supervised full daemon or harness launch. |
| Existing state | Candidate startup writes a version 2 retention checkpoint. The historical v0.3.16 reader must refuse that checkpoint without changing intact log bytes or credentials; candidate recovery retains tested identity, mailbox and acknowledgement state. Candidate also refuses an unknown future log record unchanged. The historical engine runs in the foreground; its task launcher is not installed. |
| Released supervisor baseline | The engine harness executes the pinned released renderer and real pairing, measuring the precise missing-shared-directory refusal. Its `blocked-observed` row remains historical released-component evidence. |
| Candidate supervisor companion | Actual installer/daemon API startup, fresh wake/report, task descendant stop/restart with new PID and stable credentials/key, then broker task restart/reconnect/report. Separate from CLI default-home and harness launch. |

The compatibility case requires an actual version 2 checkpoint, exact
historical-reader refusal, unchanged intact state bytes and candidate recovery.
It does not claim safe downgrade, unchanged torn suffixes, or a repaired
historical task launcher.

The candidate task uses an unnamed kill-on-close Windows job. Older tasks do
not gain that descendant lifetime protection retroactively. Cleanup retains
case JSON on failure; retained runtime directories may contain disposable
credentials and are identified only by path, never copied into reports.

Required engine case failures make the manually dispatched diagnostic fail. The supervisor's known negative
probe passes only when it reproduces the specific omission, and records the
dependent acceptance row as `blocked-observed`, never supported. The report
always keeps `completeEmbeddingAcceptance: false`. The released omission was
tracked in [bot #934](https://github.com/qwts/agent-bot-identity/issues/934);
the separate candidate supervisor pass advances that boundary without turning
this old-component negative probe into full daemon acceptance. Bot #865's
delivered keyd signer settings fix is distinct.

Startup reports retain safe error codes, task results and log hashes.

GeniusBar's Windows package, host namespace/service reconciliation, accepted
Windows product/migration contract, signed distribution and actual window
lifecycle remain host work. Native engine results can advance #127 without
establishing those guarantees or closing #46/#127. The result matrix records
the exact component commits, Node archive/executable hashes, tested SID and
unproven cases; it emits no credentials.

Historical-state continuity uses the separate [native upgrade harness](windows-upgrade-acceptance.md).
