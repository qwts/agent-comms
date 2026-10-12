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

The signed sample head `481acfa94d47018a8f548e5497ae7b019f71350a` passed
[native and overall CI 38221534856](https://github.com/qwts/agent-comms/actions/runs/38221534856),
including the actual paused-fixture sample. The single standard-user
[sample-only run 38221743104](https://github.com/qwts/agent-comms/actions/runs/38221743104)
then failed at `supervisor-only-sample/control-deadline`, last phase
`sample-observer`. Attachment, job PID enumeration, filter construction, CIM
query, fixture verification and workload classification completed. The next
literal marker, `sample-observer-read`, was never reached: this isolates the
existing `Get-Process -Id $PID` interval, not its underlying mechanism. No
production runtime or workload ran. All five reported source hashes match that
signed Windows checkout.

Both owned fixture and supervisor terminal/stdio closures were confirmed after
EOF and forced termination. Elapsed time including cleanup was 11,260ms; stderr
was zero. No empty-job receipt exists. Parent profile/account/stage were retained
with `capacity-tool-cleanup-unconfirmed` and `test-profile-cleanup`. Raw hashes:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/sample-38221743104/acceptance.json):
  `4e622a9438ccfd95a5be79e550b05f4afe031c1a8efc0ac5cd4c00cd9231e6a1`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/sample-38221743104/capacity/capacity.json):
  `92ec6766396f09934a72d07e114b1fb8d90109d9ca7bc4a9753b47a4b060567b`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/sample-38221743104/capacity/failure.json):
  `ede24f5e635cc310d60248e0ee954b3c98d58f744e6de321df2cfd66266bc238`.
- Full run log: `4a27f33e692ca39e2bc25b3e07a97650afc26b20f9d9e1b92f2fdc2607772e46`.

The narrow observer correction obtains a .NET process handle for the current
supervisor directly, reads the same `WorkingSet64` and
`TotalProcessorTime.Ticks` fields, and disposes the handle in `finally` before
reply serialization. Observer accounting stays separate from the unchanged
private-job workload accounting. No additional module import, policy,
environment, identity check, process/memory bound or deadline changes. The
existing native paused-fixture test exercises actual sampling and natural
disposal; the sanitized standard-user path still needs separately reviewed
evidence. No production startup, capacity, or underlying autoload fix is claimed.
All failed reports remain unchanged; no broader run is authorized here.

The corrected signed head `fa11e009bd8963351aeac04e1cf1692306858c4d` passed
[native/overall CI 38222576440](https://github.com/qwts/agent-comms/actions/runs/38222576440).
Its single [standard-user sample control 38222789010](https://github.com/qwts/agent-comms/actions/runs/38222789010)
passed in 1,655ms: actual attachment and `sampleValidated=true`, natural empty
private job, fixture and supervisor natural exit0, and both owned terminal/stdio
closures confirmed. No EOF, forced termination or stderr occurred. No workload
scratch was created. Parent profile/account/stage removal completed with no
errors. All five source hashes match the exact signed Windows checkout.

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/sample-38222789010/acceptance.json):
  `3f31c5193ee66c674b004cdf9c85d4aa56da82263423c4075b0a58059c5311a0`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/sample-38222789010/capacity/capacity.json):
  `665bc69f586eb027fb7f52b405275f353db59cc0d8c14e64d6f2379023f7c7ac`.
- Full run log: `613b372875475343cd0db3b883f9126cd498a01595136fa0666da16311397a80`.

This establishes the corrected observer control for one paused fixture under
the sanitized standard-user environment. It imported no production runtime or
connector, offered no workload and does not qualify Broker startup or numeric
capacity. It avoids the observed cmdlet interval without proving its underlying
mechanism. All earlier failure receipts and cleanup qualifications remain intact;
no broader run follows automatically.

The separate production startup result and next pinned channel discriminant are
recorded in [channel preparation evidence](windows-capacity-channel-evidence.md).
