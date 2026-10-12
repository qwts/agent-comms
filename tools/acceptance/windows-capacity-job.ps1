param([switch]$ValidateOnly)
if (-not $ValidateOnly) {
    [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"script-entry"}')
    [Console]::Out.Flush()
}
# Dev-only supervisor for one paused fixture. No runtime or connector changes.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$job = [IntPtr]::Zero
$attached = $false
$fixtureId = 0
$fixtureCreation = $null
$known = @{}
$maximumRows = 128 # private-job membership, including compiler descendants
$phase = 'script-entry'
$utilityLoaded = $false

function Reply($Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
}

try {
    # This dev-only observer must not depend on implicit Utility autoload.
    $phase = 'module-observation'
    $manifest = [IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
    $present = [IO.File]::Exists($manifest)
    $expected = [string]::Equals([IO.Path]::GetFullPath($PSHOME), [IO.Path]::GetFullPath([IO.Path]::Combine([Environment]::GetEnvironmentVariable('SystemRoot'), 'System32\WindowsPowerShell\v1.0')), [StringComparison]::OrdinalIgnoreCase)
    if (-not $ValidateOnly) {
        [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"module-observation","manifestPresent":' + $present.ToString().ToLowerInvariant() + ',"expectedPSHome":' + $expected.ToString().ToLowerInvariant() + '}')
        [Console]::Out.Flush()
    }
    if (-not $present -or -not $expected) { throw 'invalid-built-in-utility' }
    $phase = 'import-utility'
    if (-not $ValidateOnly) {
        [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"import-utility"}')
        [Console]::Out.Flush()
    }
    Import-Module -Name $manifest -ErrorAction Stop
    $utilityLoaded = $true
    if (-not $ValidateOnly) {
        [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"utility-imported"}')
        [Console]::Out.Flush()
    }
    $phase = 'compile-supervisor'
    if (-not $ValidateOnly) {
        [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"compile-supervisor"}')
        [Console]::Out.Flush()
    }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CapacityJob {
    [StructLayout(LayoutKind.Sequential)] struct Basic {
        public long UserTime, KernelTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct Extended {
        public Basic Limits;
        public Io Counters;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint PageFaults, Processes, Active, Terminated;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool belongs);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr data, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static IntPtr Create(ulong bytes) {
        IntPtr handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new Exception();
        Extended limits = new Extended();
        limits.Limits.Flags = 0x2208; // KILL_ON_JOB_CLOSE | JOB_MEMORY | ACTIVE_PROCESS
        limits.Limits.ActiveProcessLimit = 128;
        limits.JobMemory = new UIntPtr(bytes);
        IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Extended)));
        try {
            Marshal.StructureToPtr(limits, data, false);
            if (!SetInformationJobObject(handle, 9, data, (uint)Marshal.SizeOf(typeof(Extended)))) {
                CloseHandle(handle); throw new Exception();
            }
            return handle;
        } finally { Marshal.FreeHGlobal(data); }
    }
    public static void Attach(IntPtr job, int id, long expectedCreation) {
        IntPtr process = OpenProcess(0x1101, false, id); // QUERY_LIMITED | SET_QUOTA | TERMINATE
        if (process == IntPtr.Zero) throw new Exception();
        try {
            long created, exited, kernel, user;
            if (!GetProcessTimes(process, out created, out exited, out kernel, out user) || Math.Abs(DateTime.FromFileTimeUtc(created).Ticks - expectedCreation) > 10) throw new Exception();
            if (!AssignProcessToJobObject(job, process)) throw new Exception();
        }
        finally { CloseHandle(process); }
    }
    public static ulong PeakCommit(IntPtr job) {
        IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Extended)));
        try {
            if (!QueryInformationJobObject(job, 9, data, (uint)Marshal.SizeOf(typeof(Extended)), IntPtr.Zero)) throw new Exception();
            return ((Extended)Marshal.PtrToStructure(data, typeof(Extended))).PeakJobMemory.ToUInt64();
        } finally { Marshal.FreeHGlobal(data); }
    }
    public static void Stop(IntPtr job) { if (!TerminateJobObject(job, 1)) throw new Exception(); }
    public static int[] Pids(IntPtr job) {
        int size = 8 + 128 * IntPtr.Size;
        IntPtr data = Marshal.AllocHGlobal(size);
        try {
            if (!QueryInformationJobObject(job, 3, data, (uint)size, IntPtr.Zero)) throw new Exception();
            int count = Marshal.ReadInt32(data, 4);
            if (count < 0 || count > 128 || Marshal.ReadInt32(data) > 128) throw new Exception();
            int[] ids = new int[count];
            for (int i=0; i<count; i++) ids[i] = checked((int)Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64());
            return ids;
        } finally { Marshal.FreeHGlobal(data); }
    }
    public static bool Belongs(IntPtr job, int id) {
        IntPtr process = OpenProcess(0x1000, false, id);
        if (process == IntPtr.Zero) return false;
        try { bool value; return IsProcessInJob(process, job, out value) && value; }
        finally { CloseHandle(process); }
    }
    public static ulong Cpu100ns(IntPtr job) {
        IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Accounting)));
        try {
            if (!QueryInformationJobObject(job, 1, data, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Exception();
            Accounting value = (Accounting)Marshal.PtrToStructure(data, typeof(Accounting));
            return checked((ulong)(value.User + value.Kernel));
        } finally { Marshal.FreeHGlobal(data); }
    }
    public static string[] Args(string command) {
        int count;
        IntPtr data = CommandLineToArgvW(command, out count);
        if (data == IntPtr.Zero || count < 1 || count > 12) throw new Exception();
        try {
            List<string> args = new List<string>();
            for (int i=1; i<count; i++) args.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(data, i * IntPtr.Size)));
            return args.ToArray();
        } finally { LocalFree(data); }
    }
}
'@ | Out-Null
    $phase = 'supervisor-compiled'
    if (-not $ValidateOnly) {
        [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"supervisor-compiled"}')
        [Console]::Out.Flush()
    }
    if ($ValidateOnly) {
        $job = [CapacityJob]::Create(536870912)
        if (@([CapacityJob]::Pids($job)).Count -ne 0 -or [CapacityJob]::Cpu100ns($job) -ne 0) { throw 'invalid-empty-job' }
        [void][CapacityJob]::PeakCommit($job)
        [void][CapacityJob]::CloseHandle($job); $job=[IntPtr]::Zero
        Reply @{ok=$true;validated=$true;workloadRun=$false}
        return
    }
    $phase = 'serialize-ready'
    [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"serialize-ready"}')
    [Console]::Out.Flush()
    Reply @{id=0;ok=$true;phase='ready'}
    [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"ready-serialized"}')
    [Console]::Out.Flush()
    $phase = 'read-control'
    [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"read-control"}'); [Console]::Out.Flush()
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        $phase = 'control-read'
        [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"control-read"}'); [Console]::Out.Flush()
        if ($line.Length -gt 32768) { throw 'invalid-control-line' }
        $phase = 'parse-control'
        [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"parse-control"}'); [Console]::Out.Flush()
        $inputData = $line | ConvertFrom-Json
        $phase = 'control-parsed'
        [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"control-parsed"}'); [Console]::Out.Flush()
        $requestId = [int]$inputData.id
        if ($inputData.op -eq 'attach' -and -not $attached) {
            $phase = 'verify-fixture'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"verify-fixture"}'); [Console]::Out.Flush()
            $fixtureId = [int]$inputData.pid
            $parentId = [int]$inputData.parentPid
            if ($fixtureId -le 0 -or $parentId -le 0) { throw 'invalid-fixture-id' }
            $nodeExecutable = [string]$inputData.nodeExecutable
            $shellExecutable = [string]$inputData.shellExecutable
            $fixtureArgs = @($inputData.fixtureArgs)
            $relayArgs = @($inputData.relayArgs)
            $diagnosticArgs = @($inputData.diagnosticArgs)
            $compilerExecutables = @($inputData.compilerExecutables)
            $compilerTemp = [string]$inputData.compilerTemp
            $phase = 'cim-module-observation'
            $cimManifest = [IO.Path]::Combine($PSHOME, 'Modules\CimCmdlets\CimCmdlets.psd1')
            $cimPresent = [IO.File]::Exists($cimManifest)
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"cim-module-observation","manifestPresent":' + $cimPresent.ToString().ToLowerInvariant() + '}'); [Console]::Out.Flush()
            $cimContained = [IO.Path]::GetFullPath($cimManifest).StartsWith([IO.Path]::GetFullPath($PSHOME).TrimEnd('\') + '\Modules\CimCmdlets\', [StringComparison]::OrdinalIgnoreCase)
            if (-not $expected -or -not $cimPresent -or -not $cimContained) {
                $phase = 'cim-module-refused'
                [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"cim-module-refused"}'); [Console]::Out.Flush()
                throw 'invalid-built-in-cim'
            }
            $phase = 'import-cim'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"import-cim"}'); [Console]::Out.Flush()
            Import-Module -Name $cimManifest -ErrorAction Stop
            $phase = 'cim-imported'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"cim-imported"}'); [Console]::Out.Flush()
            $phase = 'query-fixture'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"query-fixture"}'); [Console]::Out.Flush()
            $main = Get-CimInstance Win32_Process -Filter "ProcessId=$fixtureId" -OperationTimeoutSec 2
            $phase = 'fixture-queried'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"fixture-queried"}'); [Console]::Out.Flush()
            $phase = 'verify-fixture-existence'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"verify-fixture-existence"}'); [Console]::Out.Flush()
            if (-not $main) { throw 'fixture-identity-unconfirmed' }
            $phase = 'verify-fixture-parent'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"verify-fixture-parent"}'); [Console]::Out.Flush()
            if ($main.ParentProcessId -ne $parentId) { throw 'fixture-identity-unconfirmed' }
            $phase = 'verify-fixture-executable'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"verify-fixture-executable"}'); [Console]::Out.Flush()
            if ($main.ExecutablePath -ine $nodeExecutable) { throw 'fixture-identity-unconfirmed' }
            $phase = 'parse-fixture-command'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"parse-fixture-command"}'); [Console]::Out.Flush()
            $actual = [CapacityJob]::Args($main.CommandLine)
            $phase = 'verify-fixture-argument-count'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"verify-fixture-argument-count"}'); [Console]::Out.Flush()
            if ($actual.Count -ne $fixtureArgs.Count) { throw 'fixture-command-unconfirmed' }
            $phase = 'verify-fixture-arguments'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"verify-fixture-arguments"}'); [Console]::Out.Flush()
            for ($i=0; $i -lt $actual.Count; $i++) { if ($actual[$i] -cne $fixtureArgs[$i]) { throw 'fixture-command-unconfirmed' } }
            $phase = 'convert-fixture-creation'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"convert-fixture-creation"}'); [Console]::Out.Flush()
            $fixtureCreation = $main.CreationDate.ToUniversalTime().Ticks.ToString()
            $phase = 'verify-job-limit'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"verify-job-limit"}'); [Console]::Out.Flush()
            $limit = [uint64]$inputData.commitLimitBytes
            if ($limit -lt 536870912 -or $limit -gt 2147483648) { throw 'invalid-memory-limit' }
            $phase = 'create-private-job'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"create-private-job"}'); [Console]::Out.Flush()
            $job = [CapacityJob]::Create($limit)
            $phase = 'assign-private-job'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"assign-private-job"}'); [Console]::Out.Flush()
            [CapacityJob]::Attach($job, $fixtureId, [long]$fixtureCreation)
            $attached = $true
            $phase = 'private-job-assigned'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"private-job-assigned"}'); [Console]::Out.Flush()
            Reply @{id=$requestId;ok=$true;attached=$true;powershellVersion=@($PSVersionTable.PSVersion.Major,$PSVersionTable.PSVersion.Minor,$PSVersionTable.PSVersion.Build)}
        } elseif ($inputData.op -eq 'sample' -and $attached) {
            $phase = 'sample-job'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-job"}'); [Console]::Out.Flush()
            $ids = @([CapacityJob]::Pids($job))
            $phase = 'sample-ids-read'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-ids-read"}'); [Console]::Out.Flush()
            if ($ids.Count -eq 0 -or $ids.Count -gt $maximumRows) { throw 'owned-job-empty-or-overbound' }
            $phase = 'sample-filter'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-filter"}'); [Console]::Out.Flush()
            $filter = ($ids | ForEach-Object { 'ProcessId=' + $_ }) -join ' OR '
            $phase = 'sample-query'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-query"}'); [Console]::Out.Flush()
            $rows = @(Get-CimInstance Win32_Process -Filter $filter -OperationTimeoutSec 2 | Where-Object { [CapacityJob]::Belongs($job, $_.ProcessId) })
            $phase = 'sample-rows'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-rows"}'); [Console]::Out.Flush()
            if ($rows.Count -gt $maximumRows) { throw 'owned-child-bound-exceeded' }
            $phase = 'sample-verify'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-verify"}'); [Console]::Out.Flush()
            $main = $rows | Where-Object ProcessId -eq $fixtureId
            if (-not $main -or $main.ParentProcessId -ne $parentId -or $main.ExecutablePath -ine $nodeExecutable -or $main.CreationDate.ToUniversalTime().Ticks.ToString() -ne $fixtureCreation) { throw 'fixture-lifetime-unconfirmed' }
            $phase = 'sample-classify'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-classify"}'); [Console]::Out.Flush()
            $totals = @{main=@{count=0;workingSetBytes=[uint64]0;cpu100ns=[uint64]0};relay=@{count=0;workingSetBytes=[uint64]0;cpu100ns=[uint64]0};diagnostic=@{count=0;workingSetBytes=[uint64]0;cpu100ns=[uint64]0};compiler=@{count=0;workingSetBytes=[uint64]0;cpu100ns=[uint64]0}}
            foreach ($row in $rows) {
                $kind = 'main'
                if ($row.ProcessId -ne $fixtureId) {
                    $processArgs = [CapacityJob]::Args($row.CommandLine)
                    $expected = $null
                    if ($row.ExecutablePath -ieq $shellExecutable) { $kind='relay'; $expected=$relayArgs }
                    elseif ($row.ExecutablePath -ieq $nodeExecutable) { $kind='diagnostic'; $expected=$diagnosticArgs }
                    elseif ($compilerExecutables -icontains $row.ExecutablePath) {
                        $kind='compiler'
                        $parentRelay = $rows | Where-Object { $_.ProcessId -eq $row.ParentProcessId -and $_.ExecutablePath -ieq $shellExecutable }
                        if (-not $parentRelay) { throw 'compiler-parent-unconfirmed' }
                        $response = if ($processArgs.Count -eq 3) { [string]$processArgs[2] } else { '' }
                        if ($processArgs.Count -ne 3 -or $processArgs[0] -ine '/noconfig' -or $processArgs[1] -ine '/fullpaths' -or -not $response.StartsWith('@')) { throw 'compiler-command-unconfirmed' }
                        $responsePath = [IO.Path]::GetFullPath($response.Substring(1))
                        if (-not $responsePath.StartsWith($compilerTemp.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or -not $responsePath.EndsWith('.cmdline')) { throw 'compiler-response-unconfirmed' }
                    } else { throw 'unexpected-owned-executable' }
                    if ($kind -ne 'compiler' -and $row.ParentProcessId -ne $fixtureId) { throw 'owned-parent-unconfirmed' }
                    if ($kind -ne 'compiler' -and $processArgs.Count -ne $expected.Count) { throw 'owned-command-unconfirmed' }
                    for ($i=0; $kind -ne 'compiler' -and $i -lt $processArgs.Count; $i++) { if ($processArgs[$i] -cne $expected[$i]) { throw 'owned-command-unconfirmed' } }
                }
                $key = $row.ProcessId.ToString()
                $created = $row.CreationDate.ToUniversalTime().Ticks.ToString()
                if ($known.ContainsKey($key) -and $known[$key] -ne $created) { throw 'owned-pid-reused' }
                if ($known.Count -ge 1200 -and -not $known.ContainsKey($key)) { throw 'owned-history-bound' }
                $known[$key] = $created
                $totals[$kind].count++
                $totals[$kind].workingSetBytes += [uint64]$row.WorkingSetSize
                $totals[$kind].cpu100ns += [uint64]$row.UserModeTime + [uint64]$row.KernelModeTime
            }
            if ($totals.relay.count -gt 32 -or $totals.diagnostic.count -gt 1) { throw 'owned-kind-bound' }
            $phase = 'sample-observer'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-observer"}'); [Console]::Out.Flush()
            $observer = Get-Process -Id $PID
            $phase = 'sample-observer-read'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-observer-read"}'); [Console]::Out.Flush()
            $phase = 'sample-reply'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-reply"}'); [Console]::Out.Flush()
            Reply @{id=$requestId;ok=$true;totals=$totals;jobPeakCommitBytes=[CapacityJob]::PeakCommit($job);jobCpu100ns=[CapacityJob]::Cpu100ns($job);observer=@{workingSetBytes=[uint64]$observer.WorkingSet64;cpu100ns=[uint64]$observer.TotalProcessorTime.Ticks}}
            $phase = 'sample-replied'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-replied"}'); [Console]::Out.Flush()
        } elseif ($inputData.op -eq 'members' -and $attached) {
            $phase = 'query-members'
            Reply @{id=$requestId;ok=$true;activeMembers=@([CapacityJob]::Pids($job)).Count}
        } elseif ($inputData.op -eq 'close') {
            $phase = 'close-job'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"close-job"}'); [Console]::Out.Flush()
            if ($job -ne [IntPtr]::Zero) {
                [CapacityJob]::Stop($job)
                for ($attempt=0; $attempt -lt 50 -and @([CapacityJob]::Pids($job)).Count -gt 0; $attempt++) { Start-Sleep -Milliseconds 100 }
                if (@([CapacityJob]::Pids($job)).Count -ne 0) { throw 'job-members-survived' }
                $finalCpu = [CapacityJob]::Cpu100ns($job)
                $finalCommit = [CapacityJob]::PeakCommit($job)
                [void][CapacityJob]::CloseHandle($job); $job=[IntPtr]::Zero
            }
            Reply @{id=$requestId;ok=$true;closed=$true;jobEmptyConfirmed=$true;finalJobCpu100ns=$finalCpu;peakJobCommitBytes=$finalCommit}
            break
        } else { throw 'unsupported-control' }
    }
} catch {
    # A fixed failure record, never PowerShell errors, command lines or stacks.
    $failureId = if ($null -eq $requestId) { 0 } else { $requestId }
    if (-not $utilityLoaded) {
        # Startup refusal must not retry the unavailable JSON cmdlet.
        [Console]::Out.WriteLine('{"id":0,"ok":false,"failure":{"check":"job-supervisor-failed","phase":"' + $phase + '"}}')
        [Console]::Out.Flush()
    } else { Reply @{id=$failureId;ok=$false;failure=@{check='job-supervisor-failed';phase=$phase}} }
    exit 1
} finally {
    if ($job -ne [IntPtr]::Zero) { [void][CapacityJob]::CloseHandle($job) }
}
