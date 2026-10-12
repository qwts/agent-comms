# No processes/accounts: uncertainty must survive nested tool/bootstrap reports.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../tools/acceptance/windows-capacity-cleanup.ps1')
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('comms-cleanup-test-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $scratch | Out-Null
    if (Test-WindowsCapacityCleanupConfirmed $scratch) { throw 'Missing child cleanup evidence accepted' }
    $file = Join-Path $scratch 'capacity.json'
    Set-Content -LiteralPath $file -Value '{"status":"passed","runs":[]}'
    if (Test-WindowsCapacityCleanupConfirmed $scratch) { throw 'Successful status without child cleanup receipts accepted' }
    Set-Content -LiteralPath $file -Value '{"status":"capacity-not-qualified","runs":[{"ownedTerminalConfirmed":true,"cleanup":{"jobEmptyConfirmed":true,"scratchRemoved":true,"naturalJobEmptyConfirmed":true}}]}'
    if (-not (Test-WindowsCapacityCleanupConfirmed $scratch)) { throw 'Completed refusal with confirmed disposal rejected' }
    $failure = Join-Path $scratch 'failure.json'
    Set-Content -LiteralPath $failure -Value '{"status":"failed","check":"scratch-retained","cleanup":[{"check":"job-exit-unconfirmed"}],"original":{"check":"control-deadline"}}'
    if (Test-WindowsCapacityCleanupConfirmed $scratch) { throw 'Nested tool cleanup failure lost at bootstrap boundary' }
    Remove-Item -LiteralPath $failure
    Set-Content -LiteralPath $file -Value '{"status":"passed","runs":[{"ownedTerminalConfirmed":true,"cleanup":{"jobEmptyConfirmed":true,"scratchRemoved":false}}]}'
    if (Test-WindowsCapacityCleanupConfirmed $scratch) { throw 'Incomplete scratch disposal accepted' }
    Set-Content -LiteralPath $file -Value '{"status":"passed","runs":[{"ownedTerminalConfirmed":"true","cleanup":{"jobEmptyConfirmed":true,"scratchRemoved":true,"naturalJobEmptyConfirmed":true}}]}'
    if (Test-WindowsCapacityCleanupConfirmed $scratch) { throw 'Untyped cleanup receipt accepted' }
    Set-Content -LiteralPath $file -Value 'invalid-json'
    if (Test-WindowsCapacityCleanupConfirmed $scratch) { throw 'Invalid cleanup evidence accepted' }
    [Console]::Out.WriteLine('{"capacityCleanupEvidenceRegression":"passed","workloadRun":false}')
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
