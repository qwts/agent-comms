# Fixed-source Windows channel evidence

Related to [#164](https://github.com/qwts/agent-comms/issues/164), which remains
open. This follows the [storage-prefix pass](windows-candidate-storage-evidence.md)
and preserves the failed whole-startup result. Channel timing is diagnostic
evidence, not a performance, throughput, desktop or host acceptance claim.

The reviewed tool at signed `a49d124cb6226b34531de1996242731bae9dc53c`, tested
tree `1fc345151bd5156b6da5cbac696f87c2dbf755c7`, passed
[exact-head/native CI 38238158319](https://github.com/qwts/agent-comms/actions/runs/38238158319).
Local full tests passed 627 total / 615 pass / twelve existing native skips /
zero failures or cancellations. Focused tests passed 41/41, covering timing
bounds, original failure retention, private pre-cleanup snapshots and real child
IPC channel refusal with registered cleanup. Docs-gov and Markdown gates passed.

The one authorized [candidate-channel run 38238337043](https://github.com/qwts/agent-comms/actions/runs/38238337043)
failed at `channel-prepare-and-stale-probes` / `control-deadline`. The final
fixture phase was `channel-stale-admin-returned`; the supervisor remained at
`private-job-assigned`. No broker refusal code was received, and runs remained
empty. The parent start request took 90,010ms. Its original failure and cleanup
receipt are retained independently of the bounded child phase timeline:

| Child fixed phase | Relative elapsed ms |
| --- | ---: |
| channel-imports | 0 |
| channel-prepare | 8 |
| channel-prepared | 78,862 |
| channel-stale-main | 78,862 |
| channel-stale-main-returned | 78,867 |
| channel-stale-main-checked | 88,871 |
| channel-stale-admin | 88,871 |
| channel-stale-admin-returned | 88,876 |

Actual prepare completed after 78,854ms inside that call. The main probe
returned a Promise and its await completed after 10,004ms. Admin returned its
Promise with about 1.1 seconds left in the nominal ninety-second window; no
completion or refusal was observed before the deadline. This observed prepare
duration plus two ordinary ten-second connector windows exceeds the diagnostic
budget. This run does not establish an admin stall, isolate an individual
prepare subcall, prove the earlier startup cause or establish whole startup.
Parent and child durations use independent relative monotonic clock origins.

The unchanged correction source is `2d94b16a17f7d0a8625e6151e97fee844232aab1`,
tree `9c1719821d656e17eb04dc477cc9415e4697f12f`, Windows CRLF archive SHA256
`d3465c40e5e11561f22f3aa720f74146aa70b2091dcd09c34c1c4046daea6853`.
All eleven tool hashes match the exact signed source after Windows CRLF
conversion, including the timing module. The production archive matches the
hardcoded approval before extraction/import. Node remains the checksum-verified
24.21.0 tuple. The actual default prepare, main/admin stale APIs, environment,
connector implementation and ten-second connector timeout were unchanged.
No Broker.start, EventLog, replay, maintenance, listeners, delivery or offers ran.

Original reports are retained byte-for-byte:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-channel-38238337043/acceptance.json):
  `4600286b66c39cf460b134126f47e4aed2cf4ef863876c3796feee90e55918b4`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-channel-38238337043/capacity/capacity.json):
  `0ea8c5682d46baaeecc869d9e88404a15076f9c5d4aa6d6252b1c3f42c6fa77f`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-channel-38238337043/capacity/failure.json):
  `f9b3ea97cf8fcee10c4a00d3b4800de40b5246b26d576a8d0c3981621ad707ee`.
- Full run log: `68b24cf0c11ca2d0ff233b7c36f83ac417a263fad26e0947525f7c32436b6f60`.

Both owned terminals and stdio closures, empty private job and tool scratch
removal are confirmed with zero tool cleanup errors. Neither direct forced
termination flag was set. Job disposal can terminate members; natural fixture
exit is not inferred. The bootstrap conservatively retained profile/account/
stage because failure.json exists, reporting capacity-tool-cleanup-unconfirmed
and test-profile-cleanup. Tool cleanup does not turn this failed control into a
pass. All previous failure and pass artifacts remain unchanged.

Exact source inspection shows prepare performs current SID lookup, three
sequential directory custody checks and lock/identity creation. The timeline
does not allocate the 78.854 seconds among those operations, and no production
policy, module, custody check or connector remedy follows from that alone.
The next reviewed correction is a finite candidate-channel-only diagnostic
window with an explicit larger timing cap; other diagnostic budgets and
production behavior remain separate. No retry, startup, six-case preflight or
capacity pilot followed this receipt.


The revised control selects only the trusted candidate-channel profile:
180-second request deadline and 240-second timing reporting cap. Startup/storage
remain ninety/120 seconds; the old/new controls retain their original untimed
ninety-second requests. No arbitrary dispatch pin, IPC cap, environment/policy
change or production timeout adjustment is accepted. Numeric timing beyond the
selected reporting cap remains unavailable rather than clamped, and original
operation failures survive. Larger allowed timing is observational and cannot
turn the retained first failure into a pass or establish performance acceptance.
The revised source requires exact-head/native CI and separate authorization
before one new run; no completion is implied here.
