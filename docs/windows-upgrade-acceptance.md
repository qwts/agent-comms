# Native Windows existing-state upgrade acceptance

This opt-in harness addresses the existing-state engine continuity portion of
[#127](https://github.com/qwts/agent-comms/issues/127). It complements the
[fresh engine acceptance](windows-acceptance.md); it does not replace that
report or establish host installer/updater or packaged tuple support.

Run only in a disposable signed-in Windows account with the actual profile
and a verified absolute Node executable from the existing
[component fixture](../tests/fixtures/windows-host-components.json). No
`USERPROFILE` or `LOCALAPPDATA` override is needed or supported. Source
checkouts must be clean, including untracked files.

```powershell
$env:AGENT_COMMS_DISPOSABLE_WINDOWS = '1'
$env:AGENT_COMMS_NODE_ARCHIVE_SHA256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
& $verifiedNode scripts/windows-upgrade-acceptance.mjs `
  --historical-comms $comms0316 --current-comms $comms041 `
  --bot $bot01062 --components tests/fixtures/windows-host-components.json `
  --report $absoluteReportOutsideRuntime
```

The archive hash variable is evidence of the operator's actual archive
verification, not a substitute for verifying the downloaded ZIP. The harness
checks Node 24.21.0 and records the executable hash. Historical comms and bot
must match the component fixture's full commits. The upgrade target is the
released v0.4.1 commit `0ff470bd92f67b205eb1f5e121416960e7317420`.
These are acceptance inputs, not a new host release manifest.

The harness performs the following operations against newly generated state:

1. Start the actual v0.3.16 CLI broker as an owned foreground child in a unique
   namespace. Pair and approve an account, native DPAPI principal and normal
   bot daemon credential; join signed synthetic souls. Seed unread and
   acknowledged mail, a principal inbox reply, and a protected retry outcome.
2. Stop only the owned child handle and verify endpoint closure. Install the
   released v0.4.1 scheduled broker against the same namespace. Verify broker
   pin and credential hashes, approved pairings, original mail/envelope,
   acknowledgement, principal inbox, original retry result and conflicting
   retry refusal. Require the migrated version 3 checkpoint. Earlier recorded candidate evidence
   used version 2; it does not establish the new checkpoint acceptance.
3. Stop and reinstall the current task, then repeat those continuity checks.
4. Stop the task and copy its disposable state. Append one complete unknown
   future record to the copy; require a specific refusal and unchanged copied
   log bytes. Reopen the original with the compatible current task and repeat
   the continuity checks. No historical reader opens upgraded state.

Historical shutdown uses the tracked child handle; on Windows this terminates
that foreground process. The harness therefore also exercises recovery after
that process termination. It never installs the historical scheduled launcher
and does not claim conversion of an existing historical task.

The JSON report contains exact source, Node, platform and log hashes, hashed
credential artifacts and fixed failure stages. It does not contain credentials
or raw process output. Cleanup targets only the owned child and UUID task,
requires the specific missing-task response, verifies endpoint closure, and
removes its directories on success. Failures retain the disposable runtime for
local diagnosis; it contains credentials and must not be published. The report
must be outside that directory. An access-denied or unknown Scheduler error
fails cleanup rather than being treated as task absence.

This does not prove host upgrade policy, rollback, logoff/logon, GUI lifetime,
owner-decision custody, or native daemon launch-progress/results. Those remain
separate obligations. Existing policy and platform refusal behavior is unchanged.
