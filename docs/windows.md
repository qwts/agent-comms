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
  `\\.\pipe\<serviceLabel>.admin.<SID>`), which Node's `net` serves and
  connects to as it does a socket path. Pipe names are one namespace for the
  machine, so the name proves nothing; the broker proves itself on every
  connection instead. The first frame is the client's
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

Nothing in the suite runs `whoami.exe`, `powershell.exe`, `icacls.exe` or
`schtasks.exe`, and no named pipe is opened: every call goes through an
injected runner with a fake, so `tests/platform-win32.test.mjs` (secret
store, service startup) and `tests/platform-win32-channel.test.mjs` (account
isolation, local channel) run on every platform. The handshake is exercised
with real Ed25519 keys over in-memory streams and a loopback TCP pair.

## Not yet

A Windows machine has not run the broker end to end; the seams are complete
and tested with fakes, and the first real run is the next step.
