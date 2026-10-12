# Windows production startup diagnosis

This continues the [supervisor attachment evidence](windows-capacity-attach-evidence.md)
for [#164](https://github.com/qwts/agent-comms/issues/164), which remains open.
No production capacity is qualified.

The receipt-only signed head `a299e41631f82f6ad58d8f119ea8b4c860b82fcc`
passed [CI 38217162193](https://github.com/qwts/agent-comms/actions/runs/38217162193),
including the native controls. The single authorized [six-case preflight
38217327211](https://github.com/qwts/agent-comms/actions/runs/38217327211)
then failed in the first old-runtime normal case at `production-startup` /
`control-deadline`, with supervisor phase `private-job-assigned`. Real fixture
attachment had completed, but the production startup reply and its first
delivery check did not complete. The startup interval includes imports,
Broker start, pairing, approval, joins and first delivery; this receipt does
not distinguish them. No cases or offered-rate stages completed (`runs=[]`).
The failure JSON has no confirmed job-empty or child terminal/stdio receipts.
The parent conservatively retained profile/account/stage (`removed=false`),
with `capacity-tool-cleanup-unconfirmed` and `test-profile-cleanup`. Disposal
cannot be asserted from these reports. Original CRLF hashes:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38217327211/acceptance.json):
  `41e6edc1826f1630deef155e0950f97ecdfd4630bbe524cbd0cecbb7130aa990`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38217327211/capacity/capacity.json):
  `2e303de33c00cc1616f163e4dbaf1501c4a1cb334a87045738fce7b6b02f98c6`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38217327211/capacity/failure.json):
  `84a10710457821e00caf1de14f894c14362de4e2ff35b3480e6f62ad21fd0cf6`.
- Full run log: `d78a90b99fa3e1e9d04bcde532d53572f8ae5eede13f9bf6c518abbfe106ecc9`.

This failure is later than the retained attach deadline, but it establishes
neither a production connector cause nor capacity qualification. No retry or
pilot followed this result; all prior failures and the separate successful
attach control remain retained.


The next manual `capacity-startup` discriminant runs only the first old-pin
normal startup and existing delivery/disposal checks, without offered-rate
stages. Fixed IPC markers distinguish imports, Broker start, pair, approval,
two joins and send/read/ack/empty-read steps. Only those literal phases enter
the parent report; message bodies, credentials, paths and error strings do not.
The actual production source archives, environment, connector, startup deadline
and owned cleanup limits remain unchanged. It cannot qualify a rate or stand
in for the six preflight cases.

Failure reports retain the original classified boundary alongside explicit
owned cleanup receipts. Cleanup still attempts job disposal, supervisor exit
and fixture exit when the operation fails, and requires both terminal and
stdio closure before scratch removal. A forced terminal after a cleanup
deadline does not erase that deadline failure. Missing empty-job evidence or
uncertain process/stdio state retains scratch. The bootstrap conservatively
retains the disposable profile/account/stage whenever failure.json exists,
even if the tool reports subsequently confirmed owned cleanup.


The startup-only signed head `8742e19d07092701257f97893ef6a5782eca46f8`
passed [native and overall CI 38218784738](https://github.com/qwts/agent-comms/actions/runs/38218784738).
The one authorized [old-pin startup-only run 38218936962](https://github.com/qwts/agent-comms/actions/runs/38218936962)
failed at the same `production-startup` / `control-deadline` boundary, now with
fixed fixture phase `fixture-broker-start`. Production imports completed;
pairing, approval, joins and delivery were not reached. No cases or offered-rate
stages completed. All five reported tool source hashes match that exact signed
source after Windows checkout conversion. Original CRLF reports:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/startup-38218936962/acceptance.json):
  `2b078b9f742b880ffa3b6d61b369203eedcf523a25068a204d167575e6015723`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/startup-38218936962/capacity/capacity.json):
  `1c5755c744df9f53b29adc511ebf309beddf597b1b7013d32985913dcf5f42d6`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/startup-38218936962/capacity/failure.json):
  `8af051590e96735f436cc59cf7d94e81aa3d9bbcf17c50374b056fe6bbff870b`.
- Full run log: `4c2259932ab70304cfc1d69b6be631424c704dd2e00c8b14d47770f55ba56df5`.

The original classified timeout is preserved with revision `old`, normal case
and explicit owned cleanup receipts: empty private job, both children terminal,
both stdio closed, scratch removed and zero cleanup errors. No direct child
kill was needed; private-job disposal can itself terminate its members, so
this does not claim natural fixture exit. The bootstrap intentionally retained
profile/account/stage because failure.json exists. This confirms tool cleanup
without reclassifying the failed production startup as a successful run.

The pinned Broker start first checks account/directory custody with synchronous
whoami and PowerShell Get-Item/Get-Acl calls, then identity protection, event-log
custody and pipe probes. The PowerShell custody calls have no subprocess timeout
and use implicit built-in module loading. These are source-level leads; the
observed phase does not yet identify a particular call or module cause. No
runtime patch, environment change, repeated preflight or pilot followed this
result. All earlier failures remain retained and numeric acceptance stays open.


The proposed manual `capacity-custody` discriminant runs only the old pinned
`createAccountIsolation().currentUid()` and all three `assertOwnedDir` calls
in prepare order (shared, proofs, state), using the same owned private scratch
and production error-code arguments. The pinned `brokerPaths()` chooses those
paths. Fixed phases bracket each actual API call; no account SID or path enters
a phase or report. A single-directory pass cannot stand in for the three checks.
This probe imports no Broker or connector and covers neither identity-key ACLs,
event-log custody nor pipe probes. It cannot establish complete Broker prepare,
startup or capacity. Unit tests verify sequencing/refusal/privacy with stub API
objects; only the reviewed manual Windows probe exercises the actual pinned
Windows implementations under the sanitized standard-user environment.

The fixture remains paused until private-job attachment. The API interval uses
the unchanged ninety-second startup bound and the reviewed owned cleanup path.
No subprocess, custody comparison, module loading, environment, policy or source
archive is replaced or changed. Reports include a custody-helper source hash
and distinct scope. Publication, native CI and a separately authorized single
probe precede any subsequent startup/preflight/capacity work.


[Observer sample evidence](windows-capacity-sample-evidence.md) records the
subsequent custody-ready result and sampling timeout with retained cleanup.


[Corrected-source startup evidence](windows-candidate-startup-evidence.md) records
the separate reviewed correction attempt, which also failed before pairing.
