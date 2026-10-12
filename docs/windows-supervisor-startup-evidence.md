# Windows supervisor startup evidence

Related to [capacity preflight evidence](windows-connector-capacity-evidence.md)
and [#164](https://github.com/qwts/agent-comms/issues/164), which remains open.
These no-workload diagnostics do not establish production-connector capacity.

The first supervisor-only run
[38206749476](https://github.com/qwts/agent-comms/actions/runs/38206749476),
at `a561e9a4590fd04c1902e62ff8934bbf990b953b`, also reached a startup
`control-deadline`: no observed control marker/encoding, zero stderr bytes,
`productionImported=false`, and `ownedTerminalConfirmed=true`. Its receipt
did not distinguish EOF exit from forced termination. Bootstrap correctly
retained the account/profile (`removed=false`). These are original hashes:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38206749476/acceptance.json):
  `1fad12131e62b54afe78fd122d9edd68429965761540d4c35e3d2535ba3bfa07`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38206749476/capacity/capacity.json):
  `0b9273400e36466bece723e8dbca374de8c0e104ef4523fb79cbd7d497f2ca86`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38206749476/capacity/failure.json):
  `19c4fbb5703f7e3fb25502bcecf760af747a438387bfada0b4e3139845cf9411`.
- Failed-step log: `e249d2f5196f2ae3e29f50cb20dc327bde46ba77fb355b2ab083051aed61bd71`.

The original marker itself called `ConvertTo-Json`, so its absence cannot
establish whether script execution began. Literal .NET writes now precede
all cmdlets and compilation. The second supervisor-only probe compared a bare
literal .NET command with the script under the same environment/policy/stdio,
preserving both outcomes, fifteen-second startup deadlines, owned exit codes,
EOF/forced termination flags, and stdio-close receipts. It creates no fixture
or production workload and leaves the earlier failure cause unresolved.
The second variant is explicitly unrun if either owned terminal or stdio close
is unconfirmed for the first; its receipt cannot turn the overall result into
a pass.

That second run,
[38207686508](https://github.com/qwts/agent-comms/actions/runs/38207686508), at
`97e658ec67c833ee08f3bdec0b19dd666aad72a1`, retained both variant receipts:

- The literal-command control passed in 577 ms, with natural exit zero, no
  EOF or forced termination, and confirmed terminal and stdio close.
- The supervisor script reached `compile-supervisor`, then failed its
  fifteen-second readiness deadline. Its 20,021 ms receipt records EOF,
  forced termination requested, terminal signal `SIGTERM`, and confirmed
  terminal and stdio close. No production code was imported.

Both had zero stderr bytes and ASCII-compatible control encoding. The parent
retained the account/profile (`removed=false`). Original SHA256 values:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38207686508/acceptance.json):
  `fb4e676795584439858ff458cc3d4ffa18eaf463a4d1e05509d5b72eb220ea91`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38207686508/capacity/capacity.json):
  `e3c6364be4c0205dc69ef85ecf68d3c99d0d28e0e4c4639c2e79b6185c9bef29`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38207686508/capacity/failure.json):
  `338d3063d2aa1109a951097ff3d8380e07f3611e9d523d61dac48f32ea8c732d`.
- Failed-step log: `02927e5444e6b285f9654b752bbb6434e56910cd1e922ca5c53cdac0a984fce6`.

This isolates a working bare-shell startup under the actual sanitized
environment. It does not establish that `Add-Type` hung: compilation,
`Out-Null` and the ready reply's `ConvertTo-Json` occurred between observed
markers. The next no-workload comparison uses a JSON-only command and the
supervisor with literal markers after the compile pipeline, before ready
serialization and after it. It preserves the same environment, policy,
startup deadline, total process budget and cleanup guard. Neither variant
changes production connector behavior or establishes capacity qualification.
