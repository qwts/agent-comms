# Scratch-only native proof. Never invokes desktop entrypoint or profile bootstrap.
param([ValidateSet('controller','owner')][string]$Mode='controller',
    [Parameter(Mandatory)][ValidateSet('before-resume-parent-loss','nested-parent-loss','nested-terminate','finite-uncertain','cleanup-clock-reuse')][string]$Case,
    [Parameter(Mandatory)][string]$Root,[Parameter(Mandatory)][string]$Node)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public sealed class DesktopProofReadPipe : IDisposable {
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool PeekNamedPipe(IntPtr h,IntPtr b,uint size,IntPtr read,out uint available,IntPtr left);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr h,byte[] b,uint size,out uint read,IntPtr overlapped);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
    IntPtr handle; long consumed; public bool Eof {get;private set;}
    public DesktopProofReadPipe(IntPtr owned) {handle=owned;}
    public bool PollEof() {
        if(Eof) return true;
        uint available,read;
        if(!PeekNamedPipe(handle,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero)) {
            if(Marshal.GetLastWin32Error()!=109) throw new Exception("proof-pipe-query-refused");
            // Broken-pipe state is confirmed by an actual read, not inferred
            // from process death, a close request or an empty available count.
            byte[] last=new byte[1];
            bool ok=ReadFile(handle,last,1,out read,IntPtr.Zero);
            if((ok&&read==0)||(!ok&&Marshal.GetLastWin32Error()==109)) {Eof=true;return true;}
            throw new Exception("proof-eof-refused");
        }
        if(available>0) {
            // Called ONLY after owner+all retained writer processes signaled.
            // No competing owner reader remains to consume between peek/read.
            byte[] bytes=new byte[Math.Min(available,4096u)];
            if(!ReadFile(handle,bytes,(uint)bytes.Length,out read,IntPtr.Zero)||read==0) throw new Exception("proof-pipe-read-refused");
            consumed+=read;if(consumed>1048576) throw new Exception("proof-pipe-bound");
        }
        return false;
    }
    public void Dispose(){if(handle!=IntPtr.Zero){var h=handle;handle=IntPtr.Zero;if(!CloseHandle(h))throw new Exception("proof-pipe-close-refused");}}
}
public sealed class DesktopProofProcess : IDisposable {
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint id);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long creation,out long exit,out long kernel,out long user);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(IntPtr h);
    IntPtr handle;
    public long Creation {get;private set;}
    public DesktopProofProcess(uint pid) : this(pid,false) {}
    public DesktopProofProcess(uint pid,bool duplicateReads) {
        // PROCESS handles only. Never open or duplicate the outer JOB handle.
        handle=OpenProcess(0x101001u|(duplicateReads?0x40u:0u),false,pid);
        if(handle==IntPtr.Zero) throw new Exception("proof-open-refused");
        long c,e,k,u;
        if(!GetProcessTimes(handle,out c,out e,out k,out u)) { Dispose(); throw new Exception("proof-identity-refused"); }
        Creation=c;
    }
    public DesktopProofReadPipe DuplicateRead(long sourceValue) {
        if(sourceValue<=0) throw new Exception("proof-read-handle-refused");
        IntPtr copy;
        // Request GENERIC_READ only, noninheritable, no SAME_ACCESS and no
        // CLOSE_SOURCE. Never duplicate a job or any pipe WRITE handle.
        if(!DuplicateHandle(handle,new IntPtr(sourceValue),GetCurrentProcess(),out copy,0x80000000u,false,0)) throw new Exception("proof-read-duplicate-refused");
        if(GetFileType(copy)!=3) {CloseHandle(copy);throw new Exception("proof-read-type-refused");}
        return new DesktopProofReadPipe(copy);
    }
    public bool Signaled(int ms) {
        if(ms<0||ms>1000) throw new Exception("proof-wait-refused");
        uint result=WaitForSingleObject(handle,(uint)ms);
        if(result==0) return true; if(result==258) return false;
        throw new Exception("proof-wait-refused");
    }
    public void Kill() { if(!TerminateProcess(handle,1)&&!Signaled(0)) throw new Exception("proof-kill-refused"); }
    public void Dispose() { if(handle!=IntPtr.Zero) { var h=handle;handle=IntPtr.Zero;if(!CloseHandle(h)) throw new Exception("proof-close-refused"); } }
}
'@
function Write-Proof($Name,$Value) {
    $bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Compress))
    if($bytes.Length -gt 2048) {throw 'proof-frame-bound'}
    $file=[IO.File]::Open((Join-Path $Root $Name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try {$file.Write($bytes,0,$bytes.Length)} finally {$file.Dispose()}
}
function Read-Proof($Name,$Budget) {
    $clock=[Diagnostics.Stopwatch]::StartNew();$file=Join-Path $Root $Name
    while($clock.ElapsedMilliseconds -lt $Budget) {
        if([IO.File]::Exists($file)) {
            # Writer is test-owned and bounded. Short/incomplete JSON is retried.
            if((Get-Item -LiteralPath $file).Length -gt 2048) {throw 'proof-frame-bound'}
            try {return ([IO.File]::ReadAllText($file)|ConvertFrom-Json)} catch {}
        }
        [Threading.Thread]::Sleep(20)
    }
    throw 'proof-read-deadline'
}
if($Mode -eq 'owner') {
    $child=$null;$outHandle=$null;$errHandle=$null
    try {
        # Compile this EXACT helper algorithm with a compile-time barrier. Normal
        # dot-sourcing has no define and no callback field or runtime selector.
        $source=[IO.File]::ReadAllText((Join-Path $repo 'tools/acceptance/windows-desktop-job.ps1'))
        $start=$source.IndexOf("using System;");$end=$source.LastIndexOf("'@")
        if($start -lt 0 -or $end -le $start) {throw 'proof-source-refused'}
        Add-Type -TypeDefinition ("#define DESKTOP_JOB_PROOF`n"+$source.Substring($start,$end-$start))
        . (Join-Path $repo 'tools/acceptance/windows-desktop-root.ps1')
        # Fresh owner needs Pump without invoking actual profile/root bootstrap.
        Initialize-DesktopRootHandle
        [DesktopOwnedJob]::BeforeResumeProof=[Action[DesktopOwnedJob]] {
            param($owned)
            $identity=[DesktopProofProcess]::new($owned.ProcessId)
            try {Write-Proof 'suspended.json' @{v=1;pid=$owned.ProcessId;creation=$identity.Creation;assigned=$owned.AssignedBeforeResume;active=$owned.ActiveMembers();stdoutRead=$owned.ProofStdoutReadHandle;stderrRead=$owned.ProofStderrReadHandle}}
            finally {$identity.Dispose()}
            if($Case -eq 'before-resume-parent-loss') {
                # Controller kills owner while this suspended child cannot run.
                $pause=[Diagnostics.Stopwatch]::StartNew()
                while($pause.ElapsedMilliseconds -lt 10000) {[Threading.Thread]::Sleep(20)}
                throw 'proof-barrier-expired'
            }
        }
        $clean=@{}
        foreach($key in @('SystemRoot','WINDIR','PATH','COMSPEC','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP')) {
            $value=[Environment]::GetEnvironmentVariable($key);if($null -ne $value){$clean[$key]=$value}
        }
        $clean['TEMP']=$Root;$clean['TMP']=$Root;$clean['DESKTOP_JOB_PROOF_ROOT']=$Root
        $child=[DesktopOwnedJob]::Start($Node,(Join-Path $repo 'tests/fixtures/windows-desktop-job-node.mjs'),$repo,$clean,[uint64]1073741824)
        $frame=$child.WriteFrame("nested`n")
        $out=[IO.File]::Create((Join-Path $Root 'node-stdout.bin'));$outHandle=$out.SafeFileHandle
        $err=[IO.File]::Create((Join-Path $Root 'node-stderr.bin'));$errHandle=$err.SafeFileHandle
        if($Case -ne 'nested-parent-loss') {
            $outCopy=[DesktopRootHandle]::Pump($child.Output,$out);$errCopy=[DesktopRootHandle]::Pump($child.Error,$err)
        }
        # Parent-loss controller is sole reader; no pending owner pump competes
        # with its post-terminal peek/read sequence.
        $null=Read-Proof 'nested.json' 20000
        $null=Read-Proof 'release.json' 15000
        if($Case -in @('finite-uncertain','cleanup-clock-reuse')) {
            . (Join-Path $repo 'tools/acceptance/windows-desktop-cleanup.ps1')
            $pendingOut=[Threading.Tasks.TaskCompletionSource[bool]]::new()
            $pendingErr=[Threading.Tasks.TaskCompletionSource[bool]]::new()
            $clock=[Diagnostics.Stopwatch]::StartNew()
            if($Case -eq 'cleanup-clock-reuse'){[Threading.Thread]::Sleep(9000)}
            $before=$clock.ElapsedMilliseconds
            $result=Complete-DesktopOwnedCleanup -Child $child -Clock $clock -Terminal $false -OuterEmpty $false -StreamsClosed $false -OutCopy $pendingOut.Task -ErrCopy $pendingErr.Task
            $duration=$clock.ElapsedMilliseconds-$before
            if(-not $result.uncertain -or $result.streamsClosed -or -not $result.terminal -or -not $result.outerEmpty -or $pendingOut.Task.IsCompleted -or $pendingErr.Task.IsCompleted){throw 'proof-uncertainty-refused'}
            # Tolerance is test observation only; no runtime timeout is widened.
            if($duration -gt $(if($Case -eq 'cleanup-clock-reuse'){3000}else{12000})){throw 'proof-cleanup-budget-refused'}
            Write-Proof 'result.json' @{v=1;status='cleanup-uncertain';rootRetained=$true;terminal=$result.terminal;membersZero=$result.outerEmpty;streamsEof=$false;unfinishedTasksConsumed=$false;elapsedMs=$duration}
            exit 0
        }
        if($Case -ne 'nested-terminate') {throw 'proof-unexpected-release'}
        # Exercise the same termination primitive, without production timeout overrides.
        $child.Terminate();$clock=[Diagnostics.Stopwatch]::StartNew();$done=$false
        while($clock.ElapsedMilliseconds -lt 10000) {
            if($child.WaitForExit(100) -and $child.ActiveMembers() -eq 0 -and $frame.IsCompleted -and $outCopy.IsCompleted -and $errCopy.IsCompleted) {$done=$true;break}
        }
        if(-not $done) {Write-Proof 'result.json' @{v=1;status='cleanup-uncertain';rootRetained=$true};exit 1}
        $frame.GetAwaiter().GetResult()
        if(-not $outCopy.GetAwaiter().GetResult() -or -not $errCopy.GetAwaiter().GetResult()) {throw 'proof-output-refused'}
        Write-Proof 'result.json' @{v=1;status='terminated';nodeTerminal=$true;streamsEof=$true;membersZero=$true;rootRetained=$true}
        exit 0
    } catch {Write-Proof 'owner-failed.json' @{v=1;status='failed';rootRetained=$true};exit 1}
    finally {
        if($child){try{$child.Terminate()}catch{};try{$child.Dispose()}catch{}}
        if($outHandle){$outHandle.Dispose()};if($errHandle){$errHandle.Dispose()}
    }
}
# Compile the normal helper separately in this controller; the proof-only field
# must not exist in its public API. The owner is a distinct compilation/process.
. (Join-Path $repo 'tools/acceptance/windows-desktop-job.ps1')
if($null -ne [DesktopOwnedJob].GetField('BeforeResumeProof') -or $null -ne [DesktopOwnedJob].GetProperty('ProofStdoutReadHandle') -or $null -ne [DesktopOwnedJob].GetProperty('ProofStderrReadHandle')){throw 'proof-feature-isolation-refused'}
$owner=$null;$ownerHandle=$null;$held=@();$readers=@();$independentEof=$false;$passed=$false
try {
    $shell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    foreach($value in @($PSCommandPath,$Root,$Node)){if($value.Contains('"')){throw 'proof-path-refused'}}
    $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$shell;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.Arguments='-NoLogo -NoProfile -NonInteractive -File "'+$PSCommandPath+'" -Mode owner -Case '+$Case+' -Root "'+$Root+'" -Node "'+$Node+'"'
    $owner=[Diagnostics.Process]::Start($info)
    $ownerHandle=[DesktopProofProcess]::new([uint32]$owner.Id,$true);$held+=,$ownerHandle
    $suspended=Read-Proof 'suspended.json' 30000
    if($suspended.v -ne 1 -or -not $suspended.assigned -or $suspended.active -ne 1){throw 'proof-atomic-membership-refused'}
    $nodeHandle=[DesktopProofProcess]::new([uint32]$suspended.pid);$held+=,$nodeHandle
    if($nodeHandle.Creation -ne $suspended.creation -or $nodeHandle.Signaled(0)){throw 'proof-identity-refused'}
    if($Case -in @('before-resume-parent-loss','nested-parent-loss')) {
        # Owner is still blocked/alive. Retain two READ-only duplicates before
        # inducing death; neither duplication retains a writer or the JOB.
        $readers+=,$ownerHandle.DuplicateRead([long]$suspended.stdoutRead)
        $readers+=,$ownerHandle.DuplicateRead([long]$suspended.stderrRead)
    }
    if($Case -eq 'before-resume-parent-loss') {
        if([IO.File]::Exists((Join-Path $Root 'started.json'))){throw 'proof-premature-work'}
        $ownerHandle.Kill()
    } else {
        $nested=Read-Proof 'nested.json' 30000
        if($nested.v -ne 1 -or -not $nested.attached -or $nested.node -ne $suspended.pid){throw 'proof-nested-refused'}
        foreach($id in @($nested.supervisor,$nested.fixture)) {
            $handle=[DesktopProofProcess]::new([uint32]$id);$held+=,$handle
            # Independently reopen once while blocked and compare native creation
            # identity; retain the FIRST handle through failure and terminal wait.
            $sample=[DesktopProofProcess]::new([uint32]$id)
            try{if($sample.Creation -ne $handle.Creation -or $handle.Signaled(0)){throw 'proof-identity-refused'}}finally{$sample.Dispose()}
        }
        if($Case -eq 'nested-parent-loss'){$ownerHandle.Kill()}
        else {Write-Proof 'release.json' @{v=1}}
    }
    $clock=[Diagnostics.Stopwatch]::StartNew()
    do {
        $all=$true;foreach($handle in $held){if(-not $handle.Signaled(0)){$all=$false}}
        if($all){break};[Threading.Thread]::Sleep(20)
    } while($clock.ElapsedMilliseconds -lt 25000)
    if(-not $all){throw 'proof-terminal-unconfirmed'}
    if($readers.Count -eq 2) {
        $eofClock=[Diagnostics.Stopwatch]::StartNew()
        do {
            $independentEof=$true
            foreach($reader in $readers){if(-not $reader.PollEof()){$independentEof=$false}}
            if($independentEof){break};[Threading.Thread]::Sleep(20)
        } while($eofClock.ElapsedMilliseconds -lt 5000)
        if(-not $independentEof){throw 'proof-independent-eof-unconfirmed'}
    }
    if($Case -eq 'nested-terminate') {
        $result=Read-Proof 'result.json' 1000
        if($result.status -ne 'terminated' -or -not $result.nodeTerminal -or -not $result.streamsEof -or -not $result.membersZero){throw 'proof-terminal-receipt-refused'}
    }
    if($Case -in @('finite-uncertain','cleanup-clock-reuse')) {
        $result=Read-Proof 'result.json' 1000
        if($result.status -ne 'cleanup-uncertain' -or -not $result.rootRetained -or $result.streamsEof -or $result.unfinishedTasksConsumed){throw 'proof-uncertain-receipt-refused'}
    }
    if($Case -eq 'before-resume-parent-loss' -and [IO.File]::Exists((Join-Path $Root 'started.json'))){throw 'proof-premature-work'}
    $passed=$true
    Write-Proof 'controller.json' @{v=1;case=$Case;retainedProcessHandles=$held.Count;allSignaled=$true;jobHandleDuplicated=$false;independentReadHandles=$readers.Count;independentPipeEof=$independentEof;rootRetained=$true;status='passed'}
} catch {Write-Proof 'controller-failed.json' @{v=1;case=$Case;status='failed';rootRetained=$true}}
finally {
    # Only exact owned retained PROCESS handles, never PID-wide or SID-wide cleanup.
    # An error cannot become PASS merely because a kill request was accepted.
    foreach($handle in $held){try{if(-not $handle.Signaled(0)){$handle.Kill()}}catch{}}
    $cleanup=[Diagnostics.Stopwatch]::StartNew()
    foreach($handle in $held){try{while(-not $handle.Signaled(0) -and $cleanup.ElapsedMilliseconds -lt 5000){[Threading.Thread]::Sleep(20)}}catch{};try{$handle.Dispose()}catch{$passed=$false}}
    foreach($reader in $readers){try{$reader.Dispose()}catch{$passed=$false}}
    if($owner -and -not $ownerHandle) {
        # Start returned an exclusively owned Process with its retained native
        # handle, but opening the independent witness failed. Do not orphan it.
        try {if(-not $owner.HasExited){$owner.Kill()};if(-not $owner.WaitForExit(1000)){$passed=$false}} catch {$passed=$false}
    }
    if($owner){$owner.Dispose()}
}
if(-not $passed){exit 1}
