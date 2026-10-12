# Exercise real native stderr in classic Windows PowerShell; no workload/account.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../tools/acceptance/windows-native-command.ps1')
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Classic Windows PowerShell regression required' }
$command = Join-Path $env:SystemRoot 'System32/cmd.exe'
Invoke-WindowsAcceptanceNative $command @('/d','/s','/c','echo native-information 1>&2 & exit /b 0')
if ($ErrorActionPreference -ne 'Stop') { throw 'Native success did not restore preference' }
$rejected = $false
try {
    Invoke-WindowsAcceptanceNative $command @('/d','/s','/c','echo native-failure 1>&2 & exit /b 7')
} catch [InvalidOperationException] { $rejected = $true }
if (-not $rejected -or $ErrorActionPreference -ne 'Stop') { throw 'Native failure was not retained or preference restored' }
[Console]::Out.WriteLine('{"classicNativeStderrRegression":"passed","workloadRun":false}')
