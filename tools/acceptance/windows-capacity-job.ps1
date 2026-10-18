param([switch]$ValidateOnly,[switch]$DiagnosticParserTestOnly)
if ($DiagnosticParserTestOnly) { $ValidateOnly=$true }
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
$diagnosticTestCase = 'startup-or-unknown'
$diagnosticFailureStage = $null
$diagnosticFailureParent = $null
$diagnosticTestCases = @('startup-or-unknown','missing-command-line','wrong-type-refused','over-bound-refused-before-parse','console-host-over-bound-shape-only','zero-arguments','one-argument','multiple-arguments','legacy-handle-only-candidate','legacy-handle-force-v1-candidate','malformed-case-length-and-extra-args-other','unparsed-command-shape','parser-argument-bound-refused','legacy-relay-args-exact-and-current-parent-correlation','wrong-relay-argv-not-exact','wrong-fixture-parent-not-exact','older-parent-date-not-exact','unknown-parent-not-correlated')
$diagnosticTestPhases = @('script-entry','module-observation','import-utility','compile-supervisor','supervisor-compiled')

function Reply($Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
}

function Test-NativeCustodyArguments([object[]]$Arguments, [bool]$Enabled) {
    return $Enabled -and $Arguments.Count -eq 1 -and $Arguments[0] -is [string] -and $Arguments[0] -cin @('--sid','--inspect')
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
    public const int MaximumCommandLineChars = 32766; // CreateProcess limit of 32767 UTF-16 code units includes the terminating NUL.
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
        if (command == null || command.Length > MaximumCommandLineChars) throw new ArgumentOutOfRangeException();
        int count;
        IntPtr data = CommandLineToArgvW(command, out count);
        if (data == IntPtr.Zero) throw new Exception();
        try {
            if (count < 1 || count > 12) throw new Exception();
            List<string> args = new List<string>();
            for (int i=1; i<count; i++) args.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(data, i * IntPtr.Size)));
            return args.ToArray();
        } finally { LocalFree(data); }
    }
}
'@ | Out-Null
function Get-BoundedCommandLineShape([object]$CommandLine) {
    if ($null -eq $CommandLine) { return @{class='missing';argumentCount=$null;arguments=$null} }
    if ($CommandLine -isnot [string]) { return @{class='wrong-type';argumentCount=$null;arguments=$null} }
    if ($CommandLine.Length -gt [CapacityJob]::MaximumCommandLineChars) { return @{class='over-bound';argumentCount=$null;arguments=$null} }
    try { $arguments = [CapacityJob]::Args($CommandLine) }
    catch { return @{class='parse-refused';argumentCount=$null;arguments=$null} }
    $count = $arguments.Count
    if ($count -eq 0) { $argumentClass='no-arguments' }
    elseif ($count -eq 1) { $argumentClass='one-argument' }
    else { $argumentClass='multiple-arguments' }
    return @{class=$argumentClass;argumentCount=$count;arguments=$arguments}
}
function Test-LegacyConsoleHandleToken([object]$Value) {
    if ($Value -isnot [string] -or $Value.Length -lt 3 -or $Value.Length -gt 10) { return $false }
    return $Value -cmatch '\A0x[0-9A-Fa-f]{1,8}\z'
}
function Get-ConsoleHostCommandShape([object]$Shape) {
    # These are bounded lexical observations drawn from Microsoft's moving main
    # branch at src/host/ConsoleArguments.cpp and src/host/ut_host/ConsoleArgumentsTests.cpp.
    # They do not establish that the installed Windows binary supports either grammar.
    if ($Shape.class -notin @('no-arguments','one-argument','multiple-arguments')) { return 'unparsed' }
    $arguments = @($Shape.arguments)
    if ($arguments.Count -eq 1 -and (Test-LegacyConsoleHandleToken $arguments[0])) { return 'legacy-handle-only-candidate' }
    if ($arguments.Count -eq 2 -and (Test-LegacyConsoleHandleToken $arguments[0]) -and $arguments[1] -ceq '-ForceV1') { return 'legacy-handle-force-v1-candidate' }
    return 'other'
}
function Get-ConsoleHostDiagnostics([object]$Row,[object[]]$Rows,[string]$ShellExecutable,[object[]]$RelayArgs,[int]$FixtureId,[string]$FixtureCreation) {
    # The line is inspected only in memory, under a character bound before the
    # native parser. Receipts contain shape/count only. Parent row correlations
    # use the current job-filtered sample; timestamps are not historical proof.
    $rowShape = Get-BoundedCommandLineShape $Row.CommandLine
    $commandShape = Get-ConsoleHostCommandShape $rowShape
    $parentRows = @($Rows | Where-Object { $_.ProcessId -eq $Row.ParentProcessId })
    $parentFound = $parentRows.Count -eq 1
    $parentRelayPath = $false
    $parentClass = 'not-checked'
    $parentArgCount = $null
    $parentArgsParsed = $false
    $parentArgsEqual = $false
    $parentParentIsFixture = $false
    $parentCreationPresent = $false
    $parentCreationAfterFixture = $false
    $rowCreationPresent = $false
    $rowCreationAfterParent = $false
    if ($parentFound) {
        $parent = $parentRows[0]
        $parentRelayPath = $parent.ExecutablePath -is [string] -and [string]::Equals($parent.ExecutablePath,$ShellExecutable,[StringComparison]::OrdinalIgnoreCase)
        $parentParentIsFixture = $parent.ParentProcessId -eq $FixtureId
        try {
            if ($null -ne $parent.CreationDate) {
                $parentTicks = $parent.CreationDate.ToUniversalTime().Ticks
                $parentCreationPresent = $parentTicks -gt 0
                if ($parentCreationPresent) { $parentCreationAfterFixture = $parentTicks -ge [long]$FixtureCreation }
            }
        } catch { $parentCreationPresent=$false;$parentCreationAfterFixture=$false }
        try {
            if ($null -ne $Row.CreationDate) { $rowTicks = $Row.CreationDate.ToUniversalTime().Ticks; $rowCreationPresent = $rowTicks -gt 0 }
        } catch { $rowCreationPresent=$false }
        if ($rowCreationPresent -and $parentCreationPresent) { $rowCreationAfterParent = $rowTicks -ge $parentTicks }
        if ($parentRelayPath) {
            $parentShape = Get-BoundedCommandLineShape $parent.CommandLine
            $parentClass = $parentShape.class
            $parentArgCount = $parentShape.argumentCount
            $parentArgsParsed = $parentClass -in @('no-arguments','one-argument','multiple-arguments')
            if ($parentArgsParsed -and $parentParentIsFixture -and $parentCreationAfterFixture) {
                $expectedRelayArgs = @($RelayArgs)
                if ($parentShape.arguments.Count -eq $expectedRelayArgs.Count) {
                    $parentArgsEqual = $true
                    for ($i=0; $i -lt $expectedRelayArgs.Count; $i++) {
                        if ($parentShape.arguments[$i] -cne $expectedRelayArgs[$i]) { $parentArgsEqual=$false;break }
                    }
                }
            }
        }
    }
    return @{
        consoleHostCommandLineClass=$rowShape.class;consoleHostArgumentCount=$rowShape.argumentCount;consoleHostCommandShape=$commandShape
        parentCurrentRowFound=$parentFound;parentRelayPathMatch=$parentRelayPath
        parentRelayCommandLineClass=$parentClass;parentRelayArgumentCount=$parentArgCount
        parentRelayArgsParsed=$parentArgsParsed;parentRelayArgsEqualExpected=$parentArgsEqual
        parentParentIsFixture=$parentParentIsFixture;parentCreationDatePresent=$parentCreationPresent
        parentCreationAtOrAfterFixtureObserved=$parentCreationAfterFixture
        consoleHostCreationDatePresent=$rowCreationPresent;consoleHostCreationAtOrAfterParentObserved=$rowCreationAfterParent
    }
}
    $phase = 'supervisor-compiled'
    if (-not $ValidateOnly) {
        [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"supervisor-compiled"}')
        [Console]::Out.Flush()
    }
    if ($ValidateOnly) {
        if (-not (Test-NativeCustodyArguments @('--sid') $true) -or
            -not (Test-NativeCustodyArguments @('--inspect') $true) -or
            (Test-NativeCustodyArguments @('--sid') $false) -or
            (Test-NativeCustodyArguments @() $true) -or
            (Test-NativeCustodyArguments @('--SID') $true) -or
            (Test-NativeCustodyArguments @('--sid','extra') $true) -or
            (Test-NativeCustodyArguments @(1) $true)) { throw 'native-custody-arguments-test-failed' }
        if ($DiagnosticParserTestOnly) {
            $cases = [Collections.Generic.List[string]]::new()
            $diagnosticTestCase = 'missing-command-line'
            $shape = Get-BoundedCommandLineShape $null
            if ($shape.class -ne 'missing' -or $null -ne $shape.argumentCount) { throw 'diagnostic-parser-test-failed' }
            $cases.Add('missing-command-line')
            $diagnosticTestCase = 'wrong-type-refused'
            $shape = Get-BoundedCommandLineShape ([pscustomobject]@{value='not-a-string'})
            if ($shape.class -ne 'wrong-type' -or $null -ne $shape.argumentCount) { throw 'diagnostic-parser-test-failed' }
            $cases.Add('wrong-type-refused')
            $diagnosticTestCase = 'over-bound-refused-before-parse'
            $shape = Get-BoundedCommandLineShape ('x' * ([CapacityJob]::MaximumCommandLineChars + 1))
            if ($shape.class -ne 'over-bound' -or $null -ne $shape.argumentCount) { throw 'diagnostic-parser-test-failed' }
            $cases.Add('over-bound-refused-before-parse')
            $diagnosticTestCase = 'console-host-over-bound-shape-only'
            $oversizedRow = @{ProcessId=40;ParentProcessId=31;ExecutablePath='C:\Windows\System32\conhost.exe';CommandLine=('x' * ([CapacityJob]::MaximumCommandLineChars + 1));CreationDate=[DateTime]::UtcNow}
            $oversizedDiagnostics = Get-ConsoleHostDiagnostics -Row $oversizedRow -Rows @($oversizedRow) -ShellExecutable 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -RelayArgs @('-NoProfile','-Command','fixed') -FixtureId 20 -FixtureCreation ([string][DateTime]::UtcNow.Ticks)
            if ($oversizedDiagnostics.consoleHostCommandLineClass -ne 'over-bound' -or $null -ne $oversizedDiagnostics.consoleHostArgumentCount -or $oversizedDiagnostics.consoleHostCommandShape -ne 'unparsed') { throw 'diagnostic-parser-test-failed' }
            $cases.Add('console-host-over-bound-shape-only')
            $diagnosticTestCase = 'zero-arguments'
            $shape = Get-BoundedCommandLineShape '"C:\Windows\System32\conhost.exe"'
            if ($shape.class -ne 'no-arguments' -or $shape.argumentCount -ne 0) { throw 'diagnostic-parser-test-failed' }
            $cases.Add('zero-arguments')
            $diagnosticTestCase = 'one-argument'
            $shape = Get-BoundedCommandLineShape '"C:\Windows\System32\conhost.exe" 0x4'
            if ($shape.class -ne 'one-argument' -or $shape.argumentCount -ne 1) { throw 'diagnostic-parser-test-failed' }
            $cases.Add('one-argument')
            $diagnosticTestCase = 'multiple-arguments'
            $shape = Get-BoundedCommandLineShape '"C:\Windows\System32\conhost.exe" 0x4 --headless'
            if ($shape.class -ne 'multiple-arguments' -or $shape.argumentCount -ne 2) { throw 'diagnostic-parser-test-failed' }
            $cases.Add('multiple-arguments')
            $diagnosticTestCase = 'legacy-handle-only-candidate'
            $shape = Get-BoundedCommandLineShape '"C:\Windows\System32\conhost.exe" 0xA1b2C3d4'
            if ((Get-ConsoleHostCommandShape $shape) -ne 'legacy-handle-only-candidate') { throw 'diagnostic-parser-test-failed' }
            $cases.Add('legacy-handle-only-candidate')
            $diagnosticTestCase = 'legacy-handle-force-v1-candidate'
            $shape = Get-BoundedCommandLineShape '"C:\Windows\System32\conhost.exe" 0xDEADBEEF -ForceV1'
            if ((Get-ConsoleHostCommandShape $shape) -ne 'legacy-handle-force-v1-candidate') { throw 'diagnostic-parser-test-failed' }
            $cases.Add('legacy-handle-force-v1-candidate')
            $diagnosticTestCase = 'malformed-case-length-and-extra-args-other'
            foreach ($line in @(
                '"C:\Windows\System32\conhost.exe" 0XDEADBEEF',
                '"C:\Windows\System32\conhost.exe" 0x123456789',
                '"C:\Windows\System32\conhost.exe" 0xA1b2C3d4 -forcev1',
                '"C:\Windows\System32\conhost.exe" 0xA1b2C3d4 -ForceV1 extra'
            )) {
                $shape = Get-BoundedCommandLineShape $line
                if ((Get-ConsoleHostCommandShape $shape) -ne 'other') { throw 'diagnostic-parser-test-failed' }
            }
            $cases.Add('malformed-case-length-and-extra-args-other')
            $diagnosticTestCase = 'unparsed-command-shape'
            $unparsedLine = '"C:\Windows\System32\conhost.exe" ' + ((1..13 | ForEach-Object { 'a' }) -join ' ')
            $shape = Get-BoundedCommandLineShape $unparsedLine
            if ((Get-ConsoleHostCommandShape $shape) -ne 'unparsed') { throw 'diagnostic-parser-test-failed' }
            $cases.Add('unparsed-command-shape')
            $diagnosticTestCase = 'parser-argument-bound-refused'
            $many = '"C:\Windows\System32\conhost.exe" ' + ((1..13 | ForEach-Object { 'a' }) -join ' ')
            $shape = Get-BoundedCommandLineShape $many
            if ($shape.class -ne 'parse-refused' -or $null -ne $shape.argumentCount) { throw 'diagnostic-parser-test-failed' }
            $cases.Add('parser-argument-bound-refused')
            $diagnosticTestCase = 'legacy-relay-args-exact-and-current-parent-correlation'
            $actualRelayArgs = $env:AGENT_COMMS_TEST_RELAY_ARGS_JSON | ConvertFrom-Json
            if ($actualRelayArgs -isnot [array] -or $actualRelayArgs.Count -ne 7 -or @($actualRelayArgs | Where-Object { $_ -isnot [string] }).Count -ne 0 -or $actualRelayArgs[0] -ne '-NoLogo' -or $actualRelayArgs[5] -ne '-Command' -or $actualRelayArgs[-1].Contains('"')) { throw 'diagnostic-parser-test-failed' }
            $shellPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
            $hostPath = 'C:\Windows\System32\conhost.exe'
            $relayCommandLine = '"' + $shellPath + '" ' + (($actualRelayArgs[0..($actualRelayArgs.Count - 2)] -join ' ') + ' "' + $actualRelayArgs[-1] + '"')
            $parentCreated = [DateTime]::UtcNow
            $hostCreated = $parentCreated.AddMilliseconds(1)
            $parentRows = @(
                @{ProcessId=31;ParentProcessId=20;ExecutablePath=$shellPath;CommandLine=$relayCommandLine;CreationDate=$parentCreated},
                @{ProcessId=40;ParentProcessId=31;ExecutablePath=$hostPath;CommandLine='"conhost.exe" 0xDEADBEEF -ForceV1';CreationDate=$hostCreated}
            )
            $fixtureCreated = [string]$parentCreated.AddMilliseconds(-1).Ticks
            $parentDiagnostics = Get-ConsoleHostDiagnostics -Row $parentRows[1] -Rows $parentRows -ShellExecutable $shellPath -RelayArgs $actualRelayArgs -FixtureId 20 -FixtureCreation $fixtureCreated
            $diagnosticFailureParent = [ordered]@{
                parentCurrentRowFound=$parentDiagnostics.parentCurrentRowFound
                parentRelayPathMatch=$parentDiagnostics.parentRelayPathMatch
                parentRelayCommandLineClass=$parentDiagnostics.parentRelayCommandLineClass
                parentRelayArgumentCount=$parentDiagnostics.parentRelayArgumentCount
                parentRelayArgsParsed=$parentDiagnostics.parentRelayArgsParsed
                parentRelayArgsEqualExpected=$parentDiagnostics.parentRelayArgsEqualExpected
                parentParentIsFixture=$parentDiagnostics.parentParentIsFixture
                parentCreationDatePresent=$parentDiagnostics.parentCreationDatePresent
                parentCreationAtOrAfterFixtureObserved=$parentDiagnostics.parentCreationAtOrAfterFixtureObserved
                consoleHostCommandLineClass=$parentDiagnostics.consoleHostCommandLineClass
                consoleHostArgumentCount=$parentDiagnostics.consoleHostArgumentCount
                consoleHostCommandShape=$parentDiagnostics.consoleHostCommandShape
                consoleHostCreationDatePresent=$parentDiagnostics.consoleHostCreationDatePresent
                consoleHostCreationAtOrAfterParentObserved=$parentDiagnostics.consoleHostCreationAtOrAfterParentObserved
            }
            $diagnosticFailureStage = 'precondition'
            if (-not $parentDiagnostics.parentCurrentRowFound -or -not $parentDiagnostics.parentRelayPathMatch -or -not $parentDiagnostics.parentRelayArgsParsed -or -not $parentDiagnostics.parentRelayArgsEqualExpected -or -not $parentDiagnostics.parentParentIsFixture -or -not $parentDiagnostics.parentCreationAtOrAfterFixtureObserved -or -not $parentDiagnostics.consoleHostCreationAtOrAfterParentObserved -or $parentDiagnostics.consoleHostCommandShape -ne 'legacy-handle-force-v1-candidate') { throw 'diagnostic-parser-test-failed' }
            $diagnosticFailureStage = 'redaction-guard'
            if ((ConvertTo-Json -InputObject $parentDiagnostics -Compress).Contains('DEADBEEF')) { throw 'diagnostic-parser-test-failed' }
            $diagnosticFailureStage = $null
            $diagnosticFailureParent = $null
            $cases.Add('legacy-relay-args-exact-and-current-parent-correlation')
            $diagnosticTestCase = 'wrong-relay-argv-not-exact'
            $wrongArgs = @($actualRelayArgs);$wrongArgs[-1] = $wrongArgs[-1] + ' changed'
            $wrongArgRows = @($parentRows[0].Clone(),$parentRows[1].Clone())
            $wrongArgRows[0].CommandLine = '"' + $shellPath + '" ' + (($wrongArgs[0..($wrongArgs.Count - 2)] -join ' ') + ' "' + $wrongArgs[-1] + '"')
            $wrongArgDiagnostics = Get-ConsoleHostDiagnostics -Row $wrongArgRows[1] -Rows $wrongArgRows -ShellExecutable $shellPath -RelayArgs $actualRelayArgs -FixtureId 20 -FixtureCreation $fixtureCreated
            if (-not $wrongArgDiagnostics.parentRelayArgsParsed -or $wrongArgDiagnostics.parentRelayArgsEqualExpected) { throw 'diagnostic-parser-test-failed' }
            $cases.Add('wrong-relay-argv-not-exact')
            $diagnosticTestCase = 'wrong-fixture-parent-not-exact'
            $wrongParentRows = @($parentRows[0].Clone(),$parentRows[1].Clone())
            $wrongParentRows[0].ParentProcessId = 21
            $wrongParentDiagnostics = Get-ConsoleHostDiagnostics -Row $wrongParentRows[1] -Rows $wrongParentRows -ShellExecutable $shellPath -RelayArgs $actualRelayArgs -FixtureId 20 -FixtureCreation $fixtureCreated
            if (-not $wrongParentDiagnostics.parentCurrentRowFound -or $wrongParentDiagnostics.parentParentIsFixture -or $wrongParentDiagnostics.parentRelayArgsEqualExpected) { throw 'diagnostic-parser-test-failed' }
            $cases.Add('wrong-fixture-parent-not-exact')
            $diagnosticTestCase = 'older-parent-date-not-exact'
            $olderFixtureCreated = [string]$parentCreated.AddSeconds(1).Ticks
            $olderDiagnostics = Get-ConsoleHostDiagnostics -Row $parentRows[1] -Rows $parentRows -ShellExecutable $shellPath -RelayArgs $actualRelayArgs -FixtureId 20 -FixtureCreation $olderFixtureCreated
            if (-not $olderDiagnostics.parentCreationDatePresent -or $olderDiagnostics.parentCreationAtOrAfterFixtureObserved -or $olderDiagnostics.parentRelayArgsEqualExpected) { throw 'diagnostic-parser-test-failed' }
            $cases.Add('older-parent-date-not-exact')
            $diagnosticTestCase = 'unknown-parent-not-correlated'
            $unknownParentDiagnostics = Get-ConsoleHostDiagnostics -Row $parentRows[1] -Rows @($parentRows[1]) -ShellExecutable $shellPath -RelayArgs $actualRelayArgs -FixtureId 20 -FixtureCreation $fixtureCreated
            if ($unknownParentDiagnostics.parentCurrentRowFound -or $unknownParentDiagnostics.parentRelayPathMatch -or $unknownParentDiagnostics.parentRelayArgsParsed -or $unknownParentDiagnostics.parentRelayArgsEqualExpected) { throw 'diagnostic-parser-test-failed' }
            $cases.Add('unknown-parent-not-correlated')
            $diagnosticTestCase = 'startup-or-unknown'
            Reply @{id=0;ok=$true;parserCases=@($cases);workloadRun=$false;processQueryRun=$false}
            return
        }
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
            $nativeCustody = $inputData.nativeCustody -is [bool] -and $inputData.nativeCustody
            if ($nativeCustody -and ($relayArgs.Count -ne 0 -or [IO.Path]::GetFileName($shellExecutable) -cne 'agent-comms-pipe-relay.exe')) { throw 'invalid-native-custody-contract' }
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
                $classification = @{}
                $kind = 'main'
                if ($row.ProcessId -ne $fixtureId) {
                    $consoleHost = [IO.Path]::Combine($env:SystemRoot,'System32','conhost.exe')
                    if ([string]::Equals($row.ExecutablePath, $consoleHost, [StringComparison]::OrdinalIgnoreCase)) {
                        # Reject the unexpected image before parsing its command line.
                        # The diagnostic helper enforces its own bound before parsing.
                        $classification.check = 'executable'
                        $classification.executablePathPresent = $row.ExecutablePath -is [string] -and $row.ExecutablePath.Length -gt 0
                        $classification.builtinConsoleHostMatch = $true
                        $classification.rowIsRelay = $false
                        $classification.rowIsDiagnostic = $false
                        $classification.rowIsCompiler = $false
                        $classification.parentIsFixture = $row.ParentProcessId -eq $fixtureId
                        $ownedParent = @($rows | Where-Object { $_.ProcessId -eq $row.ParentProcessId })
                        $classification.parentInOwnedRows = $ownedParent.Count -gt 0
                        $classification.parentIsDiagnostic = @($ownedParent | Where-Object { $_.ProcessId -ne $fixtureId -and $_.ExecutablePath -ieq $nodeExecutable }).Count -gt 0
                        $classification.parentIsRelay = @($ownedParent | Where-Object { $_.ExecutablePath -ieq $shellExecutable }).Count -gt 0
                        $classification.parentIsCompiler = @($ownedParent | Where-Object { $compilerExecutables -icontains $_.ExecutablePath }).Count -gt 0
                        $classification.parentIsBuiltinConsoleHost = @($ownedParent | Where-Object { [string]::Equals($_.ExecutablePath, $consoleHost, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
                        $consoleHostDiagnostics = Get-ConsoleHostDiagnostics -Row $row -Rows $rows -ShellExecutable $shellExecutable -RelayArgs $relayArgs -FixtureId $fixtureId -FixtureCreation $fixtureCreation
                        foreach ($key in $consoleHostDiagnostics.Keys) { $classification[$key] = $consoleHostDiagnostics[$key] }
                        throw 'unexpected-owned-executable'
                    }
                    $classification.check = 'argv-parse'
                    if ($row.CommandLine -isnot [string] -or $row.CommandLine.Length -gt [CapacityJob]::MaximumCommandLineChars) { throw 'owned-command-line-bound' }
                    $processArgs = [CapacityJob]::Args($row.CommandLine)
                    $expected = $null
                    $classification.check = 'executable'
                    if ($row.ExecutablePath -ieq $shellExecutable) {
                        $kind='relay'; $expected=$relayArgs
                        # Only these two fixed operations of the same verified
                        # helper are admitted. Parent/creation/argv checks below
                        # still apply; path/account inputs travel only on stdin.
                        if (Test-NativeCustodyArguments $processArgs $nativeCustody) { $expected=@($processArgs[0]) }
                    }
                    elseif ($row.ExecutablePath -ieq $nodeExecutable) { $kind='diagnostic'; $expected=$diagnosticArgs }
                    elseif ($compilerExecutables -icontains $row.ExecutablePath) {
                        $kind='compiler'
                        $parentRelay = $rows | Where-Object { $_.ProcessId -eq $row.ParentProcessId -and $_.ExecutablePath -ieq $shellExecutable }
                        $classification.check = 'compiler-parent'
                        if (-not $parentRelay) { throw 'compiler-parent-unconfirmed' }
                        $response = if ($processArgs.Count -eq 3) { [string]$processArgs[2] } else { '' }
                        $classification.check = 'compiler-arguments'
                        if ($processArgs.Count -ne 3 -or $processArgs[0] -ine '/noconfig' -or $processArgs[1] -ine '/fullpaths' -or -not $response.StartsWith('@')) { throw 'compiler-command-unconfirmed' }
                        $classification.check = 'compiler-response'
                        $responsePath = [IO.Path]::GetFullPath($response.Substring(1))
                        if (-not $responsePath.StartsWith($compilerTemp.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or -not $responsePath.EndsWith('.cmdline')) { throw 'compiler-response-unconfirmed' }
                    } else {
                        $classification.executablePathPresent = $row.ExecutablePath -is [string] -and $row.ExecutablePath.Length -gt 0
                        $classification.builtinConsoleHostMatch = [string]::Equals($row.ExecutablePath, $consoleHost, [StringComparison]::OrdinalIgnoreCase)
                        $classification.rowIsRelay = [string]::Equals($row.ExecutablePath, $shellExecutable, [StringComparison]::OrdinalIgnoreCase)
                        $classification.rowIsDiagnostic = [string]::Equals($row.ExecutablePath, $nodeExecutable, [StringComparison]::OrdinalIgnoreCase)
                        $classification.rowIsCompiler = $compilerExecutables -icontains $row.ExecutablePath
                        $classification.parentIsFixture = $row.ParentProcessId -eq $fixtureId
                        $ownedParent = @($rows | Where-Object { $_.ProcessId -eq $row.ParentProcessId })
                        $classification.parentInOwnedRows = $ownedParent.Count -gt 0
                        $classification.parentIsDiagnostic = @($ownedParent | Where-Object { $_.ProcessId -ne $fixtureId -and $_.ExecutablePath -ieq $nodeExecutable }).Count -gt 0
                        $classification.parentIsRelay = @($ownedParent | Where-Object { $_.ExecutablePath -ieq $shellExecutable }).Count -gt 0
                        $classification.parentIsCompiler = @($ownedParent | Where-Object { $compilerExecutables -icontains $_.ExecutablePath }).Count -gt 0
                        $classification.parentIsBuiltinConsoleHost = @($ownedParent | Where-Object { [string]::Equals($_.ExecutablePath, $consoleHost, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
                        throw 'unexpected-owned-executable'
                    }
                    $classification.check = 'owned-parent'
                    if ($kind -ne 'compiler' -and $row.ParentProcessId -ne $fixtureId) { throw 'owned-parent-unconfirmed' }
                    $classification.check = 'argv-count'
                    if ($kind -ne 'compiler') { $classification.argvCountMatches = $processArgs.Count -eq $expected.Count }
                    if ($kind -ne 'compiler' -and $processArgs.Count -ne $expected.Count) { throw 'owned-command-unconfirmed' }
                    $classification.check = 'argv-equality'
                    for ($i=0; $kind -ne 'compiler' -and $i -lt $processArgs.Count; $i++) { if ($processArgs[$i] -cne $expected[$i]) { $classification.argvMatches = $false; throw 'owned-command-unconfirmed' } }
                    if ($kind -ne 'compiler') { $classification.argvMatches = $true }
                }
                $key = $row.ProcessId.ToString()
                $created = $row.CreationDate.ToUniversalTime().Ticks.ToString()
                $classification.check = 'pid-reuse'
                if ($known.ContainsKey($key) -and $known[$key] -ne $created) { throw 'owned-pid-reused' }
                $classification.check = 'history-bound'
                if ($known.Count -ge 1200 -and -not $known.ContainsKey($key)) { throw 'owned-history-bound' }
                $known[$key] = $created
                $totals[$kind].count++
                $totals[$kind].workingSetBytes += [uint64]$row.WorkingSetSize
                $totals[$kind].cpu100ns += [uint64]$row.UserModeTime + [uint64]$row.KernelModeTime
            }
            $classification = @{check='kind-bound'}
            if ($totals.relay.count -gt 32 -or $totals.diagnostic.count -gt 1) { throw 'owned-kind-bound' }
            $phase = 'sample-observer'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-observer"}'); [Console]::Out.Flush()
            $observer = [Diagnostics.Process]::GetCurrentProcess()
            try {
                $observerValues = @{workingSetBytes=[uint64]$observer.WorkingSet64;cpu100ns=[uint64]$observer.TotalProcessorTime.Ticks}
                $phase = 'sample-observer-read'
                [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-observer-read"}'); [Console]::Out.Flush()
            } finally { $observer.Dispose() }
            $phase = 'sample-reply'
            [Console]::Out.WriteLine('{"id":-1,"ok":true,"phase":"sample-reply"}'); [Console]::Out.Flush()
            Reply @{id=$requestId;ok=$true;totals=$totals;jobPeakCommitBytes=[CapacityJob]::PeakCommit($job);jobCpu100ns=[CapacityJob]::Cpu100ns($job);observer=$observerValues}
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
    if ($DiagnosticParserTestOnly) {
        if ($diagnosticTestCases -notcontains $diagnosticTestCase) { $diagnosticTestCase='startup-or-unknown' }
        if ($diagnosticTestPhases -notcontains $phase) { $failurePhase='startup-or-unknown' } else { $failurePhase=$phase }
        $failureRecord = [ordered]@{id=0;ok=$false;failure=[ordered]@{check='diagnostic-parser-test-failed';phase=$failurePhase;case=$diagnosticTestCase}}
        if ($diagnosticTestCase -eq 'legacy-relay-args-exact-and-current-parent-correlation' -and $diagnosticFailureStage -in @('precondition','redaction-guard') -and $null -ne $diagnosticFailureParent) {
            $failureRecord.failure.stage = $diagnosticFailureStage
            $failureRecord.failure.parent = $diagnosticFailureParent
        }
        if ($utilityLoaded) {
            [Console]::Out.WriteLine((ConvertTo-Json -InputObject $failureRecord -Depth 6 -Compress))
        } else {
            # Do not retry unavailable Utility autoload on startup refusal.
            [Console]::Out.WriteLine('{"id":0,"ok":false,"failure":{"check":"diagnostic-parser-test-failed","phase":"' + $failurePhase + '","case":"' + $diagnosticTestCase + '"}}')
        }
        [Console]::Out.Flush()
    } elseif (-not $utilityLoaded) {
        # Startup refusal must not retry the unavailable JSON cmdlet.
        [Console]::Out.WriteLine('{"id":0,"ok":false,"failure":{"check":"job-supervisor-failed","phase":"' + $phase + '"}}')
        [Console]::Out.Flush()
    } else {
        $failure = @{check='job-supervisor-failed';phase=$phase}
        if ($phase -eq 'sample-classify' -and $classification.check -in @('argv-parse','executable','compiler-parent','compiler-arguments','compiler-response','owned-parent','argv-count','argv-equality','pid-reuse','history-bound','kind-bound')) {
            $failure.classification = @{check=$classification.check}
            foreach ($key in @('argvCountMatches','argvMatches','executablePathPresent','builtinConsoleHostMatch','rowIsRelay','rowIsDiagnostic','rowIsCompiler','parentIsFixture','parentIsDiagnostic','parentIsRelay','parentIsCompiler','parentIsBuiltinConsoleHost','parentInOwnedRows','consoleHostCommandLineClass','consoleHostCommandShape','consoleHostArgumentCount','parentCurrentRowFound','parentRelayPathMatch','parentRelayCommandLineClass','parentRelayArgumentCount','parentRelayArgsParsed','parentRelayArgsEqualExpected','parentParentIsFixture','parentCreationDatePresent','parentCreationAtOrAfterFixtureObserved','consoleHostCreationDatePresent','consoleHostCreationAtOrAfterParentObserved')) {
                if ($classification[$key] -is [bool]) { $failure.classification[$key] = $classification[$key] }
            }
            foreach ($key in @('consoleHostCommandLineClass','consoleHostCommandShape','parentRelayCommandLineClass')) {
                if ($classification[$key] -is [string]) { $failure.classification[$key] = $classification[$key] }
            }
            foreach ($key in @('consoleHostArgumentCount','parentRelayArgumentCount')) {
                if ($classification.ContainsKey($key)) { $failure.classification[$key] = $classification[$key] }
            }
        }
        Reply @{id=$failureId;ok=$false;failure=$failure}
    }
    exit 1
} finally {
    if ($job -ne [IntPtr]::Zero) { [void][CapacityJob]::CloseHandle($job) }
}
