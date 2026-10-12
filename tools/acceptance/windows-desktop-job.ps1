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
    static void ChildPipe(out IntPtr read,out IntPtr write) {
        var attributes=new SECURITY_ATTRIBUTES { length=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),inherit=true };
        if(!CreatePipe(out read,out write,ref attributes,4096)) throw Refusal();
    }
    static string Quote(string value) {
        // Both arguments are fixed file paths, not caller command fragments.
        if(String.IsNullOrEmpty(value)||value.IndexOf('"')>=0||value.IndexOf((char)0)>=0) throw Refusal();
        return "\""+value+"\"";
    }
    public static DesktopOwnedJob Start(string executable,string runner,string cwd,IDictionary environment,ulong commitLimitBytes) {
        if(commitLimitBytes<536870912||commitLimitBytes>2147483648) throw Refusal();
        var owned=new DesktopOwnedJob(); owned.CommitLimitBytes=commitLimitBytes;
        IntPtr inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,errorRead=IntPtr.Zero,errorWrite=IntPtr.Zero;
        IntPtr attributes=IntPtr.Zero,handleList=IntPtr.Zero,jobList=IntPtr.Zero,block=IntPtr.Zero,thread=IntPtr.Zero;
        bool initialized=false,success=false;
        try {
            // Null security attributes create a NONINHERITABLE, unnamed handle.
            // This wrapper holds the only job handle; it is absent from child whitelist.
            owned.job=CreateJobObject(IntPtr.Zero,null); if(owned.job==IntPtr.Zero) throw Refusal();
            if(!SetHandleInformation(owned.job,1,0)) throw Refusal();
            var limits=new EXTENDED_LIMIT(); limits.basic.flags=0x2208; // KILL_ON_JOB_CLOSE | JOB_MEMORY | ACTIVE_PROCESS
            limits.basic.active=128; limits.jobMemory=new UIntPtr(commitLimitBytes);
            IntPtr data=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(EXTENDED_LIMIT)));
            try { Marshal.StructureToPtr(limits,data,false); if(!SetInformationJobObject(owned.job,9,data,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) throw Refusal(); }
            finally { Marshal.FreeHGlobal(data); }
            ChildPipe(out inputRead,out inputWrite); ChildPipe(out outputRead,out outputWrite); ChildPipe(out errorRead,out errorWrite);
            if(!SetHandleInformation(inputWrite,1,0)||!SetHandleInformation(outputRead,1,0)||!SetHandleInformation(errorRead,1,0)) throw Refusal();
            UIntPtr attributeBytes=UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref attributeBytes);
            if(attributeBytes==UIntPtr.Zero||attributeBytes.ToUInt64()>65536) throw Refusal();
            attributes=Marshal.AllocHGlobal((int)attributeBytes.ToUInt64());
            if(!InitializeProcThreadAttributeList(attributes,2,0,ref attributeBytes)) throw Refusal(); initialized=true;
            handleList=Marshal.AllocHGlobal(IntPtr.Size*3);
            Marshal.WriteIntPtr(handleList,0,inputRead); Marshal.WriteIntPtr(handleList,IntPtr.Size,outputWrite); Marshal.WriteIntPtr(handleList,IntPtr.Size*2,errorWrite);
            if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(HANDLE_LIST),handleList,new UIntPtr((uint)(IntPtr.Size*3)),IntPtr.Zero,IntPtr.Zero)) throw Refusal();
            // Atomic creation in the job removes the parent-death gap between
            // CreateProcess and AssignProcessToJobObject. No uncontained suspended child.
            jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,owned.job);
            if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(JOB_LIST),jobList,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw Refusal();
            var entries=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            foreach(DictionaryEntry entry in environment) {
                string key=(string)entry.Key,value=(string)entry.Value;
                if(String.IsNullOrEmpty(key)||key.IndexOfAny(new char[]{'=', (char)0})>=0||value==null||value.IndexOf((char)0)>=0) throw Refusal();
                entries.Add(key,value);
            }
            var env=new StringBuilder(); foreach(var entry in entries) env.Append(entry.Key).Append('=').Append(entry.Value).Append((char)0); env.Append((char)0);
            if(env.Length>32767) throw Refusal(); block=Marshal.StringToHGlobalUni(env.ToString());
            var startup=new STARTUPINFOEX(); startup.startup.cb=Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.attributes=attributes;
            startup.startup.flags=STARTF_USESTDHANDLES; startup.startup.input=inputRead; startup.startup.output=outputWrite; startup.startup.error=errorWrite;
            PROCESS_INFORMATION info;
            if(!CreateProcess(executable,new StringBuilder(Quote(executable)+" "+Quote(runner)+" --desktop-owned"),IntPtr.Zero,IntPtr.Zero,true,
                CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,block,cwd,ref startup,out info)) throw Refusal();
            owned.process=info.process; thread=info.thread; owned.ProcessId=info.pid;
            bool inJob; if(!IsProcessInJob(owned.process,owned.job,out inJob)||!inJob) throw Refusal();
            owned.AssignedBeforeResume=true;
            Close(ref inputRead); Close(ref outputWrite); Close(ref errorWrite);
            owned.inputHandle=new SafeFileHandle(inputWrite,true); inputWrite=IntPtr.Zero;
            owned.outputHandle=new SafeFileHandle(outputRead,true); outputRead=IntPtr.Zero;
            owned.errorHandle=new SafeFileHandle(errorRead,true); errorRead=IntPtr.Zero;
            owned.Input=new FileStream(owned.inputHandle,FileAccess.Write,4096,false);
            owned.Output=new FileStream(owned.outputHandle,FileAccess.Read,4096,false);
            owned.Error=new FileStream(owned.errorHandle,FileAccess.Read,4096,false);
#if DESKTOP_JOB_PROOF
            if(BeforeResumeProof!=null) BeforeResumeProof(owned);
#endif
            if(ResumeThread(thread)!=1) throw Refusal(); Close(ref thread);
            success=true; return owned;
        } finally {
            var grace=Stopwatch.StartNew();
            Exception cleanup=null;
            Action<Action> attempt=action=>{ try { action(); } catch(Exception error) { cleanup=error; } };
            if(!success) {
                // Attempt every owned cleanup even if one operation is unknown.
                // Never resume a refused assignment or silently succeed on close.
                if(owned.job!=IntPtr.Zero) attempt(()=>{ if(!TerminateJobObject(owned.job,1)) throw Refusal(); });
                if(owned.process!=IntPtr.Zero) {
                    attempt(()=>{ if(!TerminateProcess(owned.process,1)&&WaitForSingleObject(owned.process,0)!=WAIT_OBJECT_0) throw Refusal(); });
                    attempt(()=>{ int remaining=(int)Math.Max(0,CleanupGraceMs-grace.ElapsedMilliseconds); if(!owned.WaitForExit(remaining)) throw Refusal(); });
                }
                attempt(()=>owned.Dispose());
            }
            attempt(()=>Close(ref thread)); attempt(()=>Close(ref inputRead)); attempt(()=>Close(ref inputWrite));
            attempt(()=>Close(ref outputRead)); attempt(()=>Close(ref outputWrite)); attempt(()=>Close(ref errorRead)); attempt(()=>Close(ref errorWrite));
            if(initialized) DeleteProcThreadAttributeList(attributes);
            if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes); if(handleList!=IntPtr.Zero) Marshal.FreeHGlobal(handleList); if(jobList!=IntPtr.Zero) Marshal.FreeHGlobal(jobList); if(block!=IntPtr.Zero) Marshal.FreeHGlobal(block);
            if(cleanup!=null) {
                if(success) {
                    attempt(()=>owned.Terminate());
                    attempt(()=>{ int remaining=(int)Math.Max(0,CleanupGraceMs-grace.ElapsedMilliseconds); if(!owned.WaitForExit(remaining)) throw Refusal(); });
                    attempt(()=>owned.Dispose());
                }
                throw Refusal();
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
        if(result==WAIT_OBJECT_0) return true; if(result==WAIT_TIMEOUT) return false; throw Refusal();
    }
    public int ExitCode { get { uint value; if(!WaitForExit(0)||!GetExitCodeProcess(process,out value)) throw Refusal(); return unchecked((int)value); } }
    public uint ActiveMembers() { ACCOUNTING value; if(!QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero)||value.active>128) throw Refusal(); return value.active; }
    public void Terminate() { if(!TerminateJobObject(job,1)) throw Refusal(); }
    public void Dispose() {
        // Closing the sole job handle on wrapper death is a kernel containment
        // property, not external terminal evidence. Normal code verifies empty first.
        Exception cleanup=null;
        Action<Action> attempt=action=>{ try { action(); } catch(Exception error) { cleanup=error; } };
        // Request safe-handle release without FileStream.Dispose/Flush waits.
        // Active IO may defer native release; callers still require actual EOF
        // and terminal proof. Disposal alone never supplies that evidence.
        if(inputHandle!=null) attempt(()=>inputHandle.Dispose());
        if(outputHandle!=null) attempt(()=>outputHandle.Dispose());
        if(errorHandle!=null) attempt(()=>errorHandle.Dispose());
        attempt(()=>Close(ref process)); attempt(()=>Close(ref job));
        if(cleanup!=null) throw Refusal();
    }
}
'@
}
