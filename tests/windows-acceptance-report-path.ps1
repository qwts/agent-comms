# No accounts, production imports, or workloads: exercise divergent cwd state.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../tools/acceptance/windows-report-path.ps1')
$originalLocation = Get-Location
$originalDirectory = [Environment]::CurrentDirectory
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('comms-report-test-' + [Guid]::NewGuid().ToString('N'))
try {
    $location = Join-Path $scratch 'provider'
    $directory = Join-Path $scratch 'process'
    New-Item -ItemType Directory -Path $location,$directory | Out-Null
    Set-Location -LiteralPath $location
    [Environment]::CurrentDirectory = $directory
    $resolved = Resolve-WindowsAcceptanceReportPath '.windows-results/acceptance.json'
    $expected = [IO.Path]::Combine($location, '.windows-results', 'acceptance.json')
    if ($resolved -ne $expected) { throw 'Report did not follow PowerShell location' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $resolved) | Out-Null
    Set-Content -LiteralPath $resolved -Value '{"status":"test"}'
    if (-not (Test-Path -LiteralPath $expected) -or (Test-Path -LiteralPath (Join-Path $directory '.windows-results/acceptance.json'))) { throw 'Report reached the wrong directory' }
    $rejected = $false
    try { [void](Resolve-WindowsAcceptanceReportPath 'HKLM:\SOFTWARE') } catch { $rejected = $true }
    if (-not $rejected) { throw 'Non-filesystem report provider accepted' }
    [Console]::Out.WriteLine('{"reportPathRegression":"passed","workloadRun":false}')
} finally {
    Set-Location -LiteralPath $originalLocation.Path
    [Environment]::CurrentDirectory = $originalDirectory
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
