# Classic PowerShell may promote even informational native stderr under Stop.
function Invoke-WindowsAcceptanceNative([string]$File, [string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    $previousExitCode = $global:LASTEXITCODE
    $nativeExit = $null
    try {
        $ErrorActionPreference = 'Continue'
        # NativeCommandProcessor updates the global automatic variable. A local
        # LASTEXITCODE would shadow it and falsely report a missing exit status.
        $global:LASTEXITCODE = $null
        & $File @Arguments 2>$null | Out-Null
        $nativeExit = $global:LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
        $global:LASTEXITCODE = $previousExitCode
    }
    if ($null -eq $nativeExit -or $nativeExit -ne 0) {
        $failure = [InvalidOperationException]::new('Native acceptance command failed')
        $failure.Data['nativeExitCode'] = if ($nativeExit -is [int]) { $nativeExit } else { 'unavailable' }
        throw $failure
    }
}
