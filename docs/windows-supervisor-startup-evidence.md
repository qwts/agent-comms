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

The third run,
[38209372753](https://github.com/qwts/agent-comms/actions/runs/38209372753), at
`bb4d9e2e03612e4de8b96fbf4c4e33bea92e49af`, failed both controls. JSON-only
reached `serialize-ready` then its readiness deadline (20,037 ms total).
The supervisor reached `compile-supervisor`, with no `supervisor-compiled`
marker before the deadline (20,018 ms total). Both recorded zero stderr bytes,
ASCII-compatible control, EOF and forced `SIGTERM` requested, confirmed owned
terminal and stdio close. The parent retained the account/profile/stage.
No production code was imported. Original SHA256 values:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38209372753/acceptance.json):
  `34dbedb551f1ce09fc97d032a9fedf70759353a2f3cba77fff64c9ea48c4c6e6`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38209372753/capacity/capacity.json):
  `c0ac6fd99d8e6eb307e3f48c8160cd2000f7bd4d3eec4ab40dd04115e65b2929`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38209372753/capacity/failure.json):
  `9abf54f426504a938f67ced46e3283a7e3c894ecc88d2a17e0a08ed34f7d13da`.
- Failed-step log: `f273eddbffa1662558ad79cc1fb01bbd2d5fe33128687edb1794661e954f28f2`.

The JSON-only failure reproduces independently of compilation. Both cmdlets
belong to the built-in Utility module. The fourth comparison below keeps
implicit JSON and explicitly imports only the classic shell's exact Utility
manifest, refusing unexpected home/manifest metadata. Environment, policy,
deadlines and cleanup guard remain unchanged; no production workload runs.

The fourth run,
[38210228385](https://github.com/qwts/agent-comms/actions/runs/38210228385), at
`86209e19e9ddf6fd569f50c5f7100c8dc35294d5`, found both the expected classic
shell home and Utility manifest present. Implicit JSON loading timed out
after `serialize-ready` (20,021 ms total), with EOF/forced `SIGTERM` requested.
Explicit manifest import followed by JSON passed in 326 ms, with natural
exit zero, no EOF/force, and `ready-serialized` observed. Both owned terminals
and stdio closures were confirmed. The parent retained account/profile/stage
because the combined diagnostic failed. Original SHA256 values:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38210228385/acceptance.json):
  `0884faa6864d1426cbf61444c9c99f69db1735fddb55d8b2e4c4b2799a042f11`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38210228385/capacity/capacity.json):
  `eee7fbfd6acba01e4eedeec5161167c4b949d6809d1d6b0758da59996a415963`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38210228385/capacity/failure.json):
  `466ec3bb3c16bb1cf01758b4760a44192cf4a4931b135d5f6cf42a73d70b7498`.
- Failed-step log: `92c32f87d7bee7849f4eb4ed38712b29680bdd61c7f75d6725420d64ecd70dc3`.

Explicit loading avoids the observed implicit-autoload failure in this
environment; the underlying autoload mechanism remains undiagnosed. The
dev-only supervisor now preloads that exact manifest before compilation,
with fixed home/presence refusal and literal import phases. Startup refusals
use literal JSON without attempting the unavailable serializer. The next
diagnostic runs only the full supervisor, with unchanged fifteen-second
readiness and 29-second lifetime bounds; it does not repeat the evidenced
implicit failure. This is observer setup, not a change to either pinned
production connector or runtime. A supervisor pass must precede six-case
preflight; capacity remains unqualified until those actual controls pass.

Native [CI 38210948202](https://github.com/qwts/agent-comms/actions/runs/38210948202)
at `c3521e3861bf29c1d158c8340abb4b5a3560d153` passed all four normal
controls, including the preloaded supervisor's live duplex exchange. Its new
negative-home regression failed before script refusal: changing `SystemRoot`
in the process bootstrap environment caused the owned shell to close in
73 ms. That stimulus did not test the supervisor's refusal path. The failed
step log is retained with SHA256
`102a870fab04764f6459dbd68c6e71a5672414f965583ab42bd98fdaefcc2b7c`.
The corrected regression starts the exact real shell with its unchanged
bootstrap environment, emits a literal bootstrap marker, then changes only
the disposable child's expected-home input immediately before invoking the
actual supervisor script. It still requires the fixed refusal, natural exit
one, zero stderr and confirmed stdio close; it changes no production policy
or environment and does not qualify the standard-user supervisor or workload.

The fifth supervisor-only run,
[38211849893](https://github.com/qwts/agent-comms/actions/runs/38211849893),
at `90eb62aea3cf47d3a8ffff607038b67fdd995dc6`, passed the single full-script
control in 1,001 ms. The expected classic home and manifest were present;
`ready-serialized` was observed, the close request was acknowledged and
the owned child exited naturally with code zero. No EOF or forced termination
was requested; stderr was empty and terminal/stdio closure were confirmed.
No production code, fixture, job or scratch directory was created. The
loaded non-admin profile and account were removed with no bootstrap cleanup
errors. This establishes the sanitized standard-user supervisor control,
not the production connector or six-case preflight. Original CRLF hashes:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38211849893/acceptance.json):
  `71c8c461099d9cfa089e5d81513c1408e8cdb05b0afc6ec6588413f7086efa44`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/supervisor-38211849893/capacity/capacity.json):
  `28dd069e946483d6d70246c290d88ed852de3b86c0e5be1e12ce3963f0028a3d`.
- Full run log: `2c4d7bbbbe094b0c8d73751e08f2d00934ead29e3593debd1de3777b562803a1`.

Recorded source hashes match reviewed source after Windows CRLF checkout.
All earlier failures remain retained. Explicit loading avoids the observed
autoload failure; its underlying mechanism remains undiagnosed. Capacity
remains unqualified.

The subsequent failed preflight and bounded attach-only diagnosis are recorded
in [attach evidence](windows-capacity-attach-evidence.md).
