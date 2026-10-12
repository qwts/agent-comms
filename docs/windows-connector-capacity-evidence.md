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
failure cause. The bootstrap now resolves FileSystem provider paths and prints
a fixed summary even if report writing fails. Windows CI tests divergent
directories.

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
real native children emitting stderr with exit zero and exit seven, preserving
actual command failures without treating informational stderr as failure.

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
