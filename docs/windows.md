# Windows

What agent-comms does on `win32`, per GeniusBar
[ADR-0046](https://github.com/qwts/GeniusBar/blob/main/docs/decisions/ADR-0046-windows-pipe-transport-dpapi-store-and-logon-tasks.md)
(qwts/GeniusBar#46). [ADR-0059](decisions/ADR-0059-host-apps-embed-agent-comms.md)
puts every platform behaviour behind four seams; each has a Windows branch,
and only one-account mode: `persona-accounts` (groups, `--group`) is
`platform-not-implemented` on `win32` in every seam.

## Implemented

- **Account isolation.** The identity is the account's SID, read once per
  process from `whoami /user /fo csv`, in place of a uid: it is what a
  pairing record pins as `brokerUid`, and an account name resolves to its
  SID through .NET's `NTAccount`. Custody is ownership read through
  `Get-Acl` in `powershell.exe -NoProfile -NonInteractive -Command -`, the
  script on stdin and the answer parsed against a fixed grammar (owner SID,
  directory or file, reparse point or not): a state directory, the client
  directory, the credential, a binding file and the event log must be real
  and owned by the expected SID. There is no ancestor walk, because the
  profile root (`%LOCALAPPDATA%`) is the boundary, and no modes: the
  profile's own access list is the custody. Credentials and pairing proofs
  are the plain files the macOS branch writes, in the same shape.
- **Local channel.** The broker listens on the named pipe
  `\\.\pipe\<serviceLabel>.<SID>` (the admin channel on
  `\\.\pipe\<serviceLabel>.admin.<SID>`), which Node's `net` serves as it
  does a socket path. The client uses .NET's
  `NamedPipeClientStream` with `TokenImpersonationLevel.Identification` before
  it writes the hello. A pipe server can inspect the connecting account but
  cannot impersonate it at the broader `Impersonation` or `Delegation` level.
  This OS token ceiling is separate from the Ed25519 proof, which still
  authenticates the application peer and gates requests.
  If this connector cannot start or open the pipe, it fails closed and never
  falls back to Node's unrestricted pipe open. Pipe names are one namespace
  for the machine, so the name proves nothing; the broker proves itself on
  every connection instead. The first frame is the client's
  `{ v: 1, hello: <32-byte hex nonce> }`; the broker answers
  `{ v: 1, proof: <base64 Ed25519 signature> }` over
  `agent-comms broker handshake v1\n<pipe name>\n<nonce>\n`, and only
  then does the client send its request, so a credential never reaches a
  pipe whose server failed to prove itself. A signature that does not
  verify, or a credential with no pinned key, is `broker-untrusted`; a
  first frame that is not a hello is refused as `bad-request`. The broker's
  keypair lives in its state directory: `identity.json` holds the public
  key (SPKI, base64) for clients to pin, and `identity.key` the PKCS#8
  private key, its access list reduced to the account alone through
  `icacls /inheritance:r` the moment it is written. The pair is issued once;
  half an identity, or a mismatched pair, stops the broker rather than
  rotating the key. Pairing pins the key from that file, never from the
  wire: `account pair` records `brokerKey` beside `brokerUid`, and
  `principal pair` copies both. Custody before a connection is the pin
  itself: a SID, this account's, in one-account mode, with a broker identity
  to verify against; the directories were checked by the broker at start
  and by the client when its credential was saved. There is no socket file,
  so `socketStat` answers null, nothing is unlinked at start (a live pipe
  still refuses a second broker), and the owner-mode calls are no-ops; a
  group mode is `platform-not-implemented`. The macOS branch keeps its
  ownership checks and gains no handshake; after the handshake the wire is
  the same on both platforms.

  Stale-pipe refusal permits startup; a live connection refuses
  as `broker-running`. Closing before either result is `broker-probe-failed`.
  Cleanup cannot change settled results; late errors remain handled.

  Keep the owned PowerShell relay hidden and non-detached (`detached: false`)
  with piped stdio. `DETACHED_PROCESS` exits 0 without executing the worker
  ([#267](https://github.com/qwts/agent-comms/pull/267)).
  `relay-startup` checks production launch and pipe security;
  `detached-relay-probe` retains the unsupported experiment. Hosted evidence
  grants no owner-desktop or compiler acceptance.

- **Secret store.** The principal is `principal.<credentialName>.dpapi` in
  the client state directory, DPAPI-protected in the `CurrentUser` scope
  through `powershell.exe -NoProfile -NonInteractive -Command -`, with the
  credential hex-encoded inside the script on stdin, never on argv. Only that
  Windows account on that machine decrypts it. Credential Manager is not
  used: its generic credentials roam with a Microsoft account, and a
  principal must not leave the machine. `AGENT_COMMS_NO_KEYCHAIN=1` reads the
  plain `principal.<name>.json` file through the account-isolation seam, as
  on macOS. Errors keep the macOS codes: `keychain-write-failed`,
  `keychain-read-failed`, `credential-invalid`.
- **Service startup.** `agent-comms broker install` registers a per-user
  scheduled task named after the service label from an XML definition in
  `%LOCALAPPDATA%\<label>\<label>.xml` (`schtasks /Create /XML`, then
  `/Run`): at this user's logon, hidden, restarted every minute on failure,
  no time limit, a second start ignored. Registering it needs no
  administrator. Task Scheduler has no output paths, so the task runs the
  broker through `cmd.exe`, which appends stdout and stderr to `broker.log`
  and `broker.err.log` in the host log directory and sets a non-default host
  configuration on the same line. `uninstall` is `/End`, `/Delete` and the
  file removed; `status` reads `schtasks /Query /FO LIST /V`. The seam keeps
  the macOS operation names (`renderPlist`, `parseLaunchctlPrint`, ...) as
  aliases of the Windows ones (`renderTask`, `parseSchtasksQuery`, ...), and
  the install and status results keep their shape, so a caller never
  branches on the platform. Only `--single-account` is supported; `--group`
  is `platform-not-implemented`.

## Tests

The cross-platform Windows fixtures inject account and connection seams, so
`tests/platform-win32.test.mjs` (secret store, service startup) and
`tests/platform-win32-channel.test.mjs` (account isolation, local channel)
run without Windows. The handshake uses real Ed25519 keys over in-memory
streams and a loopback TCP pair. A separate Windows CI probe opens a real
named pipe through the production client connector; its server reads the hello,
calls `ImpersonateNamedPipeClient`, and requires the observed level to be
`Identification`. It also checks that an invalid broker proof withholds queued
request bytes. The probe does not claim a packaged broker or daemon acceptance.

## Live acceptance and remaining limits

A signed-in, non-elevated Windows 11 desktop passed
[11 engine cases](https://github.com/qwts/agent-comms/issues/127#issuecomment-6111342700),
including native broker CLI, DPAPI-loaded principal-client and task lifecycle.
A separate [five-case supervisor run](https://github.com/qwts/agent-comms/issues/127#issuecomment-6112051915)
passed actual daemon startup, wake reporting and broker/task restart with stable
credentials. That run used the production installer and daemon API with an
explicit disposable home and empty config; it did not test CLI default-home
installation. These earlier engine results remain scoped to their recorded candidates.

[Installed host evidence](https://github.com/qwts/agent-comms/issues/127#issuecomment-6114773732)
now records GeniusBar `26e7d8e077c14e1365509e22f4d50cbeabdffb93` with bundled
Node 24.21.0, released comms 0.4.3 and bot 0.10.64: actual GUI message/reply,
API exchange while the window was closed, visible reopened history and
independently healthy services with six unchanged credential/identity files.
The actual default-location R5 inventory passed seven expected locations,
ACL metadata and six marker CRUD/cleanup checks. Recorded ACEs are not proof
of other-account effective access or app-only custody.

First setup timed out at the 15-second broker-readiness check, then verified
broker availability and one retry reached the dashboard. Reopen refreshed
services and replaced PIDs, causing a strict same-PID snapshot to fail;
independent health, credential and history checks passed. These failures remain
recorded rather than relabeled passing checks.

[Host PR #369](https://github.com/true-line/geniusbar/pull/369) merged as
`43d40597ada19bbcab35708db5b29907d0f8ad97`, including the
[host evidence matrix](https://github.com/true-line/geniusbar/blob/43d40597ada19bbcab35708db5b29907d0f8ad97/docs/windows-services.md).
Its four-case adapter run used exact host `e415af1219453c587a9d6fa8bbee459474695f82`;
the installed 26e7 source adds the later CRLF guide-parser correction.

This is qualified selected-candidate evidence, not a published supported host
release or a claim that every harness, logon trigger or signed updater was
exercised. Those host-product limits do not add new #127 acceptance gates.
[#127](https://github.com/qwts/agent-comms/issues/127) retains the original
requirements and evidence reconciliation; #77 separately owns strengthened
principal custody and signed owner decisions.

## Disposable acceptance

[Windows acceptance evidence](windows-acceptance.md) records exact pins, hashes
and CLI/library, DPAPI and task limits. Hosted diagnostics and signed-in desktop
results are distinct; neither establishes complete Windows host support.

The [production-connector capacity pilot](windows-connector-capacity.md) provides
manual hosted standard-user preflight and finite load stages over unchanged
production archives; implementation alone proves no capacity, diagnostic-budget
or desktop acceptance.
The [derived compiler-control failure](windows-candidate-compiler-evidence.md)
retains the first existing-classifier refusal and incomplete cleanup proofs;
remaining controls skipped without establishing a compiler cause or comparison.

The dev-only [desktop candidate](windows-desktop-acceptance.md) and
[native proof tooling](windows-desktop-job-proof.md) preserve production guards;
source and portable tests establish no Windows desktop acceptance.
