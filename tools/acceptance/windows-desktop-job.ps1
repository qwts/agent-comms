# Dev-only outer containment. No fallback, breakaway or inherited job handle.
$ErrorActionPreference = 'Stop'
if (-not ('DesktopOwnedJob' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Per-invocation fixed diagnostics; never exception messages, paths or identities.
public sealed class DesktopJobStartCleanup {
    public string Stage {get;internal set;} public bool Succeeded {get;internal set;}
}
public sealed class DesktopJobStartRecord {
    public string FailureStage {get;private set;} public string ExceptionType {get;private set;}
    public int? HResult {get;private set;} public int? Win32Error {get;private set;}
    public string CleanupFailureStage {get;private set;} public string CleanupExceptionType {get;private set;}
    public int? CleanupHResult {get;private set;} public int? CleanupWin32Error {get;private set;}
    public bool ProcessCreated {get;internal set;} public bool MembershipConfirmed {get;internal set;}
    public bool ResumeAttempted {get;internal set;} public bool ResumeConfirmed {get;internal set;}
    public uint? ResumeResult {get;internal set;} public bool? ProcessTerminal {get;internal set;}
    public bool CleanupUncertain {get;internal set;}
    public bool? TerminateJobAccepted {get;internal set;} public bool? TerminateProcessAccepted {get;internal set;}
    public bool? TerminationFallbackTerminal {get;internal set;}
    internal Exception FirstCleanupError;
    readonly List<DesktopJobStartCleanup> steps=new List<DesktopJobStartCleanup>();
    public DesktopJobStartCleanup[] CleanupSteps {get{return steps.ToArray();}}
    internal void Failure(string stage,Exception error) {
        if(FailureStage!=null)return;
        FailureStage=stage;ExceptionType=error.GetType().FullName;HResult=error.HResult;
        var native=error as DesktopJobNativeFailure;if(native!=null)Win32Error=native.Error;
    }
    internal void CleanupFailure(Exception error) { Failure("final-cleanup",FirstCleanupError??error); }
    internal void Cleanup(string stage,Exception error) {
        if(steps.Count<32)steps.Add(new DesktopJobStartCleanup {Stage=stage,Succeeded=error==null});
        else CleanupUncertain=true;
        if(error==null)return;
        CleanupUncertain=true;
        if(CleanupFailureStage!=null)return;
        FirstCleanupError=error;CleanupFailureStage=stage;CleanupExceptionType=error.GetType().FullName;CleanupHResult=error.HResult;
        var native=error as DesktopJobNativeFailure;if(native!=null)CleanupWin32Error=native.Error;
    }
}
sealed class DesktopJobNativeFailure : Exception {
    internal readonly int Error;
    internal DesktopJobNativeFailure(int error):base("desktop-job-refused"){Error=error;}
}
public sealed class DesktopJobStartFailure : Exception {
    public DesktopJobStartRecord Diagnostic {get;private set;}
    internal DesktopJobStartFailure(DesktopJobStartRecord record):base("desktop-job-refused"){Diagnostic=record;}
}

public sealed class DesktopOwnedJob : IDisposable {
    const uint SYNCHRONIZE=0x00100000, WAIT_OBJECT_0=0, WAIT_TIMEOUT=258;
    const uint CREATE_SUSPENDED=4, CREATE_UNICODE_ENVIRONMENT=0x400,
        EXTENDED_STARTUPINFO_PRESENT=0x80000, CREATE_NO_WINDOW=0x8000000;
    const int STARTF_USESTDHANDLES=0x100;
    const long HANDLE_LIST=0x20002, JOB_LIST=0x2000d;
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {
        public int length; public IntPtr security; [MarshalAs(UnmanagedType.Bool)] public bool inherit;
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public IntPtr reserved,desktop,title;
        public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reservedSize;
        public IntPtr reservedBytes,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking;
        public uint active; public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
        public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
        public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated;
    }
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out ACCOUNTING data,uint size,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES attributes,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref UIntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public const int CleanupGraceMs=5000;
#if DESKTOP_JOB_PROOF
    // Only compiled by the independent test harness from this same C# source.
    // No frame, environment or normal helper option can enable this barrier.
    public static Action<DesktopOwnedJob> BeforeResumeProof;
    // Read ends ONLY. No job, process, stdin or pipe-write exposure.
    public long ProofStdoutReadHandle { get { return outputHandle.DangerousGetHandle().ToInt64(); } }
    public long ProofStderrReadHandle { get { return errorHandle.DangerousGetHandle().ToInt64(); } }
#endif
    IntPtr job,process;
    SafeFileHandle inputHandle,outputHandle,errorHandle;
    public FileStream Input { get; private set; }
    public FileStream Output { get; private set; }
    public FileStream Error { get; private set; }
    public uint ProcessId { get; private set; }
    public bool AssignedBeforeResume { get; private set; }
    public ulong CommitLimitBytes { get; private set; }
    static Exception Refusal() { return new Exception("desktop-job-refused"); }
    static void Close(ref IntPtr handle) { if(handle!=IntPtr.Zero) { IntPtr saved=handle; handle=IntPtr.Zero; if(!CloseHandle(saved)) throw Refusal(); } }
    // Call immediately after a SetLastError-enabled native failure only.
    static Exception NativeRefusal() { int error=Marshal.GetLastWin32Error(); return new DesktopJobNativeFailure(error); }
    static void RequireNative(bool result) { if(!result)throw NativeRefusal(); }
    static void Observe(DesktopJobStartRecord record,string stage,Action action) {
        try {action();if(record!=null)record.Cleanup(stage,null);}
        catch(Exception error){if(record!=null)record.Cleanup(stage,error);throw;}
    }
    static void ChildPipe(out IntPtr read,out IntPtr write) {
        var attributes=new SECURITY_ATTRIBUTES { length=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),inherit=true };
        if(!CreatePipe(out read,out write,ref attributes,4096)) throw NativeRefusal();
    }
    static string Quote(string value) {
        // Both arguments are fixed file paths, not caller command fragments.
        if(String.IsNullOrEmpty(value)||value.IndexOf('"')>=0||value.IndexOf((char)0)>=0) throw Refusal();
        return "\""+value+"\"";
    }
    public static DesktopOwnedJob Start(string executable,string runner,string cwd,IDictionary environment,ulong commitLimitBytes) {
        var owned=new DesktopOwnedJob(); owned.CommitLimitBytes=commitLimitBytes;
        IntPtr inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,errorRead=IntPtr.Zero,errorWrite=IntPtr.Zero;
        IntPtr attributes=IntPtr.Zero,handleList=IntPtr.Zero,jobList=IntPtr.Zero,block=IntPtr.Zero,thread=IntPtr.Zero;
        bool initialized=false,success=false;
        var diagnostic=new DesktopJobStartRecord(); string stage="validate-limit";
        try {
            if(commitLimitBytes<536870912||commitLimitBytes>2147483648) throw Refusal();
            // Null security attributes create a NONINHERITABLE, unnamed handle.
            // This wrapper holds the only job handle; it is absent from child whitelist.
            stage="create-job"; owned.job=CreateJobObject(IntPtr.Zero,null); if(owned.job==IntPtr.Zero) throw NativeRefusal();
            stage="job-noninheritable"; RequireNative(SetHandleInformation(owned.job,1,0));
            stage="set-job-limits"; var limits=new EXTENDED_LIMIT(); limits.basic.flags=0x2208; // KILL_ON_JOB_CLOSE | JOB_MEMORY | ACTIVE_PROCESS
            limits.basic.active=128; limits.jobMemory=new UIntPtr(commitLimitBytes);
            IntPtr data=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(EXTENDED_LIMIT)));
            try { Marshal.StructureToPtr(limits,data,false); if(!SetInformationJobObject(owned.job,9,data,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) throw NativeRefusal(); }
            catch(Exception error) { diagnostic.Failure(stage,error); throw; }
            finally {
                try { Observe(diagnostic,"free-limit-buffer",()=>Marshal.FreeHGlobal(data)); }
                catch(Exception error) { diagnostic.CleanupFailure(error); throw; }
            }
            stage="pipe-input"; ChildPipe(out inputRead,out inputWrite);
            stage="pipe-output"; ChildPipe(out outputRead,out outputWrite);
            stage="pipe-error"; ChildPipe(out errorRead,out errorWrite);
            stage="parent-input-noninheritable"; RequireNative(SetHandleInformation(inputWrite,1,0));
            stage="parent-output-noninheritable"; RequireNative(SetHandleInformation(outputRead,1,0));
            stage="parent-error-noninheritable"; RequireNative(SetHandleInformation(errorRead,1,0));
            stage="attribute-size"; UIntPtr attributeBytes=UIntPtr.Zero;
            bool sized=InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref attributeBytes);
            int? sizeError=sized?null:(int?)Marshal.GetLastWin32Error();
            // The sizing call normally returns false/INSUFFICIENT_BUFFER.
            if(attributeBytes==UIntPtr.Zero||attributeBytes.ToUInt64()>65536) {
                if(sizeError.HasValue)throw new DesktopJobNativeFailure(sizeError.Value);throw Refusal();
            }
            attributes=Marshal.AllocHGlobal((int)attributeBytes.ToUInt64());
            stage="attribute-init"; if(!InitializeProcThreadAttributeList(attributes,2,0,ref attributeBytes)) throw NativeRefusal(); initialized=true;
            stage="attribute-stdio"; handleList=Marshal.AllocHGlobal(IntPtr.Size*3);
            Marshal.WriteIntPtr(handleList,0,inputRead); Marshal.WriteIntPtr(handleList,IntPtr.Size,outputWrite); Marshal.WriteIntPtr(handleList,IntPtr.Size*2,errorWrite);
            if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(HANDLE_LIST),handleList,new UIntPtr((uint)(IntPtr.Size*3)),IntPtr.Zero,IntPtr.Zero)) throw NativeRefusal();
            // Atomic creation in the job removes the parent-death gap between
            // CreateProcess and AssignProcessToJobObject. No uncontained suspended child.
            stage="attribute-job"; jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,owned.job);
            if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(JOB_LIST),jobList,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw NativeRefusal();
            stage="environment"; var entries=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            foreach(DictionaryEntry entry in environment) {
                string key=(string)entry.Key,value=(string)entry.Value;
                if(String.IsNullOrEmpty(key)||key.IndexOfAny(new char[]{'=', (char)0})>=0||value==null||value.IndexOf((char)0)>=0) throw Refusal();
                entries.Add(key,value);
            }
            var env=new StringBuilder(); foreach(var entry in entries) env.Append(entry.Key).Append('=').Append(entry.Value).Append((char)0); env.Append((char)0);
            if(env.Length>32767) throw Refusal(); block=Marshal.StringToHGlobalUni(env.ToString());
            var startup=new STARTUPINFOEX(); startup.startup.cb=Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.attributes=attributes;
            startup.startup.flags=STARTF_USESTDHANDLES; startup.startup.input=inputRead; startup.startup.output=outputWrite; startup.startup.error=errorWrite;
            stage="create-suspended"; PROCESS_INFORMATION info;
            if(!CreateProcess(executable,new StringBuilder(Quote(executable)+" "+Quote(runner)+" --desktop-owned"),IntPtr.Zero,IntPtr.Zero,true,
                CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,block,cwd,ref startup,out info)) throw NativeRefusal();
            owned.process=info.process; thread=info.thread; owned.ProcessId=info.pid; diagnostic.ProcessCreated=true;
            stage="verify-membership"; bool inJob; RequireNative(IsProcessInJob(owned.process,owned.job,out inJob)); if(!inJob)throw Refusal(); diagnostic.MembershipConfirmed=true;
            owned.AssignedBeforeResume=true;
            stage="child-input-close"; Close(ref inputRead); stage="child-output-close"; Close(ref outputWrite); stage="child-error-close"; Close(ref errorWrite);
            stage="safe-input"; owned.inputHandle=new SafeFileHandle(inputWrite,true); inputWrite=IntPtr.Zero;
            stage="safe-output"; owned.outputHandle=new SafeFileHandle(outputRead,true); outputRead=IntPtr.Zero;
            stage="safe-error"; owned.errorHandle=new SafeFileHandle(errorRead,true); errorRead=IntPtr.Zero;
            stage="stream-input"; owned.Input=new FileStream(owned.inputHandle,FileAccess.Write,4096,false);
            stage="stream-output"; owned.Output=new FileStream(owned.outputHandle,FileAccess.Read,4096,false);
            stage="stream-error"; owned.Error=new FileStream(owned.errorHandle,FileAccess.Read,4096,false);
#if DESKTOP_JOB_PROOF
            stage="proof-before-resume"; if(BeforeResumeProof!=null) BeforeResumeProof(owned);
#endif
            stage="resume"; diagnostic.ResumeAttempted=true;
            uint resumed=ResumeThread(thread); int? resumeError=resumed==0xffffffff? (int?)Marshal.GetLastWin32Error():null;
            diagnostic.ResumeResult=resumed;
            if(resumeError.HasValue)throw new DesktopJobNativeFailure(resumeError.Value);
            if(resumed!=1)throw Refusal(); diagnostic.ResumeConfirmed=true;
            stage="thread-close"; Close(ref thread);
            success=true; return owned;
        } catch(Exception error) {
            diagnostic.Failure(stage,error); throw new DesktopJobStartFailure(diagnostic);
        } finally {
            var grace=Stopwatch.StartNew();
            Exception cleanup=null;
            Action<Action> attempt=action=>{ try { action(); } catch(Exception error) { cleanup=error; } };
            if(!success) {
                // Attempt every owned cleanup even if one operation is unknown.
                // Never resume a refused assignment or silently succeed on close.
                if(owned.job!=IntPtr.Zero) attempt(()=>Observe(diagnostic,"terminate-job",()=>{ bool accepted=TerminateJobObject(owned.job,1); int? error=accepted?null:(int?)Marshal.GetLastWin32Error(); diagnostic.TerminateJobAccepted=accepted; if(!accepted)throw new DesktopJobNativeFailure(error.Value); }));
                if(owned.process!=IntPtr.Zero) {
                    attempt(()=>Observe(diagnostic,"terminate-process",()=>{
                        bool accepted=TerminateProcess(owned.process,1); int? error=accepted?null:(int?)Marshal.GetLastWin32Error();
                        diagnostic.TerminateProcessAccepted=accepted;
                        if(!accepted) { diagnostic.TerminationFallbackTerminal=WaitForSingleObject(owned.process,0)==WAIT_OBJECT_0; if(diagnostic.TerminationFallbackTerminal!=true)throw new DesktopJobNativeFailure(error.Value); }
                    }));
                    attempt(()=>Observe(diagnostic,"wait-process",()=>{ int remaining=(int)Math.Max(0,CleanupGraceMs-grace.ElapsedMilliseconds); diagnostic.ProcessTerminal=owned.WaitForExit(remaining); if(diagnostic.ProcessTerminal!=true) throw Refusal(); }));
                }
                attempt(()=>owned.Dispose(diagnostic));
            }
            if(thread!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"close-thread",()=>Close(ref thread)));
            if(inputRead!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"close-input-read",()=>Close(ref inputRead)));
            if(inputWrite!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"close-input-write",()=>Close(ref inputWrite)));
            if(outputRead!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"close-output-read",()=>Close(ref outputRead)));
            if(outputWrite!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"close-output-write",()=>Close(ref outputWrite)));
            if(errorRead!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"close-error-read",()=>Close(ref errorRead)));
            if(errorWrite!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"close-error-write",()=>Close(ref errorWrite)));
            if(initialized)attempt(()=>Observe(diagnostic,"delete-attributes",()=>DeleteProcThreadAttributeList(attributes)));
            if(attributes!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"free-attributes",()=>Marshal.FreeHGlobal(attributes)));
            if(handleList!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"free-handle-list",()=>Marshal.FreeHGlobal(handleList)));
            if(jobList!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"free-job-list",()=>Marshal.FreeHGlobal(jobList)));
            if(block!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"free-environment",()=>Marshal.FreeHGlobal(block)));
            if(cleanup!=null) {
                if(success) {
                    attempt(()=>Observe(diagnostic,"terminate-job",()=>{ bool accepted=TerminateJobObject(owned.job,1); int? error=accepted?null:(int?)Marshal.GetLastWin32Error(); diagnostic.TerminateJobAccepted=accepted; if(!accepted)throw new DesktopJobNativeFailure(error.Value); }));
                    attempt(()=>Observe(diagnostic,"wait-process",()=>{ int remaining=(int)Math.Max(0,CleanupGraceMs-grace.ElapsedMilliseconds); diagnostic.ProcessTerminal=owned.WaitForExit(remaining); if(diagnostic.ProcessTerminal!=true) throw Refusal(); }));
                    attempt(()=>owned.Dispose(diagnostic));
                }
                diagnostic.CleanupFailure(cleanup); throw new DesktopJobStartFailure(diagnostic);
            }
        }
    }

    public Task WriteFrame(string frame) {
        byte[] bytes=Encoding.UTF8.GetBytes(frame);
        if(bytes.Length==0||bytes.Length>4096) throw Refusal();
        return WriteFrameAsync(bytes);
    }
    async Task WriteFrameAsync(byte[] bytes) {
        await Input.WriteAsync(bytes,0,bytes.Length).ConfigureAwait(false);
        await Input.FlushAsync().ConfigureAwait(false);
        inputHandle.Dispose();
    }
    public bool WaitForExit(int milliseconds) {
        if(milliseconds<0||milliseconds>CleanupGraceMs) throw Refusal();
        uint result=WaitForSingleObject(process,(uint)milliseconds);
        if(result==WAIT_OBJECT_0) return true; if(result==WAIT_TIMEOUT) return false; if(result==0xffffffff)throw NativeRefusal(); throw Refusal();
    }
    public int ExitCode { get { uint value; if(!WaitForExit(0)||!GetExitCodeProcess(process,out value)) throw Refusal(); return unchecked((int)value); } }
    public uint ActiveMembers() { ACCOUNTING value; if(!QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero)||value.active>128) throw Refusal(); return value.active; }
    public void Terminate() { if(!TerminateJobObject(job,1)) throw Refusal(); }
    public void Dispose() { Dispose(null); }
    void Dispose(DesktopJobStartRecord diagnostic) {
        // Closing the sole job handle on wrapper death is a kernel containment
        // property, not external terminal evidence. Normal code verifies empty first.
        Exception cleanup=null;
        Action<Action> attempt=action=>{ try { action(); } catch(Exception error) { cleanup=error; } };
        // Request safe-handle release without FileStream.Dispose/Flush waits.
        // Active IO may defer native release; callers still require actual EOF
        // and terminal proof. Disposal alone never supplies that evidence.
        if(inputHandle!=null) attempt(()=>Observe(diagnostic,"dispose-input-safe",()=>inputHandle.Dispose()));
        if(outputHandle!=null) attempt(()=>Observe(diagnostic,"dispose-output-safe",()=>outputHandle.Dispose()));
        if(errorHandle!=null) attempt(()=>Observe(diagnostic,"dispose-error-safe",()=>errorHandle.Dispose()));
        if(process!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"close-process",()=>Close(ref process)));
        if(job!=IntPtr.Zero)attempt(()=>Observe(diagnostic,"close-job",()=>Close(ref job)));
        if(cleanup!=null) throw Refusal();
    }
}
'@
}
