# Exercise real native stderr in classic Windows PowerShell; no workload/account.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../tools/acceptance/windows-native-command.ps1')
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Classic Windows PowerShell regression required' }
$command = Join-Path $env:SystemRoot 'System32/cmd.exe'
$global:LASTEXITCODE = 23
try {
    Invoke-WindowsAcceptanceNative $command @('/d','/s','/c','echo native-information 1>&2 & exit /b 0')
} catch {
    @{nativeCase='stderr-exit-zero';observedExit=$_.Exception.Data['nativeExitCode'];status='failed'} |
        ConvertTo-Json -Compress | ForEach-Object { [Console]::Out.WriteLine($_) }
    exit 1
}
if ($ErrorActionPreference -ne 'Stop' -or $global:LASTEXITCODE -ne 23) { throw 'Native success did not restore preference and exit state' }
$rejected = $false
try {
    Invoke-WindowsAcceptanceNative $command @('/d','/s','/c','echo native-failure 1>&2 & exit /b 7')
} catch [InvalidOperationException] {
    $observedExit = $_.Exception.Data['nativeExitCode']
    $rejected = $observedExit -is [int] -and $observedExit -eq 7
    @{nativeCase='stderr-exit-seven';observedExit=$observedExit;status=$(if ($rejected) {'passed'} else {'failed'})} |
        ConvertTo-Json -Compress | ForEach-Object { [Console]::Out.WriteLine($_) }
}
if (-not $rejected -or $ErrorActionPreference -ne 'Stop' -or $global:LASTEXITCODE -ne 23) { throw 'Native failure was not retained or caller state restored' }
[Console]::Out.WriteLine('{"classicNativeStderrRegression":"passed","workloadRun":false}')
exit 0
