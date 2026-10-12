# Native exit status alone cannot authorize deletion of capacity child state.
function Test-WindowsCapacityCleanupConfirmed([string]$Directory) {
    try {
        if (Test-Path -LiteralPath (Join-Path $Directory 'failure.json')) { return $false }
        $file = Get-Item -LiteralPath (Join-Path $Directory 'capacity.json') -ErrorAction Stop
        if ($file.Length -gt 8388608) { return $false }
        $evidence = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -ErrorAction Stop
        if ($evidence.status -notin @('passed','capacity-not-qualified')) { return $false }
        $runs = @($evidence.runs)
        if ($runs.Count -lt 1 -or $runs.Count -gt 6) { return $false }
        foreach ($run in $runs) {
            foreach ($receipt in @($run.ownedTerminalConfirmed,$run.cleanup.jobEmptyConfirmed,$run.cleanup.scratchRemoved)) {
                if ($receipt -isnot [bool] -or -not $receipt) { return $false }
            }
            if ($run.preflight -ne 'forced' -and ($run.cleanup.naturalJobEmptyConfirmed -isnot [bool] -or -not $run.cleanup.naturalJobEmptyConfirmed)) { return $false }
        }
        return $true
    } catch { return $false }
}
