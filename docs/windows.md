# Windows

What agent-comms does on `win32`, per the first Windows slice of GeniusBar
[ADR-0046](https://github.com/qwts/GeniusBar/blob/main/docs/decisions/ADR-0046-windows-pipe-transport-dpapi-store-and-logon-tasks.md)
(qwts/GeniusBar#46). [ADR-0059](decisions/ADR-0059-host-apps-embed-agent-comms.md)
puts every platform behaviour behind four seams; two have a Windows branch.

## Implemented

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

## Not yet

Still `platform-not-implemented` on `win32`: the local channel (the per-account
named pipe and the broker's signed handshake, ADR-0046 decision 2) and account
isolation (the SID and `Get-Acl` custody checks, decision 1). Until the local
channel lands, the broker and the principal client cannot connect on Windows;
the two seams above are exercised by the CLI and by
`tests/platform-win32.test.mjs`, which runs on every platform with fake
`powershell.exe` and `schtasks.exe` runners.
