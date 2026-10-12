# Windows observer sample diagnosis

This continues [production startup evidence](windows-capacity-startup-evidence.md)
for [#164](https://github.com/qwts/agent-comms/issues/164), which remains open.
No capacity or production startup fix is claimed.

The signed custody head `24e7e11e20b0b1f593301e7bdac896d39b216df5` passed
[CI 38220003294](https://github.com/qwts/agent-comms/actions/runs/38220003294).
The one [custody-only run 38220198361](https://github.com/qwts/agent-comms/actions/runs/38220198361)
failed with `control-deadline`, reported stage `custody-api`, fixture phase
`custody-ready` and supervisor phase `control-parsed`. All three directory
checks completed. The reported stage is too broad: the driver leaves it set
while accepting the successful API reply and then sampling the private job.
Source control flow and the later supervisor control marker identify the first
post-startup sample request as the timeout interval, rather than establishing
a custody API failure. The receipt does not isolate CIM enumeration, process
validation or observer accounting within that sample. No Broker/connector or
offered-rate stages ran. All six tool hashes match the signed Windows checkout.

Both children reached confirmed terminal and stdio closure during cleanup;
the supervisor needed owned-handle forced termination. Empty-job confirmation
and scratch removal are false; two `job-exit-unconfirmed` records remain.
Parent profile/account/stage were retained. Original CRLF hashes:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/custody-38220198361/acceptance.json):
  `6d7ba117541891c505357bed0acbefad827ddbd9988a264c0d2d85b94e38f334`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/custody-38220198361/capacity/capacity.json):
  `95335edef56dc2687078c13d738400f8ee6743dcf1c81776d2da6947ee1be267`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/custody-38220198361/capacity/failure.json):
  `db49026975d12b28252a6192a2f6c050f80fd25d95a4069f186f1cf1b4f9da73`.
- Full run log: `2d096fe40759edab6f25f35eecb94928730a4fab28972f012e18d25adebae2a0`.

This result does not qualify the original Broker start or observer accounting.
No retry followed. The next diagnosis needs a distinct process-check stage,
operation-time phase snapshot and literal observer-sample boundaries; it must
preserve the original reports rather than retroactively relabeling their fields.

The next `capacity-sample` control attaches one real owned paused fixture to
the same actual supervisor, then requests one process sample before natural
fixture/job/supervisor disposal. It imports no production runtime or connector
and creates no workload scratch. Sample results require one main process and
zero relay/diagnostic/compiler children, with safe nonnegative integer working
set, CPU, committed-memory and observer fields. This validates the accounting
control, not the hosted capacity or desktop/host memory budgets.

Literal fixed phases bracket PID enumeration, filter creation, CIM query,
returned rows, fixture validation, process classification, observer Get-Process
and reply serialization. No values, paths, PIDs, command lines or exception
strings enter these markers. Existing module imports, environment, guards,
memory/process bounds and deadlines are unchanged: shared fifteen-second
startup/attach, nineteen-second work and twenty-nine-second owned-lifecycle
bounds. Native CI exercises one real sample in the existing paused-fixture
attachment regression before the separately reviewed manual probe.

The driver now labels its first post-startup observer check separately and
snapshots both validated supervisor and fixture phases in the operation catch,
before cleanup can emit later progress. Tests preserve those snapshots through
teardown phase changes and preserve a valid sample acknowledgement followed by
a trailing marker/terminal event. Failure reports retain original classified
boundaries and all cleanup chronology; no unknown empty-job/scratch/profile
state is reclassified as success. The original custody-run fields and bytes
remain unchanged.
