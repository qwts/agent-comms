# Launched only by windows-acceptance-user.ps1 in its disposable CI account.
$ErrorActionPreference = 'Stop'
$inputs = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'inputs.json') -Raw | ConvertFrom-Json
$report = Join-Path $PSScriptRoot 'results/bootstrap.json'
$gate = 'validate-profile-token'
$result = @{status='failed';interactiveTaskGate='not-reached'}
$exitCode = 1
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -ne $inputs.sid) { throw 'Unexpected CI account SID' }
    if (([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Acceptance must use a standard-user token' }
    if ($identity.Owner.Value -ne $identity.User.Value) { throw 'Test token default owner must be the user SID' }
    $profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if (-not $profile -or -not $local -or $env:USERPROFILE -ne $profile -or $env:LOCALAPPDATA -ne $local) { throw 'Target-user environment/profile mismatch' }
    if ($env:USERNAME -ne $identity.Name.Split('\')[-1]) { throw 'Target-user name mismatch' }
    if (-not (Test-Path -LiteralPath ('Registry::HKEY_USERS\' + $inputs.sid))) { throw 'Target user profile hive is not loaded' }
    if ($inputs.mode -eq 'engine') {
        $result.accountSid = $identity.User.Value
        $result.tokenOwnerSid = $identity.Owner.Value
    }
    $result.administrator = $false
    $result.profileLoaded = $true
    $result.sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $env:PATH = (Split-Path -Parent $inputs.git) + ';' + $env:PATH
    $working = Join-Path $local ('agent-comms-ci-' + $inputs.runId)
    New-Item -ItemType Directory -Path $working | Out-Null
    $gate = 'clone-child-owned-inputs'
    . (Join-Path $PSScriptRoot 'native-command.ps1')
    $names = if ($inputs.mode -eq 'engine') { @('candidate','bot','released') } elseif ($inputs.mode -in @('candidate-startup','candidate-storage','candidate-channel','candidate-compiler','relay-candidate-startup')) { @('candidate','correction') } else { @('candidate','old','new') }
    foreach ($name in $names) {
        $source = Join-Path $PSScriptRoot ($name + '-source')
        Invoke-WindowsAcceptanceNative $inputs.git @('-c', "safe.directory=$source", 'clone', '--quiet', '--local', '--no-hardlinks', $source, (Join-Path $working $name))
    }
    # Pass only the public verified tuple metadata into the clean environment.
    $env:AGENT_COMMS_DISPOSABLE_WINDOWS = '1'
    $env:AGENT_COMMS_NODE_ARCHIVE_SHA256 = $inputs.nodeArchiveSha256
    $candidate = Join-Path $working 'candidate'
    Set-Location -LiteralPath $candidate
    if ($inputs.mode -in @('candidate-startup','candidate-storage','candidate-channel','candidate-compiler','relay-candidate-startup','capacity-supervisor','capacity-attach','capacity-sample','capacity-startup','capacity-custody','capacity-channel','capacity-connector','capacity-preflight','capacity-pilot')) {
        $gate = 'production-connector-capacity'
        $env:AGENT_COMMS_CAPACITY_PROFILE_VERIFIED = '1'
        $arguments = @('tools/acceptance/windows-connector-capacity.mjs', '--old', (Join-Path $working 'old'), '--new', (Join-Path $working 'new'), '--output', (Join-Path $PSScriptRoot 'results/capacity'))
        if ($inputs.mode -in @('candidate-startup','candidate-storage','candidate-channel','candidate-compiler','relay-candidate-startup')) {
            $arguments = @('tools/acceptance/windows-connector-capacity.mjs', '--candidate', (Join-Path $working 'correction'), '--output', (Join-Path $PSScriptRoot 'results/capacity'))
        }
        if ($inputs.mode -eq 'candidate-channel') { $arguments[1] = '--candidate-channel' }
        if ($inputs.mode -eq 'candidate-storage') { $arguments[1] = '--candidate-storage' }
        if ($inputs.mode -eq 'candidate-compiler') { $arguments[1] = '--candidate-compiler' }
        if ($inputs.mode -eq 'relay-candidate-startup') { $arguments[1] = '--relay-candidate' }
        if ($inputs.mode -eq 'capacity-preflight') { $arguments += '--preflight' }
        if ($inputs.mode -eq 'capacity-supervisor') { $arguments += '--supervisor-preflight' }
        if ($inputs.mode -eq 'capacity-attach') { $arguments += '--attach-preflight' }
        if ($inputs.mode -eq 'capacity-sample') { $arguments += '--sample-preflight' }
        if ($inputs.mode -eq 'capacity-startup') { $arguments += '--startup-preflight' }
        if ($inputs.mode -eq 'capacity-custody') { $arguments += '--custody-preflight' }
        if ($inputs.mode -eq 'capacity-channel') { $arguments += '--channel-preflight' }
        if ($inputs.mode -eq 'capacity-connector') { $arguments += '--connector-preflight' }
        & (Join-Path $PSScriptRoot 'node/node.exe') @arguments
        $exitCode = $LASTEXITCODE
        if ($exitCode -eq 0) { $result.status = 'passed' }
    } else {
        $gate = 'production-interactive-task-and-engine'
        & (Join-Path $PSScriptRoot 'node/node.exe') scripts/windows-acceptance.mjs --bot (Join-Path $working 'bot') --released-comms (Join-Path $working 'released') --components tests/fixtures/windows-host-components.json --report (Join-Path $PSScriptRoot 'results/acceptance.json')
        $exitCode = $LASTEXITCODE
        $engine = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'results/acceptance.json') -Raw | ConvertFrom-Json
        $initialTask = $engine.cases | Where-Object name -eq 'real scheduled-task broker install and custom profile namespace'
        $result.interactiveTaskGate = if ($initialTask.status -eq 'passed') { 'passed-production-task' } else { 'failed-environment-or-engine' }
        if ($exitCode -eq 0) { $result.status = 'passed' }
    }
} catch {
    $result.failure = @{gate=$gate;errorType=$_.Exception.GetType().Name}
    $exitCode = 1
} finally {
    $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $report -Encoding utf8
}
exit $exitCode
