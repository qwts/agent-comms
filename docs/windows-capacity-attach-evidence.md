# Windows supervisor attach diagnosis

This continues [supervisor startup evidence](windows-supervisor-startup-evidence.md)
and [capacity preflight history](windows-connector-capacity-evidence.md), related
to [#164](https://github.com/qwts/agent-comms/issues/164), which remains open.
A supervisor control pass does not establish production connector capacity.

The sixth [preflight 38212483791](https://github.com/qwts/agent-comms/actions/runs/38212483791),
at `c549ec18cf6f52dce486e66448c8048dd2d8b8c0`, failed on the first supervisor
attach with `control-deadline`; the last observed marker was `ready-serialized`.
No cases completed and no production workload ran. Cleanup retained two
`job-exit-unconfirmed` failures and scratch. The bootstrap correctly retained
profile/account/stage (`removed=false`) instead of claiming disposal.
Original Windows CRLF reports remain unchanged:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38212483791/acceptance.json):
  `8c6ec673f44b062700178fdddc2d5298efe7035d111edc2baa5fdd4837cf84ce`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38212483791/capacity/capacity.json):
  `e7ecd5b12e01624a5042de42dfc65ea83769c45bdf0bde2cbc8443e3e4ed606b`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38212483791/capacity/failure.json):
  `fd5e5278a4b77a4c98d1ce116bbedf5e7d71de7ab2c99d33ad8736b07b9d574b`.
- Full run log: `aa1ebb97548983ef570ae7f8fb4c7b5f72e66eefd27597ea13f9b599c04251dc`.

The old markers cannot distinguish control reading/parsing, the first CIM
query/module autoload, or private job assignment. `Get-CimInstance` is the
first attach cmdlet outside the already loaded Utility module; CIM autoload
is a lead, not an established cause. No module import, environment, policy,
production code, connector or runtime pin is changed to bypass this failure.

The separate manual `capacity-attach` task starts one real owned paused Node
fixture and the actual supervisor under the same sanitized standard-user
environment. It imports no production runtime and creates no source archive
or credential scratch. Its fifteen-second startup/attach deadline and
29-second owned-lifecycle bound are unchanged. Literal fixed phases bracket
control read/JSON parsing, the first CIM query, identity verification and job
creation/assignment. A .NET-only observation records whether the exact classic
CimCmdlets manifest exists; no paths, PIDs or command lines enter its report.
CIM remains implicitly loaded so the actual failing interval can be observed.

On success, the existing executable/parent/command/creation checks must pass
before job assignment. The paused fixture stops through private IPC without
starting descendants; natural fixture exit, empty job, supervisor close,
natural supervisor exit and both stdio closures are required. On failure,
only direct owned child handles are signalled, terminal/stdio receipts are
bounded, and incomplete cleanup retains the disposable profile/account/stage.
No stale PID kill or production load is used. All earlier failures remain
retained; any subsequent manual dispatch requires reviewed exact-head native
CI and a separate result checkpoint before capacity work resumes.

Native [CI 38213752759](https://github.com/qwts/agent-comms/actions/runs/38213752759),
at `d6a812eb81285e1a7ec3779626be6e1653bde0c9`, passed the existing five
shell/supervisor controls but failed the new real-fixture attach in 853 ms
with `job-supervisor-failed`. The test's default classifier omitted the
existing fixed phase metadata, so this log does not identify the refusal
interval. Its failed-step log SHA256 is
`9d8f0f2fc69224c05151d5bf42a76fb150f7bf73ccb2b8dfa20d1b8fc6497dd7`.
The native test now includes only the controller-validated fixed phase,
encoding and boolean observations in its failure message; no raw child error
or fixture fields are printed. No live attach diagnostic is dispatched while
native CI remains failing. Process identity and lifetime checks are unchanged.

The classified [native CI 38214149682](https://github.com/qwts/agent-comms/actions/runs/38214149682),
at `e4c564222514a4b5d8972a53a18d659d9309c141`, again passed the original
five controls and refused the real attach in 1,749 ms. The fixed state was
`fixture-queried`, ASCII-compatible, with Utility home/manifest and CIM
manifest present. The query returned; this native refusal precedes job
creation, within fixture identity/command/creation/limit validation. It does
not establish the earlier standard-user deadline's cause. Failed-step log:
`4281a965c2b56aee191c12a34715aea3c32b7062bce7de8b37e4d6e8f364dc1c`.
Literal phases now distinguish every existing guard in that interval, without
printing values or exception text. All exact comparisons and the process-time
tolerance remain unchanged; manual attach dispatch is still gated on native CI.

The all-guard [native CI 38214498533](https://github.com/qwts/agent-comms/actions/runs/38214498533),
at `866d493601f4a19eaba6ce0b49a0b7cc2c5776eb`, refused at `verify-job-limit`
in 627 ms. All fixture existence/parent/executable/command/creation guards
passed; job creation had not started. Failed-step log SHA256:
`47177a0bab9f7c11f3fd9dbad85cdb609c152e671ec3396f5fc7e5e83e219b45`.

That guard's first cast used `[ulong]`. Microsoft's
[numeric type documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_numeric_literals)
records that alias was added in PowerShell 6.2; classic 5.1 supports the
underlying `[uint64]` accelerator. The dev-only supervisor replaces every
`[ulong]` cast, including later accounting paths, with the same `System.UInt64`
type via `[uint64]`. The numeric comparisons, memory cap, process checks and
time tolerance remain unchanged. The real classic-shell regression must
confirm the old alias refuses, the supported cast produces `System.UInt64`,
and both memory boundaries pass while adjacent values refuse. The actual
fixture attach regression remains required; native validation is pending.
This corrects a demonstrated classic-shell incompatibility, not the earlier
standard-user attach deadline or production connector behavior.
