# CI-only bootstrap. Never run on an owner's computer.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Report,
      [ValidateSet('engine','capacity-preflight','capacity-pilot')][string]$Mode = 'engine')
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:AGENT_COMMS_DISPOSABLE_WINDOWS -ne '1') {
    throw 'Disposable GitHub Windows runner required'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'CI bootstrap requires the disposable runner administrator'
}
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Report = [IO.Path]::GetFullPath($Report)
$runId = [Guid]::NewGuid().ToString('N')
$userName = 'comms' + $runId.Substring(0, 12)
# New-LocalUser limits Description to 48 characters; keep the full run marker.
$description = 'comms-ci ' + $runId
$stage = Join-Path $env:ProgramData ('agent-comms-ci-' + $runId)
$sid = $null
$creationAttempted = $false
$stageCreated = $false
$child = $null
$failure = $null
$exitCode = 1
$cleanupErrors = [Collections.Generic.List[string]]::new()
$gate = 'create-test-account'

function Invoke-Checked([string]$File, [string[]]$Arguments) {
    if ($Mode -eq 'engine') { & $File @Arguments | Out-Null }
    else { & $File @Arguments 2>$null | Out-Null }
    if ($LASTEXITCODE -ne 0) { throw 'CI bootstrap native command failed' }
}

try {
    if (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue) { throw 'Test account name collision' }
    $password = ConvertTo-SecureString ('Aa1!' + [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36))) -AsPlainText -Force
    $creationAttempted = $true
    $user = New-LocalUser -Name $userName -Password $password -UserMayNotChangePassword -Description $description
    $sid = $user.SID.Value
    $credential = [PSCredential]::new(($env:COMPUTERNAME + '\' + $userName), $password)
    $users = Get-LocalGroup -SID 'S-1-5-32-545'
    if (-not (Get-LocalGroupMember -Group $users | Where-Object { $_.SID.Value -eq $sid })) {
        Add-LocalGroupMember -Group $users -Member $user
    }
    if (Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -eq $sid }) { throw 'Test account must not be administrator' }

    $gate = 'prepare-read-only-inputs'
    New-Item -ItemType Directory -Path $stage | Out-Null
    $stageCreated = $true
    Invoke-Checked 'icacls.exe' @($stage, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', "*${sid}:(OI)(CI)RX")
    $git = (Get-Command git.exe).Source
    $entries = @(@{name='candidate';source=$repository})
    if ($Mode -eq 'engine') {
        $entries += @(@{name='bot';source=(Join-Path $repository '.windows-fixtures/agent-bot')},
                      @{name='released';source=(Join-Path $repository '.windows-fixtures/agent-comms')})
    } else {
        $entries += @(@{name='old';source=(Join-Path $repository '.windows-fixtures/observability-old')},
                      @{name='new';source=(Join-Path $repository '.windows-fixtures/observability-new')})
    }
    foreach ($entry in $entries) {
        $source = (Resolve-Path $entry.source).Path
        # Exact-path trust is only for these read-only CI inputs; no global config.
        Invoke-Checked $git @('-c', "safe.directory=$source", 'clone', '--local', '--no-hardlinks', '--no-checkout', $source, (Join-Path $stage ($entry.name + '-source')))
    }
    $nodeDirectory = Split-Path -Parent $env:AGENT_COMMS_ACCEPTANCE_NODE
    Copy-Item -LiteralPath $nodeDirectory -Destination (Join-Path $stage 'node') -Recurse
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-acceptance-child.ps1') -Destination (Join-Path $stage 'child.ps1')
    $results = Join-Path $stage 'results'
    New-Item -ItemType Directory -Path $results | Out-Null
    Invoke-Checked 'icacls.exe' @($results, '/grant:r', "*${sid}:(OI)(CI)M")
    @{sid=$sid;runId=$runId;git=$git;mode=$Mode;nodeArchiveSha256=$env:AGENT_COMMS_NODE_ARCHIVE_SHA256} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'inputs.json') -Encoding utf8

    $gate = 'launch-profile-process'
    # Credential + LoadUserProfile uses CreateProcessWithLogonW(LOGON_WITH_PROFILE).
    # UseNewEnvironment leaves lpEnvironment null on this path, allowing Windows
    # to construct the target user's environment instead of copying the runner's.
    # PowerShell implementation: Process.cs, StartWithCreateProcess, credential
    # branch: https://github.com/PowerShell/PowerShell/blob/v7.4.6/src/Microsoft.PowerShell.Commands.Management/commands/management/Process.cs
    # This is not proof Task Scheduler can use its InteractiveToken: the real
    # unchanged broker task must still launch and answer in the child harness.
    $classic = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $stage 'child.ps1') + '"'
    $child = Start-Process -FilePath $classic -ArgumentList $arguments -Credential $credential -LoadUserProfile -UseNewEnvironment -WorkingDirectory $stage -PassThru
    $password = $null
    $credential = $null
    $gate = 'standard-user-engine-acceptance'
    if (-not $child.WaitForExit(15 * 60 * 1000)) {
        if ($Mode -ne 'engine') {
            # The directly owned Process handle is safe; no descendant PID kill.
            $child.Kill()
            [void]$child.WaitForExit(5000)
        }
        throw 'Standard-user acceptance timed out'
    }
    $child.Refresh()
    if ($null -eq $child.ExitCode) { throw 'Acceptance exit status unavailable' }
    $exitCode = $child.ExitCode
} catch {
    $failure = @{gate=$gate;errorType=$_.Exception.GetType().Name}
} finally {
    # Creation may have succeeded just before a PowerShell failure returned.
    if (-not $sid -and $creationAttempted) {
        $partial = Get-LocalUser -Name $userName -ErrorAction SilentlyContinue
        if ($partial -and $partial.Description -eq $description) { $sid = $partial.SID.Value }
    }
    if ($sid) {
        try {
            foreach ($task in Get-ScheduledTask | Where-Object {
                $_.TaskName -like 'test.agent-comms.*' -and
                ($_.Principal.UserId -eq $sid -or $_.Principal.UserId -eq $userName -or $_.Principal.UserId -eq ($env:COMPUTERNAME + '\' + $userName))
            }) {
                Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue
                Unregister-ScheduledTask -InputObject $task -Confirm:$false
            }
        } catch { $cleanupErrors.Add('task-cleanup') }
        # Only this newly created account can own these processes. Never stop
        # unrelated runner processes by executable name or a shared label.
        try {
            foreach ($process in Get-CimInstance Win32_Process) {
                $owner = $null
                try {
                    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
                    if ($owner.Sid -eq $sid) {
                        if ($Mode -eq 'engine') { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
                        else { $cleanupErrors.Add('capacity-account-process-survived') }
                    }
                } catch {
                    if ($owner -and $owner.Sid -eq $sid -and (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue)) { $cleanupErrors.Add('test-process-cleanup') }
                }
            }
        } catch { $cleanupErrors.Add('test-process-query') }
        try {
            if (Get-ScheduledTask | Where-Object { $_.TaskName -like 'test.agent-comms.*' -and
                ($_.Principal.UserId -eq $sid -or $_.Principal.UserId -eq $userName -or $_.Principal.UserId -eq ($env:COMPUTERNAME + '\' + $userName)) }) {
                $cleanupErrors.Add('test-task-still-present')
            }
        } catch { $cleanupErrors.Add('task-absence-query') }
    }
    $engineReport = if ($Mode -eq 'engine') { Join-Path $stage 'results/acceptance.json' } else { Join-Path $stage 'results/capacity/capacity.json' }
    if ($Mode -ne 'engine') {
        try {
            $capacityArtifacts = Join-Path $stage 'results/capacity'
            if (Test-Path -LiteralPath $capacityArtifacts) {
                $destination = Join-Path (Split-Path -Parent $Report) 'capacity'
                New-Item -ItemType Directory -Path (Split-Path -Parent $Report) -Force | Out-Null
                Copy-Item -LiteralPath $capacityArtifacts -Destination $destination -Recurse
            }
        } catch { $cleanupErrors.Add('capacity-artifact-copy') }
    }
    $childReport = Join-Path $stage 'results/bootstrap.json'
    $reportData = if ($Mode -eq 'engine') { @{engineOnly=$true;cases=@();requiredEngineChecks='failed';completeEmbeddingAcceptance=$false} }
                  else { @{capacityOnly=$true;status='failed';completeEmbeddingAcceptance=$false} }
    try {
        if (Test-Path -LiteralPath $engineReport) { $reportData = Get-Content -LiteralPath $engineReport -Raw | ConvertFrom-Json -AsHashtable }
        if (Test-Path -LiteralPath $childReport) { $reportData.standardUser = Get-Content -LiteralPath $childReport -Raw | ConvertFrom-Json -AsHashtable }
    } catch { $cleanupErrors.Add('report-read') }
    if ($sid) {
        try {
            for ($attempt=0; $attempt -lt 20; $attempt++) {
                if ($Mode -ne 'engine' -and $cleanupErrors.Count -gt 0) { throw 'Capacity cleanup unconfirmed; retain profile scratch' }
                $profile = Get-CimInstance Win32_UserProfile | Where-Object SID -eq $sid
                if (-not $profile -or -not $profile.Loaded) { break }
                Start-Sleep -Milliseconds 250
            }
            if ($profile) {
                if ($profile.Loaded) { throw 'Test profile is still loaded' }
                $profile | Remove-CimInstance
                if (Get-CimInstance Win32_UserProfile | Where-Object SID -eq $sid) { throw 'Test profile still present' }
            }
        } catch { $cleanupErrors.Add('test-profile-cleanup') }
        if ($Mode -eq 'engine' -or $cleanupErrors.Count -eq 0) {
            try { Remove-LocalUser -SID $sid } catch { $cleanupErrors.Add('test-account-cleanup') }
            if (Get-LocalUser -SID $sid -ErrorAction SilentlyContinue) { $cleanupErrors.Add('test-account-still-present') }
        }
    }
    if ($stageCreated -and ($Mode -eq 'engine' -or $cleanupErrors.Count -eq 0)) {
        try { Remove-Item -LiteralPath $stage -Recurse -Force } catch { $cleanupErrors.Add('input-stage-cleanup') }
    }
    if ($failure) { $reportData.environmentFailure = $failure; $exitCode = 1 }
    if ($cleanupErrors.Count -gt 0) { $exitCode = 1 }
    if ($Mode -eq 'engine') {
        if ($reportData.requiredEngineChecks -ne 'passed') { $exitCode = 1 }
        $reportData.bootstrapCleanup = @{accountSid=$sid;errors=@($cleanupErrors.ToArray());removed=($cleanupErrors.Count -eq 0)}
        if ($exitCode -ne 0) { $reportData.requiredEngineChecks = 'failed' }
    } else {
        if ($reportData.status -ne 'passed') { $exitCode = 1 }
        $reportData.bootstrapCleanup = @{errors=@($cleanupErrors.ToArray());removed=($cleanupErrors.Count -eq 0)}
        if ($failure -or $cleanupErrors.Count -gt 0) { $reportData.status = 'failed' }
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Report) -Force | Out-Null
    $reportData | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Report -Encoding utf8
    if ($password) { $password.Dispose() }
    $password = $null
    $credential = $null
    $child = $null
}
exit $exitCode
