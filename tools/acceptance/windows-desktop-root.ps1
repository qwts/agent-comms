# Shared desktop root/token verification. Dot-sourced wrapper holds returned
# handles until its exact Node child is terminal; verification mode never writes.
[CmdletBinding()]
param([string]$VerifyRoot,[int]$NodePid,[int]$WrapperPid)
$ErrorActionPreference = 'Stop'
function Assert-DesktopProfile {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'desktop-standard-user-required' }
    if ($identity.Owner.Value -ne $identity.User.Value) { throw 'desktop-owner-refused' }
    $profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if (-not $profile -or -not $local -or $env:USERPROFILE -ne $profile -or $env:LOCALAPPDATA -ne $local -or $env:USERNAME -ne $identity.Name.Split('\')[-1]) { throw 'desktop-profile-refused' }
    if (-not (Test-Path -LiteralPath ('Registry::HKEY_USERS\' + $identity.User.Value))) { throw 'desktop-profile-refused' }
    return $identity.User
}
# Type initialization alone performs no profile/root attestation or IO.
function Initialize-DesktopRootHandle {
    if (-not ('DesktopRootHandle' -as [type])) {
        Add-Type -TypeDefinition @'
using System; using System.IO; using System.Threading.Tasks; using System.Threading; using System.Net; using System.Security.Cryptography; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class DesktopRootHandle {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
 public static async Task<bool> Pump(Stream input,Stream output) { byte[] b=new byte[4096]; int total=0,n; while((n=await input.ReadAsync(b,0,b.Length))>0) { if(total>1048576-n) return false; await output.WriteAsync(b,0,n); total+=n; } await output.FlushAsync(); return true; }
 [StructLayout(LayoutKind.Sequential)] struct FILE_DISPOSITION_INFO { public byte deleteFile; }
 [DllImport("kernel32.dll",SetLastError=true)]
 static extern bool SetFileInformationByHandle(SafeFileHandle file,int kind,ref FILE_DISPOSITION_INFO info,uint size);
 public const long NodeArchiveByteCap=134217728;
 public const int NodeArchiveDeadlineMs=60000;
 public static async Task<string> DownloadNodeArchive(string version,string destination) {
  if(!System.Text.RegularExpressions.Regex.IsMatch(version??"",@"^\d{1,6}\.\d{1,6}\.\d{1,6}$")) throw new Exception("desktop-node-refused");
  var request=(HttpWebRequest)WebRequest.Create("https://nodejs.org/dist/v"+version+"/node-v"+version+"-win-x64.zip");
  request.AllowAutoRedirect=false; request.AutomaticDecompression=DecompressionMethods.None;
  request.Timeout=NodeArchiveDeadlineMs; request.ReadWriteTimeout=NodeArchiveDeadlineMs;
  SafeFileHandle file=null; FileStream output=null; HttpWebResponse response=null; Stream input=null; bool success=false;
  using(var cancel=new CancellationTokenSource(NodeArchiveDeadlineMs))
  using(cancel.Token.Register(()=>{ try { request.Abort(); } catch { } })) {
   try {
    response=(HttpWebResponse)await request.GetResponseAsync().ConfigureAwait(false);
    cancel.Token.ThrowIfCancellationRequested();
    if(response.StatusCode!=HttpStatusCode.OK||response.ContentLength>NodeArchiveByteCap||response.ContentLength==0
      ||(!String.IsNullOrEmpty(response.ContentEncoding)&&!String.Equals(response.ContentEncoding,"identity",StringComparison.OrdinalIgnoreCase))) throw new Exception("desktop-node-refused");
    // CREATE_NEW, no sharing, and DELETE access. The sole owned handle permits
    // handle-based failed-download deletion without a close/name replacement race.
    file=CreateFile(destination,0xC0010000,0,IntPtr.Zero,1,0x80,IntPtr.Zero);
    if(file.IsInvalid) throw new Exception("desktop-node-refused");
    output=new FileStream(file,FileAccess.ReadWrite,65536,false);
    input=response.GetResponseStream(); if(input==null) throw new Exception("desktop-node-refused");
    byte[] bytes=new byte[65536]; long total=0;
    for(;;) {
     cancel.Token.ThrowIfCancellationRequested();
     // At most one byte beyond the remaining cap may be read to detect overflow;
     // no over-cap byte is written and no full response is buffered.
     int count=(int)Math.Min(bytes.Length,NodeArchiveByteCap-total+1);
     int read=await input.ReadAsync(bytes,0,count,cancel.Token).ConfigureAwait(false);
     cancel.Token.ThrowIfCancellationRequested();
     if(read==0) break;
     if(total>NodeArchiveByteCap-read) throw new Exception("desktop-node-refused");
     await output.WriteAsync(bytes,0,read,cancel.Token).ConfigureAwait(false); total+=read;
    }
    if(total==0||(response.ContentLength>=0&&total!=response.ContentLength)) throw new Exception("desktop-node-refused");
    await output.FlushAsync(cancel.Token).ConfigureAwait(false); output.Position=0;
    string digest; using(var hash=SHA256.Create()) { digest=BitConverter.ToString(hash.ComputeHash(output)).Replace("-","").ToLowerInvariant(); }
    cancel.Token.ThrowIfCancellationRequested(); success=true; return digest;
   } finally {
    bool cleanupFailed=false;
    // Abort cancels outstanding request work; no detached downloader is spawned.
    try { request.Abort(); } catch { cleanupFailed=true; }
    if(input!=null) { try { input.Dispose(); } catch { cleanupFailed=true; } }
    if(response!=null) { try { response.Close(); } catch { cleanupFailed=true; } }
    if(!success&&file!=null&&!file.IsInvalid&&!file.IsClosed) {
     var disposition=new FILE_DISPOSITION_INFO { deleteFile=1 };
     if(!SetFileInformationByHandle(file,4,ref disposition,1)) cleanupFailed=true;
    }
    if(output!=null) { try { output.Dispose(); } catch { cleanupFailed=true; } }
    if(file!=null) { try { file.Dispose(); } catch { cleanupFailed=true; } }
    if(cleanupFailed) throw new Exception("desktop-node-cleanup-unconfirmed");
   }
  }
 }
 public static SafeFileHandle Open(string p) { var h=CreateFile(p,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero); if(h.IsInvalid) throw new Exception("desktop-root-refused"); return h; }
}
'@
    }
}
# Private filesystem checks. These do NOT attest a profile or issue context.
function Open-DesktopHeldChain([string]$Full) {
    $handles = [Collections.Generic.List[IDisposable]]::new()
    try {
        $walk = $full
        while ($walk) {
            $handle = [DesktopRootHandle]::Open($walk); $handles.Add($handle)
            $item = Get-Item -LiteralPath $walk -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'desktop-root-refused' }
            $parent = [IO.Directory]::GetParent($walk)
            $walk = if ($parent) { $parent.FullName } else { $null }
        }
        return ,$handles
    } catch { foreach ($handle in $handles) { $handle.Dispose() }; throw }
}
function Assert-DesktopRootAcl([string]$Full,[Security.Principal.SecurityIdentifier]$Sid) {
        $acl = Get-Acl -LiteralPath $full
        if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'desktop-acl-refused' }
        $rules = @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].IsInherited -or $rules[0].InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' -or $rules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'desktop-acl-refused' }
}
function Open-DesktopRootChain([string]$Root) {
    if ($Root.Length -gt 240 -or -not [IO.Path]::IsPathRooted($Root)) { throw 'desktop-root-refused' }
    $local = [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)).TrimEnd('\')
    $full = [IO.Path]::GetFullPath($Root)
    if ([IO.Path]::GetDirectoryName($full) -ine $local -or [IO.Path]::GetFileName($full) -cnotmatch '^agent-comms-desktop-[a-f0-9]{32}$') { throw 'desktop-root-refused' }
    Initialize-DesktopRootHandle
    $handles = Open-DesktopHeldChain $full
    try {
        $sid = Assert-DesktopProfile
        Assert-DesktopRootAcl $full $sid
        return ,$handles
    } catch { foreach ($handle in $handles) { $handle.Dispose() }; throw }
}
if ($VerifyRoot) {
    $held = $null
    try {
        $null = Assert-DesktopProfile
        $held = Open-DesktopRootChain $VerifyRoot
        $node = Get-CimInstance Win32_Process -Filter "ProcessId=$NodePid" -OperationTimeoutSec 2
        if (-not $node -or $node.ParentProcessId -ne $WrapperPid -or $WrapperPid -le 0) { throw 'desktop-parent-refused' }
        @{v=1;administrator=$false;defaultOwnerMatches=$true;profileLoaded=$true;profileMatches=$true;rootVerified=$true;parentMatches=$true} | ConvertTo-Json -Compress
    } finally { if ($held) { foreach ($handle in $held) { $handle.Dispose() } } }
}
