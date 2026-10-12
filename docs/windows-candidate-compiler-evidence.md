# Derived Windows compiler control stopped at descendant classification

The single authorized [candidate-compiler run 38253112465](https://github.com/qwts/agent-comms/actions/runs/38253112465)
completed with failure at `2026-10-12T13:05:38Z`. Reviewed [PR #227](https://github.com/qwts/agent-comms/pull/227)
head `4e17e3e20f491c0f10f96989a268bb2a9c03f2c5`, tree
`e412408db43ef0ad1f9e87938e8ceefaf444ea9a`, passed
[exact-head CI 38252515099](https://github.com/qwts/agent-comms/actions/runs/38252515099)
including the complete suite and native Windows checks before dispatch.
PR #227 merged as `3a97429562aa788f2582bde8478e7ed78f2ab96b`.
Related to [#164](https://github.com/qwts/agent-comms/issues/164); acceptance remains open.

The first implicit control failed at `derived-compiler-control` with
`job-supervisor-failed`, supervisor phase `sample-classify` and
`relayCommandConfirmed: false`. No `compilerObservation` was retained.
The explicit, explicit and final implicit controls all remained `not-run`
with reason `prior-cleanup-unconfirmed`. This does not compare implicit and
explicit import behavior or identify PowerShell bootstrap, module loading,
worker compilation or pipe-connection performance. No pipe connection, Broker
startup or workload was attempted by these derived controls. No retry followed.

The nested cleanup receipt confirms both fixture and supervisor owned terminals
and stdio closures, without direct forced termination flags. The top-level
`ownedTerminalConfirmed` and `stdioClosedConfirmed` are both false because they
also require the absent compiler-child observation. `jobEmptyConfirmed`,
`naturalJobEmptyConfirmed`, `descendantsEmptyConfirmed`, `cleanupConfirmed` and
`scratchRemoved` are false, with `job-exit-unconfirmed`. The supervisor's final
handle-close path can request job termination; this is not proof of empty-job
or natural descendant exit. The standard-user bootstrap records a loaded
nonadministrator profile, retains profile/account/stage (`removed: false`) and
reports `capacity-tool-cleanup-unconfirmed` and `test-profile-cleanup`.

The checksum-verified Node version is 24.21.0; its archive SHA256 is
`158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`.
The immutable runtime candidate remains
`cb50469ca0b6757c4ab860de582b9b140fc525a0`, tree
`34011276c3e651e6fd5bf7ba1e7c7f373053249e`, archive SHA256
`85991a457b19c0f7367ca7a1d7fabbeadd7acb3bf15828f37594a5669c185ef6`.
The fixed derived-worker hashes and 15-second work deadline are unchanged.
All five reported tool-source hashes were independently recomputed from the
reviewed head's Git blobs after LF-to-Windows-CRLF conversion and matched.
The [verification receipt](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-compiler-38253112465/verification.json)
records those hashes and the original artifact digest.

Original reports are retained byte-for-byte:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-compiler-38253112465/acceptance.json):
  `3b3254dcd381ece5b6edd22f467bf2a4b6d7789f7b6c8a3746556f0072d551d6`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-compiler-38253112465/capacity/capacity.json):
  `9d0d4dd79010f2f7b0c7d637f443cd7b71f756c2b1a7fa38a4e1ab5168af04d4`.
- Original GitHub artifact `11748153598`, 2,601 bytes, SHA256
  `9f6396e4ebacb9edcfb9c00c9544dcea257e2f0946c9510dc258c58e91b28467`.
- Full raw workflow log SHA256:
  `b5bcee072cd41421db45d210d4933b5d6991174e533cd95d9a0c61dd24eee041`.

## What source inspection establishes

The existing classifier parses captured WMI command lines through
`CommandLineToArgvW`, removes the executable argument, and compares relay argv
exactly against the derived command. The raw derived command contains a
multiline C# here-string and quotes; the production worker instead passes a
fixed base64-decoding expression. Source inspection does not establish that
Windows serialization or WMI changed those arguments in this run.

The same `sample-classify` phase also covers argument parsing, executable and
parent checks, compiler argument/response-file constraints, PID reuse and
history bounds. The supervisor retains a fixed phase and generic failure,
discarding the underlying exception text. These artifacts cannot distinguish
an exact-command mismatch from those other existing refusals. Broadening the
guard or attributing the failure to compilation is unsupported.

A next diagnostic, if separately reviewed and authorized, can retain a closed
classification discriminator for each existing refusal and fixed booleans for
argv count/equality, without retaining commands, paths or exception text.
Existing private-job containment, exact comparisons, compiler ancestry and
cleanup gates should remain unchanged. Native command-serialization coverage
can compare the trusted derived argv with the captured parsed argv using those
same fixed fields. This document authorizes no further hosted dispatch.
