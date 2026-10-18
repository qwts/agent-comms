# Native exit status alone cannot authorize deletion of capacity child state.
function Test-WindowsCapacityCleanupConfirmed([string]$Directory) {
    try {
        $file = Get-Item -LiteralPath (Join-Path $Directory 'capacity.json') -ErrorAction Stop
        if ($file.Length -gt 8388608) { return $false }
        $evidence = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -ErrorAction Stop
        if (Test-Path -LiteralPath (Join-Path $Directory 'failure.json')) {
            # A failed single relay candidate is still failed. Authorize only
            # profile disposal from its separate, complete owned-handle proof.
            # Legacy/multiple-run failures retain their conservative refusal.
            if ($evidence.v -ne 1 -or $evidence.relayCandidateStartup -isnot [bool] -or
                -not $evidence.relayCandidateStartup -or @($evidence.runs).Count -ne 0) { return $false }
            $failureFile = Get-Item -LiteralPath (Join-Path $Directory 'failure.json') -ErrorAction Stop
            if ($failureFile.Length -gt 8388608) { return $false }
            $failure = Get-Content -LiteralPath $failureFile.FullName -Raw | ConvertFrom-Json -ErrorAction Stop
            if ($failure.status -ne 'failed' -or $failure.revision -ne 'candidate' -or
                $failure.preflight -ne 'candidate-startup' -or $failure.PSObject.Properties['cleanup'] -or
                $failure.PSObject.Properties['original']) { return $false }
            $cleanup = $failure.ownedCleanup
            foreach ($name in @('fixtureOwnedTerminalConfirmed','fixtureStdioClosedConfirmed',
                    'supervisorOwnedTerminalConfirmed','supervisorStdioClosedConfirmed','jobEmptyConfirmed','scratchRemoved')) {
                if ($cleanup.$name -isnot [bool] -or -not $cleanup.$name) { return $false }
            }
            foreach ($name in @('forcedSupervisorTerminationRequested','forcedFixtureTerminationRequested')) {
                if ($cleanup.$name -isnot [bool] -or $cleanup.$name) { return $false }
            }
            if ($cleanup.errors -isnot [array] -or $cleanup.errors.Count -ne 0) { return $false }
            return $true
        }
        if ($evidence.status -notin @('passed','capacity-not-qualified')) { return $false }
        $runs = @($evidence.runs)
        if ($runs.Count -lt 1 -or $runs.Count -gt 6) { return $false }
        if ($evidence.compilerOnly -eq $true -and $runs.Count -ne 4) { return $false }
        foreach ($run in $runs) {
            if ($evidence.compilerOnly -eq $true) {
                foreach ($receipt in @($run.stdioClosedConfirmed,$run.descendantsEmptyConfirmed,$run.cleanupConfirmed,$run.relayCommandConfirmed)) {
                    if ($receipt -isnot [bool] -or -not $receipt) { return $false }
                }
                if ($run.status -ne 'passed') { return $false }
            }
            foreach ($receipt in @($run.ownedTerminalConfirmed,$run.cleanup.jobEmptyConfirmed,$run.cleanup.scratchRemoved)) {
                if ($receipt -isnot [bool] -or -not $receipt) { return $false }
            }
            if ($run.preflight -ne 'forced' -and ($run.cleanup.naturalJobEmptyConfirmed -isnot [bool] -or -not $run.cleanup.naturalJobEmptyConfirmed)) { return $false }
        }
        return $true
    } catch { return $false }
}
