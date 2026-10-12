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
