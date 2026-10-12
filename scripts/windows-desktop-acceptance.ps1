# Explicit owner-desktop diagnostic. No account, task, service or profile writes.
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('candidate-compiler','candidate-startup')][string]$Task)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'tools/acceptance/windows-desktop-root.ps1')
. (Join-Path $repo 'tools/acceptance/windows-desktop-cleanup.ps1')
$identity = Assert-DesktopProfile
$root = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) ('agent-comms-desktop-' + [Guid]::NewGuid().ToString('N'))
$originalTemp = $env:TEMP; $originalTmp = $env:TMP
$held = $null; $child = $null; $exitCode = 1; $terminal = $false; $streamsClosed = $false; $outerEmpty = $false; $outerAssigned = $false; $outerClosed = $false; $cleanupClock = $null; $cleanupUncertain = $false; $phase = 'exclusive-root'
try {
    # New-Item without Force refuses a collision. No caller chooses this root.
    $null = New-Item -ItemType Directory -Path $root
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($identity); $acl.SetAccessRuleProtection($true,$false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule); Set-Acl -LiteralPath $root -AclObject $acl
    $null = New-Item -ItemType Directory -Path (Join-Path $root 'temp')
    $env:TEMP = Join-Path $root 'temp'; $env:TMP = $env:TEMP
    $held = Open-DesktopRootChain $root
    $phase = 'verified-node-archive'
    $pins = Get-Content -LiteralPath (Join-Path $repo 'tests/fixtures/windows-host-components.json') -Raw | ConvertFrom-Json
    $archive = Join-Path $root 'node.zip'
    # Fixed HTTPS origin, 128MiB compressed cap, declared and actual byte checks,
    # exclusive owned output and one 60s cancellation budget. Hash while held.
    $download = [DesktopRootHandle]::DownloadNodeArchive($pins.node.version,$archive)
    # The downloader cancels at 60s. Allow 5s for its actual completion, then
    # retain uncertainty without blocking forever on an unfinished Task.
    if (-not $download.Wait(65000)) { $cleanupUncertain = $true; $phase = 'download-cleanup-uncertain'; throw 'desktop-download-uncertain' }
    $archiveHash = $download.GetAwaiter().GetResult()
    if ($archiveHash -cne $pins.node.sha256.'win-x64') { throw 'desktop-node-refused' }
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $root 'node')
    $node = Join-Path $root ('node/node-v' + $pins.node.version + '-win-x64/node.exe')
    if ((Get-Item -LiteralPath $node -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'desktop-node-refused' }
    $nodeHash = (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant()
    $phase = 'owned-node'
    . (Join-Path $repo 'tools/acceptance/windows-desktop-job.ps1')
    $allowed = @('PATH','SystemRoot','WINDIR','COMSPEC','USERPROFILE','LOCALAPPDATA','APPDATA','USERNAME','USERDOMAIN','USERDNSDOMAIN','PROCESSOR_ARCHITECTURE','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)')
    $clean = @{}
    foreach ($key in $allowed) { $value = [Environment]::GetEnvironmentVariable($key); if ($null -ne $value) { $clean[$key] = $value } }
    $clean['TEMP'] = Join-Path $root 'temp'; $clean['TMP'] = Join-Path $root 'temp'
    $memory = Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 2
    $commitLimit = [uint64][Math]::Min(2147483648,[Math]::Floor(([double]$memory.TotalVisibleMemorySize * 1024) / 4))
    if ($commitLimit -lt 536870912 -or ([double]$memory.FreePhysicalMemory * 1024) -lt ($commitLimit + 536870912)) { throw 'desktop-memory-refused' }
    # PROC_THREAD_ATTRIBUTE_JOB_LIST places the suspended process in the outer
    # job atomically at creation. Only stdio handles are inherited. No fallback.
    $phase = 'outer-start'
    $child = [DesktopOwnedJob]::Start($node,(Join-Path $repo 'tools/acceptance/windows-connector-capacity.mjs'),$repo,$clean,$commitLimit)
    $phase = 'outer-started'
    $outerAssigned = $child.AssignedBeforeResume
    if (-not $outerAssigned) { throw 'desktop-job-refused' }
    $frame = @{v=1;task=$Task;root=$root;parentPid=$PID;nodeArchiveSha256=$archiveHash;nodeExecutableSha256=$nodeHash} | ConvertTo-Json -Compress
    $frameWrite = $child.WriteFrame($frame)
    # Copy bounded public streams concurrently; raw child errors never reach console.
    # The runner's finite own-data output is capped by this independent wrapper.
    $out = [IO.File]::Create((Join-Path $root 'stdout.bin')); $outHandle = $out.SafeFileHandle
    $err = [IO.File]::Create((Join-Path $root 'stderr.bin')); $errHandle = $err.SafeFileHandle
    $outCopy = [DesktopRootHandle]::Pump($child.Output,$out)
    $errCopy = [DesktopRootHandle]::Pump($child.Error,$err)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        if (-not $terminal) { $terminal = $child.WaitForExit(250) } else { [Threading.Thread]::Sleep(50) }
        $outerEmpty = $child.ActiveMembers() -eq 0
        $outputRefused = ($outCopy.IsCompleted -and -not $outCopy.GetAwaiter().GetResult()) -or ($errCopy.IsCompleted -and -not $errCopy.GetAwaiter().GetResult())
        if (($outputRefused -or $watch.Elapsed.TotalMinutes -gt 15) -and $phase -ne 'wrapper-watchdog') {
            # Terminate only the outer owned job. Requests and elapsed deadlines
            # never replace actual process-handle, pipe and membership evidence.
            $cleanupClock = [Diagnostics.Stopwatch]::StartNew()
            $child.Terminate(); $phase = 'wrapper-watchdog'
        }
        if ($frameWrite.IsCompleted) { $frameWrite.GetAwaiter().GetResult() }
        if ($terminal -and $outerEmpty -and $frameWrite.IsCompleted -and $outCopy.IsCompleted -and $errCopy.IsCompleted) { break }
        if ($cleanupClock -and $cleanupClock.ElapsedMilliseconds -ge 10000) { $cleanupUncertain = $true; throw 'desktop-cleanup-uncertain' }
    }
    # Watchdog remains active while descendants or inherited pipes outlive Node.
    $outComplete = $outCopy.GetAwaiter().GetResult(); $errComplete = $errCopy.GetAwaiter().GetResult()
    if (-not $outComplete -or -not $errComplete) { throw 'desktop-output-bound' }
    $streamsClosed = $true
    if ($phase -eq 'wrapper-watchdog') { throw 'desktop-terminal-uncertain' }
    $exitCode = $child.ExitCode
    $phase = 'runner-terminal'
} catch {
    # Fixed phase only. No raw exception/credential/path serialization.
    $exitCode = 1
    if ($phase -eq 'outer-start') { $cleanupUncertain = $true }
} finally {
    try {
        if ($child -and (-not $terminal -or -not $outerEmpty -or -not $streamsClosed)) {
            if (-not $cleanupClock) { $cleanupClock = [Diagnostics.Stopwatch]::StartNew() }
            $cleanup = Complete-DesktopOwnedCleanup -Child $child -Clock $cleanupClock -Terminal $terminal -OuterEmpty $outerEmpty -StreamsClosed $streamsClosed -OutCopy $outCopy -ErrCopy $errCopy
            $terminal = $cleanup.terminal; $outerEmpty = $cleanup.outerEmpty; $streamsClosed = $cleanup.streamsClosed
            if ($cleanup.uncertain) { $cleanupUncertain = $true }
        }
    } catch {
        $cleanupUncertain = $true; $exitCode = 1
    } finally {
        try {
            # Request every handle close; never dispose/flush an unfinished pump's
            # FileStream or synchronously await it beyond the shared cleanup grace.
            if ($outHandle) { try { $outHandle.Dispose() } catch { $cleanupUncertain = $true; $exitCode = 1 } }
            if ($errHandle) { try { $errHandle.Dispose() } catch { $cleanupUncertain = $true; $exitCode = 1 } }
            if ($child) {
                try { $child.Dispose(); $outerClosed = $true } catch { $cleanupUncertain = $true; $exitCode = 1 }
                $child = $null
            }
            if ($cleanupUncertain -or -not $terminal -or -not $streamsClosed -or -not $outerEmpty -or -not $outerClosed) { $exitCode = 1 }
            if ($cleanupUncertain) { $phase = 'cleanup-uncertain' }
            # Write ONLY while verified ancestry handles remain held. This is a
            # pre-close checkpoint, never final success. Actual wrapper exit0 is
            # also required after every held close and environment restoration.
            if ($held) {
                try {
                    @{v=1;executionKind='desktop-current-user';task=$Task;phase=$phase;ownedNodeTerminalConfirmed=$terminal;ownedStreamsClosedConfirmed=$streamsClosed;outerJobAssignedBeforeResume=$outerAssigned;outerJobEmptyConfirmed=$outerEmpty;outerJobHandleClosedConfirmed=$outerClosed;cleanupUncertain=$cleanupUncertain;rootRetained=$true;finalOutcomeRequiresProcessExit=$true;status=$(if ($exitCode -eq 0) {'awaiting-final-cleanup'} else {'failed'})} |
                        ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $root 'desktop.json') -Encoding UTF8
                } catch {
                    $cleanupUncertain = $true; $exitCode = 1
                }
            }
        } finally {
            try {
                # Evidence root intentionally retained. Attempt every held close,
                # including after checkpoint IO failure. Never rewrite by path
                # after releasing ancestry or imply that an old checkpoint passed.
                if ($held) {
                    foreach ($handle in $held) {
                        try { $handle.Dispose() } catch { $cleanupUncertain = $true; $exitCode = 1 }
                    }
                }
            } finally {
                # Restore both process-local values even if IO/close failed.
                try { $env:TEMP = $originalTemp } catch { $cleanupUncertain = $true; $exitCode = 1 }
                try { $env:TMP = $originalTmp } catch { $cleanupUncertain = $true; $exitCode = 1 }
            }
        }
    }
}
exit $exitCode
