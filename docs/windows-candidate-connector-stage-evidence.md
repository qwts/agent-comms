# Fixed connector-stage candidate still refuses at pairing

The one authorized [candidate-startup run 38246652366](https://github.com/qwts/agent-comms/actions/runs/38246652366)
failed at signed tool `a618508ab4c4d7185b198c89b1befce513a66b8e`, after
[exact-head/native CI 38246424312](https://github.com/qwts/agent-comms/actions/runs/38246424312)
passed. This uses the [explicit reviewed source refresh](windows-candidate-stage-refresh.md)
and unchanged trusted 360-second request/420-second reporting profile.
Related to [#164](https://github.com/qwts/agent-comms/issues/164); the issue remains open.

The retained failure is `production-startup` / `operation-failed`, fixed public
code `broker-unreachable`, local `windowsPipeStage: startup-timeout`, fixture
phase `fixture-pair` and supervisor phase `private-job-assigned`.
No completed run, approval, joins, delivery or offered-rate stages are reported.
The original bounded child timeline is:

| Fixed phase | Child elapsed milliseconds |
| --- | ---: |
| fixture-imports | 0 |
| fixture-broker-start | 72 |
| fixture-pair | 143904 |

Actual pinned Broker.start returned after 143.832 seconds between two child
markers. The parent request lasted 176.967 seconds, within its unchanged
360-second watchdog. Parent and child timing origins are independent; subtracting
them does not produce an exact pair or connector duration. Pair performs
synchronous account/custody and proof work before opening the connector.

The existing connector's outer ten-second timer produced `startup-timeout`
before a recognized `CONNECTED` or `REFUSED` status, local process/stream error
or premature-close outcome settled the connection. Its PowerShell worker runs
implicit Utility-module `Add-Type` before .NET `NamedPipeClientStream.Connect(10000)`.
The stage does not distinguish shell bootstrap, module loading, compilation or
the inner pipe connection window. Prior explicit Utility-import supervisor
controls motivate investigation but do not establish this connector's cause.
No production timeout, environment, policy, authentication or connector was
changed, and no unchanged retry followed.

All twelve reported source hashes match the exact signed diagnostic source
after Windows CRLF conversion, including the shared own-data stage projector.
The exact candidate remains signed runtime
`cb50469ca0b6757c4ab860de582b9b140fc525a0`, tree
`34011276c3e651e6fd5bf7ba1e7c7f373053249e`, archive SHA256
`85991a457b19c0f7367ca7a1d7fabbeadd7acb3bf15828f37594a5669c185ef6`.
The checksum-verified Node 24.21.0 tuple, exact closed timing profile, phase
schema/order and private-job/process/memory guards also match.

Both owned child terminals and stdio closures, empty job and tool scratch
removal are confirmed, with zero tool cleanup errors and no direct forced
termination flags. Private-job disposal can terminate members; these receipts
do not establish natural fixture exit. The bootstrap conservatively retained
profile/account/stage (`removed: false`) with
`capacity-tool-cleanup-unconfirmed` and `test-profile-cleanup`, separate from the
confirmed tool cleanup receipt. Earlier raw failures and passes remain unchanged.

Original reports are retained byte-for-byte:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-startup-38246652366/acceptance.json):
  `a5faeb43addc5edda9a91496ee1d8b3447ecef224d0d8af353843ff3228388d9`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-startup-38246652366/capacity/capacity.json):
  `a3d129a1b433547ecc51cb6bc77b9644f2fbe89a0af3d0a20b5b0f9f8762d527`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-startup-38246652366/capacity/failure.json):
  `6d55e2eb8b42b31b621ea32ab5fe2801aec958a93937cc657e72b96adb929a32`.
- Full log SHA256: `79eea1c7e7cb078194a9d432e43dc2b9f57d1b6d4a6821bd6486b544452c55e7`.

This is failed startup-plus-delivery acceptance with a newly retained existing
local stage, not capacity, desktop or installed host acceptance. No successful
preflight or comparable instrumentation-only baseline follows. Remaining
instrumentation/health taxonomy, optional offline/opt-out export, authorized
host consumption, inspectable local export and cross-process continuity retain
their separate implementation and acceptance requirements.
