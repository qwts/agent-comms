# No processes/accounts: uncertainty must survive nested tool/bootstrap reports.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../tools/acceptance/windows-capacity-cleanup.ps1')
foreach ($case in @(
    @{report=@{};exit=1;status='failed';result=1},
    @{report=@{status='passed'};exit=1;status='failed';result=1},
    @{report=@{status='failed'};exit=0;status='failed';result=1},
    @{report=@{status='capacity-not-qualified'};exit=1;status='capacity-not-qualified';result=1},
    @{report=@{status='passed'};exit=0;status='passed';result=0}
)) {
    $result = Set-WindowsCapacityResultStatus $case.report $case.exit
    if ($result -ne $case.result -or $case.report.status -ne $case.status) { throw 'Operation status was lost during successful disposal' }
}
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
    # The exact failed-candidate shape from #268 may dispose its profile only
    # when all owned terminal/stdio/job/scratch receipts are explicit and clean.
    Set-Content -LiteralPath $file -Value '{"v":1,"relayCandidateStartup":true,"runs":[]}'
    $clean = @{
        fixtureOwnedTerminalConfirmed=$true; fixtureStdioClosedConfirmed=$true
        supervisorOwnedTerminalConfirmed=$true; supervisorStdioClosedConfirmed=$true
        jobEmptyConfirmed=$true; scratchRemoved=$true
        forcedSupervisorTerminationRequested=$false; forcedFixtureTerminationRequested=$false
        errors=@()
    }
    $record = @{status='failed';revision='candidate';preflight='candidate-startup';ownedCleanup=$clean}
    $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $failure
    if (-not (Test-WindowsCapacityCleanupConfirmed $scratch)) { throw 'Complete failed-candidate disposal proof rejected' }
    foreach ($name in @('fixtureOwnedTerminalConfirmed','fixtureStdioClosedConfirmed','supervisorOwnedTerminalConfirmed',
            'supervisorStdioClosedConfirmed','jobEmptyConfirmed','scratchRemoved')) {
        foreach ($invalid in @($false,'true',$null)) {
            $clean[$name] = $invalid
            $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $failure
            if (Test-WindowsCapacityCleanupConfirmed $scratch) { throw 'Incomplete or untyped failure cleanup accepted' }
        }
        $clean[$name] = $true
    }
    foreach ($name in @('forcedSupervisorTerminationRequested','forcedFixtureTerminationRequested')) {
        $clean[$name] = $true
        $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $failure
        if (Test-WindowsCapacityCleanupConfirmed $scratch) { throw 'Forced cleanup accepted as clean disposal' }
        $clean[$name] = $false
    }
    $clean.errors = @(@{check='job-exit-unconfirmed'})
    $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $failure
    if (Test-WindowsCapacityCleanupConfirmed $scratch) { throw 'Failure cleanup uncertainty lost' }
    $clean.errors = @()
    foreach ($name in @('cleanup','original')) {
        $record[$name] = @()
        $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $failure
        if (Test-WindowsCapacityCleanupConfirmed $scratch) { throw 'Nested ambiguous cleanup disposition accepted' }
        $record.Remove($name)
    }
    $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $failure
    Set-Content -LiteralPath $file -Value '{"v":1,"relayCandidateStartup":false,"runs":[]}'
    if (Test-WindowsCapacityCleanupConfirmed $scratch) { throw 'Legacy failure admitted by relay-only disposal proof' }
    [Console]::Out.WriteLine('{"capacityCleanupEvidenceRegression":"passed","workloadRun":false}')
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
