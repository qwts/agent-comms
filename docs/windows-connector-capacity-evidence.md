# Windows capacity pilot preflight evidence

Related to [the bounded pilot](windows-connector-capacity.md) and
[#164](https://github.com/qwts/agent-comms/issues/164), which remains open. These
are retained setup and cleanup outcomes, not offered-load capacity results.

The initial hosted preflight
[38202022510](https://github.com/qwts/agent-comms/actions/runs/38202022510), at
head `1e45919a5a6efbf2c345915509963fda671bd2f9`, failed in the standard-user
bootstrap, with no uploaded reports or assessable cases. Its retained full log
has SHA256 `8b9a657633bc18e03cf065f9ed0f4eeeddefd937c38c3f036f0113270674a3d8`.
The relative report argument was resolved through .NET's process directory,
which can differ from PowerShell's location: a hypothesis, not an established
failure cause. FileSystem resolution, write-failure summaries and a divergent
directory CI regression address these reporting gaps.

The second preflight
[38202529932](https://github.com/qwts/agent-comms/actions/runs/38202529932), at
head `bf91367c2ae21950a1796330173514a07c649109`, also failed. Its fixed console
summary records a failed child exit with no bootstrap exception or cleanup
errors. Its retained full-log SHA256 is
`37ce2d742f87e38324f745a15d68420b91025bf01d65e22ca632528373b4b12b`.
The action's hidden-file exclusion omitted `.windows-results/`: a confirmed
upload defect separate from the earlier path hypothesis. Hidden files are now
enabled only for four named JSON paths, with no recursive source, credential or
state upload. The console also records bounded child failure gate/error type.
Neither failed run establishes startup/cleanup or capacity qualification.

The third preflight
[38202921658](https://github.com/qwts/agent-comms/actions/runs/38202921658), at
head `17cdf5a6a2fc34a1c322384acc0b01470bf87099`, retained its report successfully.
Its [retained report](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38202921658-acceptance.json)
records `clone-child-owned-inputs` / `RemoteException`, a loaded non-admin
profile, and completed bootstrap cleanup with no errors. Report SHA256 is
`51ea6de477df90104e344ad9b814615e46d5295fafc6b6576811cbf573b8be9a`;
full-log SHA256 is
`8d8937ddd5fbe4669e9ee3929c99ff69fc23314c909758bedcab816e0a59e205`.
No production fixture or offered workload ran. This is consistent with classic
PowerShell promoting Git's native stderr under `Stop`, but the failed report
does not capture Git's exit status. Child clones now minimize informational
output with `--quiet`, suppress native stderr under a scoped `Continue`
preference, restore the prior preference, and explicitly reject a nonzero or
missing native exit status. A classic Windows PowerShell regression exercises
real stderr-emitting children exiting zero and seven.

The first native-stderr CI regression at head
`0a9e057fc07020e1094d485a9068f6ae291e1d5f`, run
[38203257627](https://github.com/qwts/agent-comms/actions/runs/38203257627),
failed on its exit-zero case. The retained Windows job log has SHA256
`69c48e972f2b40853c703531a1e1821fb0c2a73afed9a370e38404dd887c2ee4`.
The initial wrapper locally shadowed `LASTEXITCODE`, while PowerShell's native
processor updates the global automatic variable in the reviewed official
PowerShell source. The correction explicitly reads/resets that global exit status,
restores the caller's prior value and keeps missing/nonzero rejection.
The regression now reports only numeric/unavailable exit status on failure
and requires the failing native child to return exactly seven. This CI failure
ran no production fixture or preflight.

Corrected CI [38203699069](https://github.com/qwts/agent-comms/actions/runs/38203699069)
at `6fef9afd8093776be5ffd445c64e86fd58a5fb69` passed the real classic PowerShell
stderr/exit-zero and stderr/exit-seven regression, including restored caller
state. This confirms the corrected wrapper behavior without proving the
unknown Git exit status from the third preflight.

The fourth preflight
[38203801183](https://github.com/qwts/agent-comms/actions/runs/38203801183), at
the same head, reached archive creation and the paused fixture. Its
[failure record](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38203801183/failure.json)
reports `paused-fixture-startup` / `control-deadline`, followed by
`job-exit-unconfirmed` cleanup and `scratch-retained`. No production import or
offered workload ran. SHA256 values of the retained original records are:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38203801183/acceptance.json):
  `aae8bdc715b1ab3588d699fbef43c7150a2bf0f7320e2eef31a1976c845b6038`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38203801183/capacity.json):
  `127eb4d9c174a20194d92c29bac5c6383246562bc87e675ae17c792ec265b3fd`.
- Failure: `b28557111b92a6f8eae6620a005b3469ead2a8bb1f4d96c3d6a54e6967214727`.
- Full log: `40b33e1a65b65f8ce5599f5572c0215e85d05b24e113b12e3ee9e2a936c90fd2`.

The acceptance report nevertheless records bootstrap `removed=true` with no
cleanup errors. The bootstrap removed the profile/account despite uncertain
tool cleanup, so the tool's scratch-retained report does **not** establish
retention beyond that removal. The correction conservatively propagates a
nested failure, missing/invalid child evidence or incomplete typed disposal
receipts before profile/account/stage deletion. A completed unqualified
capacity stage can clean normally only when every owned terminal, job-empty,
scratch and applicable natural-exit receipt is confirmed.
Every launched capacity child requires these receipts, including exit zero;
a successful status without run receipts cannot authorize deletion.

Attach diagnosis now uses a fixed supervisor ready handshake and phase codes,
with startup plus attach sharing the original fifteen-second budget. A native
CI test exercises live duplex stdin/stdout control without a workload. These
changes do not attribute the timeout to a cause or widen the deadline.

The fifth preflight
[38204709268](https://github.com/qwts/agent-comms/actions/runs/38204709268), at
head `f23f67a7870283e57b5be79603f9a3c0e14b1075`, failed before supervisor
readiness (`supervisor-startup` / `control-deadline`), with two
`job-exit-unconfirmed` cleanup records. The guard correctly recorded
`removed=false`, `capacity-tool-cleanup-unconfirmed` and `test-profile-cleanup`.
No production import or offered workload ran. Original hashes:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38204709268/acceptance.json):
  `7f6903c8efd7095eb342d5130a94ba141665cc683043255217fac87800300f0f`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38204709268/capacity.json):
  `b9057eed366a718a121a0820dc91ca07eab2b29d9dc84dc832b72257e8ae5726`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38204709268/failure.json):
  `20b9269a671f3285234427a31528c726a3ab014bc90431526bd4eb8b204f932d`.
- Full log: `e55d5d4307a8c14088363e098b3b0eabe4c426df937f38174615a64384bb438d`.

Native CI had used an inherited environment; the standard-user supervisor uses
the same whitelist as capacity fixtures, excluding `PSExecutionPolicyPreference`
and `PSModulePath`, with no explicit execution-policy argument. The parent
standard-user shell uses `-ExecutionPolicy Bypass`; this difference is recorded
without changing policy speculatively. The separate `capacity-supervisor`
manual task probes this exact environment/command with no production imports.
It reports fixed script-entry/precompile phases, stdout/stderr encoding
signatures and a capped stderr byte
count, never raw output. Framing and output-bound errors now reject startup and
pending control requests immediately; they cannot masquerade as a readiness
deadline. The fifteen-second startup budget is unchanged.

The first CI run of the probe change,
[38205980317](https://github.com/qwts/agent-comms/actions/runs/38205980317),
failed the native duplex test at `policy-query` before compilation, at head
`1387e781d62806e0e1a28934e2e620dd0af0b171`. Its failed-step log hash is
`6b698fcbd5d3cc7ab8fc87cc75b8e7c596251808b225f51d1f3bfacacfc6a604`.
The optional `Get-ExecutionPolicy` query had become a startup requirement and
is removed; the probe explicitly records `executionPolicyObservation` as
`not-queried`. No execution-policy or process-environment change is made.
The inherited module-path explanation remains unconfirmed. This CI failure
does not explain the earlier standard-user deadline.

The first supervisor-only run
[38206749476](https://github.com/qwts/agent-comms/actions/runs/38206749476),
at `a561e9a4590fd04c1902e62ff8934bbf990b953b`, also reached a startup
`control-deadline`: no observed control marker/encoding, zero stderr bytes,
`productionImported=false`, and `ownedTerminalConfirmed=true`. Its receipt
did not distinguish EOF exit from forced termination. Bootstrap correctly
retained the account/profile (`removed=false`). These are original hashes:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38206749476/acceptance.json):
  `1fad12131e62b54afe78fd122d9edd68429965761540d4c35e3d2535ba3bfa07`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38206749476/capacity/capacity.json):
  `0b9273400e36466bece723e8dbca374de8c0e104ef4523fb79cbd7d497f2ca86`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38206749476/capacity/failure.json):
  `19c4fbb5703f7e3fb25502bcecf760af747a438387bfada0b4e3139845cf9411`.
- Failed-step log: `e249d2f5196f2ae3e29f50cb20dc327bde46ba77fb355b2ab083051aed61bd71`.

The original marker itself called `ConvertTo-Json`, so its absence cannot
establish whether script execution began. Literal .NET writes now precede
all cmdlets and compilation. The next supervisor-only probe compares a bare
literal .NET command with the script under the same environment/policy/stdio,
preserving both outcomes, fifteen-second startup deadlines, owned exit codes,
EOF/forced termination flags, and stdio-close receipts. It creates no fixture
or production workload and leaves the earlier failure cause unresolved.
The second variant is explicitly unrun if either owned terminal or stdio close
is unconfirmed for the first; its receipt cannot turn the overall result into
a pass.
