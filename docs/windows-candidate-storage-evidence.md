# Fixed-source Windows storage-prefix evidence

This continues the [failed corrected-source startup](windows-candidate-startup-evidence.md)
for [#164](https://github.com/qwts/agent-comms/issues/164), which remains open.
A storage-only pass is not Broker.start, delivery or capacity acceptance.

The reviewed storage diagnostic at signed
`b7bedee52504eda17635cb9627179d65db7cf2de`, tested tree
`b21ca7a4110f3f70121d605ce3ecc10a6bcce38d`, passed
[exact-head/native CI 38235520248](https://github.com/qwts/agent-comms/actions/runs/38235520248).
Local full tests passed 620 total / 608 pass / twelve existing native skips /
zero failures or cancellations. Focused controller/lifecycle/storage/candidate
tests passed 34/34, covering phase order, each failed boundary, registered
cleanup, fresh-state refusal and real correlated maintenance-failure IPC.

The one authorized [candidate-storage run 38235731099](https://github.com/qwts/agent-comms/actions/runs/38235731099)
passed. Under the actual sanitized standard-user environment and private job,
it loaded the same unmodified fixed correction archive, created a real Broker
instance and called actual prepare, EventLog construction, assertLogFile,
empty replay and public maintain with compact enabled. The driver required
readiness and six completed API checks. Fixed phase progress and error
classification contained no raw paths, SIDs, commands, request bodies or
exception text. The production nested subprocess implementations, commands,
environment and timeouts were unchanged.

The exact candidate remains `2d94b16a17f7d0a8625e6151e97fee844232aab1`,
tree `9c1719821d656e17eb04dc477cc9415e4697f12f`, Windows CRLF archive SHA256
`d3465c40e5e11561f22f3aa720f74146aa70b2091dcd09c34c1c4046daea6853`.
All ten reported tool hashes match the exact signed diagnostic after Windows
CRLF conversion; the production archive matches the hardcoded approval before
extraction/import. Node remained the checksum-verified 24.21.0 tuple. Original
reports remain unchanged:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-storage-38235731099/acceptance.json):
  `8ee44787abae22514e90e406c32ab614c9638123e4204d36250d3013f53ddd27`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-storage-38235731099/capacity/capacity.json):
  `9d11e95fc1ae161ddaea3689646a81b019ffb8b32009682e0d4f14c48c110774`.
- [Partial sample](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-storage-38235731099/capacity/partial-run.json):
  `2f1f93a90125123151320471bd5614c48a8874096409f570eed81d2fa41c2755`.
- Full run log: `37540d82b2985c706f70425fa8484f5362b357ce547ac2f302d8b7397cfbd27e`.

The one candidate/storage run reports no requested rates, no stages, zero
delivery checks and zero diagnostic stderr bytes. Natural fixture exit0 was
asserted by the driver. Owned fixture terminal, natural empty job, closed empty
job and tool scratch removal are confirmed; the driver completed the shared
owned-handle terminal/stdio cleanup path. Parent profile/account/stage removal
is confirmed with zero errors. No individual nested-helper terminal observation
is claimed. Its configured subprocess timeout alone is not exit/stdio proof.
Job cumulative CPU and peak committed memory include transient descendants;
sampled WorkingSet is not instantaneous peak RSS. CPU is recorded, not gated.
This is not numeric diagnostic budget, throughput, desktop or host acceptance.

The control deliberately omitted Broker.start, stale probes, listeners, A2A
startup, pairing, delivery and rate offers. It validates the defined fresh
storage prefix in this run and leaves whole corrected startup unaccepted. It
does not locate the earlier startup timeout retroactively, prove that combined
startup fits the existing ninety-second deadline or establish a PowerShell
cause/remedy. The failed startup and every earlier failure remain retained;
no repeated startup, six-case preflight or capacity pilot followed this pass.
