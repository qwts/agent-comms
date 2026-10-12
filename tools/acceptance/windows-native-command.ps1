# Classic PowerShell may promote even informational native stderr under Stop.
function Invoke-WindowsAcceptanceNative([string]$File, [string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    $nativeExit = $null
    try {
        $ErrorActionPreference = 'Continue'
        $LASTEXITCODE = $null
        & $File @Arguments 2>$null | Out-Null
        $nativeExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($null -eq $nativeExit -or $nativeExit -ne 0) {
        throw [InvalidOperationException]::new('Native acceptance command failed')
    }
}
