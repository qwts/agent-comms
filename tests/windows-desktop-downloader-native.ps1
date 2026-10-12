# Deterministic shared-transfer proof. No network, profile, bootstrap or URL override.
param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference='Stop'
# Avoid implicit classic-shell module discovery in this inert owner.
foreach($name in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility')) {
    Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules',$name,($name+'.psd1'))) -ErrorAction Stop
}
$cases=[Collections.Generic.List[string]]::new();$stage='initialize';$passed=$false;$failure=$null
try {
    $helper=[IO.Path]::Combine($PSScriptRoot,'..','tools','acceptance','windows-desktop-root.ps1')
    . $helper
    Initialize-DesktopRootHandle
    if([DesktopRootHandle].GetMethod('ProveNodeArchive')){throw 'normal-proof-entrypoint-present'}
    $cases.Add('normal-proof-entrypoint-absent')
    # Exact embedded C# is compiled a second time with only a distinct type name
    # and proof symbol. No copied transfer implementation or alternate downloader.
    $source=[IO.File]::ReadAllText($helper)
    $start=$source.IndexOf("using System; using System.IO;")
    $end=$source.IndexOf("`n'@",$start)
    if($start -lt 0 -or $end -lt $start){throw 'source-anchor-refused'}
    $native=$source.Substring($start,$end-$start).Replace('public static class DesktopRootHandle {','public static class DesktopDownloadProof {')
    Add-Type -TypeDefinition ("#define DESKTOP_DOWNLOAD_PROOF`n"+$native)
    Add-Type -TypeDefinition @'
using System; using System.IO; using System.Threading; using System.Threading.Tasks;
public sealed class DesktopDownloadStream:Stream {
 readonly long length; readonly bool fail; long position;
 public bool Disposed; public long ReadBytes { get {return position;} }
 public DesktopDownloadStream(long size,bool readFailure) {length=size;fail=readFailure;}
 public override bool CanRead {get{return true;}} public override bool CanSeek {get{return false;}} public override bool CanWrite {get{return false;}}
 public override long Length {get{return length;}} public override long Position {get{return position;}set{throw new NotSupportedException();}}
 public override int Read(byte[] b,int o,int n) {if(fail)throw new IOException("proof-read-refused");int take=(int)Math.Min(n,length-position);for(int i=0;i<take;i++)b[o+i]=(byte)((position+i)%251);position+=take;return take;}
 public override Task<int> ReadAsync(byte[] b,int o,int n,CancellationToken token) {token.ThrowIfCancellationRequested();return Task.FromResult(Read(b,o,n));}
 protected override void Dispose(bool disposing){Disposed=true;base.Dispose(disposing);}
 public static bool VerifyFile(string path,long size,string digest) {
  using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.None)) {
   if(file.Length!=size)return false;
   using(var hash=System.Security.Cryptography.SHA256.Create()) {
    if(BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant()!=digest)return false;
   }
   file.Position=0;byte[] bytes=new byte[65536];long seen=0;int read;
   while((read=file.Read(bytes,0,bytes.Length))>0) {
    for(int i=0;i<read;i++)if(bytes[i]!=(byte)((seen+i)%251))return false;
    seen+=read;
   }
   return seen==size;
  }
 }
 public override void Flush(){} public override long Seek(long n,SeekOrigin o){throw new NotSupportedException();}
 public override void SetLength(long n){throw new NotSupportedException();} public override void Write(byte[] b,int o,int n){throw new NotSupportedException();}
}
'@
    $base=[IO.Path]::GetFullPath($Root)
    if(-not [IO.Directory]::Exists($base) -or (([IO.File]::GetAttributes($base) -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'scratch-refused'}
    $sentinel=[IO.Path]::Combine($base,'sibling.txt');[IO.File]::WriteAllText($sentinel,'downloader-sibling-canary')
    $sentinelAcl=[IO.File]::GetAccessControl($sentinel).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
    function Run-Case($Name,[long]$Size,[long]$Declared,[int]$Status,[string]$Encoding,[bool]$ReadFailure,[bool]$Success,[bool]$Collision) {
        $script:stage=$Name
        $destination=[IO.Path]::Combine($base,$Name+'.zip')
        if($Collision){[IO.File]::WriteAllText($destination,'existing-canary')}
        $acl=if($Collision){[IO.File]::GetAccessControl($destination).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)}else{$null}
        $stream=[DesktopDownloadStream]::new($Size,$ReadFailure);$refused=$false;$digest=$null;$task=$null;$reason=$null
        try {
            $task=[DesktopDownloadProof]::ProveNodeArchive($stream,$Declared,$Status,$Encoding,$destination,[Threading.CancellationToken]::None)
            # Only completed tasks are consumed. The JS owner supplies a hard outer
            # process deadline; timeout never synchronously disposes pending IO.
            if(-not $task.Wait(10000)){throw 'proof-task-terminal-unconfirmed'}
            $digest=$task.GetAwaiter().GetResult()
        } catch {
            if($task -and -not $task.IsCompleted){throw 'proof-task-terminal-unconfirmed'}
            $reason=$_.Exception.GetBaseException().Message;$refused=$true
        }
        if($Success) {
            if($refused -or $digest -notmatch '^[a-f0-9]{64}$'){throw 'proof-success-missing'}
            if(([IO.FileInfo]::new($destination)).Length -ne $Size){throw 'proof-length-refused'}
            if(-not [DesktopDownloadStream]::VerifyFile($destination,$Size,$digest) -or $stream.ReadBytes -ne $Size){throw 'proof-content-hash-refused'}
        } else {
            if(-not $refused){throw 'proof-refusal-missing'}
            $expectedReason=if($ReadFailure){'proof-read-refused'}else{'desktop-node-refused'}
            if($reason -cne $expectedReason){throw 'proof-unexpected-refusal'}
            if($Collision) {
                if([IO.File]::ReadAllText($destination) -cne 'existing-canary' -or [IO.File]::GetAccessControl($destination).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All) -cne $acl){throw 'proof-collision-mutated'}
            } elseif([IO.File]::Exists($destination)){throw 'proof-failed-file-retained'}
        }
        if(-not $stream.Disposed){throw 'proof-response-close-missing'}
        $cases.Add($Name)
    }
    Run-Case 'success-known-length' 100003 100003 200 'identity' $false $true $false
    Run-Case 'success-unknown-length' 100003 -1 200 '' $false $true $false
    Run-Case 'success-exact-cap' 134217728 134217728 200 '' $false $true $false
    Run-Case 'invalid-negative-length-refused' 1 -2 200 '' $false $false $false
    Run-Case 'status-refused' 1 1 302 '' $false $false $false
    Run-Case 'encoding-refused' 1 1 200 'gzip' $false $false $false
    Run-Case 'declared-zero-refused' 0 0 200 '' $false $false $false
    Run-Case 'declared-over-cap-refused' 1 134217729 200 '' $false $false $false
    Run-Case 'empty-unknown-refused' 0 -1 200 '' $false $false $false
    Run-Case 'short-body-refused' 17 18 200 '' $false $false $false
    Run-Case 'long-body-refused' 18 17 200 '' $false $false $false
    Run-Case 'read-failure-deleted' 17 -1 200 '' $true $false $false
    Run-Case 'unknown-over-cap-deleted' 134217729 -1 200 '' $false $false $false
    Run-Case 'create-new-collision-preserved' 17 17 200 '' $false $false $true
    $stage='sibling-preserved'
    if([IO.File]::ReadAllText($sentinel) -cne 'downloader-sibling-canary' -or [IO.File]::GetAccessControl($sentinel).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All) -cne $sentinelAcl){throw 'sibling-mutated'}
    $cases.Add($stage);$passed=$true
} catch {$failure=@{stage=$stage;exceptionType=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult}}
@{v=1;status=$(if($passed){'passed'}else{'failed'});cases=@($cases);failure=$failure;networkInvoked=$false;rootRetained=$true;nativeCloseProven=$false;httpAbortProven=$false}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath ([IO.Path]::Combine($Root,'downloader.json')) -Encoding UTF8
if(-not $passed){exit 1}
