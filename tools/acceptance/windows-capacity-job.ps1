param([switch]$ValidateOnly)
# Dev-only supervisor for one paused fixture. No runtime or connector changes.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$job = [IntPtr]::Zero
$attached = $false
$fixtureId = 0
$fixtureCreation = $null
$known = @{}
$maximumRows = 128 # private-job membership, including compiler descendants

function Reply($Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
}

try {
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
    if ($ValidateOnly) {
        $job = [CapacityJob]::Create(536870912)
        if (@([CapacityJob]::Pids($job)).Count -ne 0 -or [CapacityJob]::Cpu100ns($job) -ne 0) { throw 'invalid-empty-job' }
        [void][CapacityJob]::PeakCommit($job)
        [void][CapacityJob]::CloseHandle($job); $job=[IntPtr]::Zero
        Reply @{ok=$true;validated=$true;workloadRun=$false}
        return
    }
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        if ($line.Length -gt 32768) { throw 'invalid-control-line' }
        $inputData = $line | ConvertFrom-Json
        $requestId = [int]$inputData.id
        if ($inputData.op -eq 'attach' -and -not $attached) {
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
            $main = Get-CimInstance Win32_Process -Filter "ProcessId=$fixtureId" -OperationTimeoutSec 2
            if (-not $main -or $main.ParentProcessId -ne $parentId -or $main.ExecutablePath -ine $nodeExecutable) { throw 'fixture-identity-unconfirmed' }
            $actual = [CapacityJob]::Args($main.CommandLine)
            if ($actual.Count -ne $fixtureArgs.Count) { throw 'fixture-command-unconfirmed' }
            for ($i=0; $i -lt $actual.Count; $i++) { if ($actual[$i] -cne $fixtureArgs[$i]) { throw 'fixture-command-unconfirmed' } }
            $fixtureCreation = $main.CreationDate.ToUniversalTime().Ticks.ToString()
            $limit = [ulong]$inputData.commitLimitBytes
            if ($limit -lt 536870912 -or $limit -gt 2147483648) { throw 'invalid-memory-limit' }
            $job = [CapacityJob]::Create($limit)
            [CapacityJob]::Attach($job, $fixtureId, [long]$fixtureCreation)
            $attached = $true
            Reply @{id=$requestId;ok=$true;attached=$true;powershellVersion=@($PSVersionTable.PSVersion.Major,$PSVersionTable.PSVersion.Minor,$PSVersionTable.PSVersion.Build)}
        } elseif ($inputData.op -eq 'sample' -and $attached) {
            $ids = @([CapacityJob]::Pids($job))
            if ($ids.Count -eq 0 -or $ids.Count -gt $maximumRows) { throw 'owned-job-empty-or-overbound' }
            $filter = ($ids | ForEach-Object { 'ProcessId=' + $_ }) -join ' OR '
            $rows = @(Get-CimInstance Win32_Process -Filter $filter -OperationTimeoutSec 2 | Where-Object { [CapacityJob]::Belongs($job, $_.ProcessId) })
            if ($rows.Count -gt $maximumRows) { throw 'owned-child-bound-exceeded' }
            $main = $rows | Where-Object ProcessId -eq $fixtureId
            if (-not $main -or $main.ParentProcessId -ne $parentId -or $main.ExecutablePath -ine $nodeExecutable -or $main.CreationDate.ToUniversalTime().Ticks.ToString() -ne $fixtureCreation) { throw 'fixture-lifetime-unconfirmed' }
            $totals = @{main=@{count=0;workingSetBytes=[ulong]0;cpu100ns=[ulong]0};relay=@{count=0;workingSetBytes=[ulong]0;cpu100ns=[ulong]0};diagnostic=@{count=0;workingSetBytes=[ulong]0;cpu100ns=[ulong]0};compiler=@{count=0;workingSetBytes=[ulong]0;cpu100ns=[ulong]0}}
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
                $totals[$kind].workingSetBytes += [ulong]$row.WorkingSetSize
                $totals[$kind].cpu100ns += [ulong]$row.UserModeTime + [ulong]$row.KernelModeTime
            }
            if ($totals.relay.count -gt 32 -or $totals.diagnostic.count -gt 1) { throw 'owned-kind-bound' }
            $observer = Get-Process -Id $PID
            Reply @{id=$requestId;ok=$true;totals=$totals;jobPeakCommitBytes=[CapacityJob]::PeakCommit($job);jobCpu100ns=[CapacityJob]::Cpu100ns($job);observer=@{workingSetBytes=[ulong]$observer.WorkingSet64;cpu100ns=[ulong]$observer.TotalProcessorTime.Ticks}}
        } elseif ($inputData.op -eq 'members' -and $attached) {
            Reply @{id=$requestId;ok=$true;activeMembers=@([CapacityJob]::Pids($job)).Count}
        } elseif ($inputData.op -eq 'close') {
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
    Reply @{id=$requestId;ok=$false;check='job-supervisor-failed'}
    exit 1
} finally {
    if ($job -ne [IntPtr]::Zero) { [void][CapacityJob]::CloseHandle($job) }
}
