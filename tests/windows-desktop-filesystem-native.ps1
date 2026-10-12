# Inert scratch-only boundary checks. Never invokes profile/bootstrap/download.
param([Parameter(Mandatory)][string]$Root,
    [ValidateSet('main','move-probe')][string]$Mode='main',[string]$Probe)
$ErrorActionPreference='Stop'
if($Mode -eq 'move-probe') {
    try {
        $prefix=[IO.Path]::GetFullPath($Root).TrimEnd('\')+'\'
        $full=[IO.Path]::GetFullPath($Probe)
        if(-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'probe-scope-refused'}
        [IO.Directory]::Move($full,$full+'-moved')
        [Console]::Out.WriteLine('{"v":1,"moved":true}')
    } catch {[Console]::Out.WriteLine('{"v":1,"moved":false}')}
    exit 0
}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'tools/acceptance/windows-desktop-root.ps1')
Initialize-DesktopRootHandle
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$cases=[Collections.Generic.List[string]]::new()
$held=$null;$success=$false
function Set-OwnedAcl($Path,$Rights=[Security.AccessControl.FileSystemRights]::FullControl,$Inheritance=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',$Propagation=[Security.AccessControl.PropagationFlags]::None,$Type=[Security.AccessControl.AccessControlType]::Allow) {
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,$Rights,$Inheritance,$Propagation,$Type))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Expect-Refusal($Name,[scriptblock]$Action) {
    $refused=$false
    try {& $Action} catch {$refused=$true}
    if(-not $refused){throw 'boundary-refusal-missing'}
    $cases.Add($Name)
}
function Move-Probe($Path) {
    $shell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    foreach($value in @($PSCommandPath,$Root,$Path)){if($value.Contains('"')){throw 'probe-path-refused'}}
    $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$shell;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.Arguments='-NoLogo -NoProfile -NonInteractive -File "'+$PSCommandPath+'" -Root "'+$Root+'" -Mode move-probe -Probe "'+$Path+'"'
    $child=$null;$terminal=$false
    try {
        $child=[Diagnostics.Process]::Start($info)
        $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
        $terminal=$child.WaitForExit(10000)
        if(-not $terminal){throw 'probe-terminal-unconfirmed'}
        $clock=[Diagnostics.Stopwatch]::StartNew()
        while((-not $stdout.IsCompleted -or -not $stderr.IsCompleted) -and $clock.ElapsedMilliseconds -lt 1000){[Threading.Thread]::Sleep(10)}
        if(-not $stdout.IsCompleted -or -not $stderr.IsCompleted){throw 'probe-eof-unconfirmed'}
        $out=$stdout.GetAwaiter().GetResult();$err=$stderr.GetAwaiter().GetResult()
        if($child.ExitCode -ne 0 -or $out.Length -gt 256 -or $err.Length -ne 0){throw 'probe-output-refused'}
        $record=$out|ConvertFrom-Json
        if($record.v -ne 1 -or $record.moved -isnot [bool]){throw 'probe-record-refused'}
        return $record.moved
    } finally {
        if($child){if(-not $terminal){try{$child.Kill();$terminal=$child.WaitForExit(1000)}catch{}};$child.Dispose()}
    }
}
try {
    $base=[IO.Path]::GetFullPath($Root)
    if(-not [IO.Directory]::Exists($base) -or (((Get-Item -LiteralPath $base -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'scratch-refused'}
    $sentinel=Join-Path $base 'sibling-sentinel.txt';[IO.File]::WriteAllText($sentinel,'desktop-boundary-sibling-canary')
    $beforeHash=(Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
    $sections=[Security.AccessControl.AccessControlSections]'Access,Owner,Group'
    $beforeAcl=(Get-Acl -LiteralPath $sentinel).GetSecurityDescriptorSddlForm($sections)
    $parent=Join-Path $base 'owned-parent';$leaf=Join-Path $parent 'leaf'
    $null=New-Item -ItemType Directory -Path $parent
    $null=New-Item -ItemType Directory -Path $leaf
    Set-OwnedAcl $leaf
    $held=Open-DesktopHeldChain $leaf
    Assert-DesktopRootAcl $leaf $sid;$cases.Add('exact-acl-and-held-chain')
    Expect-Refusal 'relative-root-placement' {Open-DesktopRootChain 'relative'}
    Expect-Refusal 'oversized-root-placement' {Open-DesktopRootChain ('C:\'+('x'*241))}
    $local=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    Expect-Refusal 'wrong-root-basename' {Open-DesktopRootChain (Join-Path $local 'not-desktop-root')}
    Expect-Refusal 'wrong-root-anchor' {Open-DesktopRootChain (Join-Path $base ('agent-comms-desktop-'+[Guid]::NewGuid().ToString('N')))}
    if(Move-Probe $leaf){throw 'held-leaf-renamed'};$cases.Add('held-leaf-rename-refused')
    if(Move-Probe $parent){throw 'held-ancestor-renamed'};$cases.Add('held-ancestor-rename-refused')
    Expect-Refusal 'held-leaf-delete-refused' {[IO.Directory]::Delete($leaf)}
    foreach($handle in $held){$handle.Dispose()};$held=$null
    if(-not (Move-Probe $leaf)){throw 'released-leaf-still-held'}
    [IO.Directory]::Move($leaf+'-moved',$leaf);$cases.Add('released-leaf-rename-works')
    if(-not (Move-Probe $parent)){throw 'released-parent-still-held'}
    [IO.Directory]::Move($parent+'-moved',$parent);$cases.Add('released-ancestor-rename-works')
    Expect-Refusal 'wrong-expected-owner' {Assert-DesktopRootAcl $leaf $everyone}
    $acl=Get-Acl -LiteralPath $leaf
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $leaf -AclObject $acl
    Expect-Refusal 'extra-ace' {Assert-DesktopRootAcl $leaf $sid}
    Set-OwnedAcl $leaf ([Security.AccessControl.FileSystemRights]::Modify)
    Expect-Refusal 'weaker-rights' {Assert-DesktopRootAcl $leaf $sid}
    Set-OwnedAcl $leaf ([Security.AccessControl.FileSystemRights]::FullControl) ([Security.AccessControl.InheritanceFlags]::None)
    Expect-Refusal 'wrong-inheritance' {Assert-DesktopRootAcl $leaf $sid}
    Set-OwnedAcl $leaf ([Security.AccessControl.FileSystemRights]::FullControl) ([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit') ([Security.AccessControl.PropagationFlags]::InheritOnly)
    Expect-Refusal 'wrong-propagation' {Assert-DesktopRootAcl $leaf $sid}
    Set-OwnedAcl $leaf ([Security.AccessControl.FileSystemRights]::WriteData) ([Security.AccessControl.InheritanceFlags]::None) ([Security.AccessControl.PropagationFlags]::None) ([Security.AccessControl.AccessControlType]::Deny)
    Expect-Refusal 'deny-ace' {Assert-DesktopRootAcl $leaf $sid}
    Set-OwnedAcl $leaf
    $acl=Get-Acl -LiteralPath $leaf;$acl.SetAccessRuleProtection($false,$true);Set-Acl -LiteralPath $leaf -AclObject $acl
    Expect-Refusal 'unprotected-dacl' {Assert-DesktopRootAcl $leaf $sid}
    Set-OwnedAcl $leaf
    # Mutating only this owned ACL is possible despite no-delete handles. A
    # fresh check must reject; held handles never claim ACL immutability.
    $held=Open-DesktopHeldChain $leaf
    Set-OwnedAcl $leaf ([Security.AccessControl.FileSystemRights]::Modify)
    Expect-Refusal 'fresh-acl-change-refused' {Assert-DesktopRootAcl $leaf $sid}
    Set-OwnedAcl $leaf
    foreach($handle in $held){$handle.Dispose()};$held=$null
    $target=Join-Path $base 'junction-target';$null=New-Item -ItemType Directory -Path $target
    $junction=Join-Path $base 'owned-junction';$null=New-Item -ItemType Junction -Path $junction -Target $target
    $refused=$false;try{$held=Open-DesktopHeldChain $junction}catch{$refused=$true}
    if($held){foreach($handle in $held){$handle.Dispose()};$held=$null}
    if(-not $refused){throw 'root-junction-accepted'};$cases.Add('root-junction')
    if(-not (Move-Probe $junction)){throw 'failed-junction-still-held'}
    [IO.Directory]::Move($junction+'-moved',$junction);$cases.Add('root-junction-failure-releases-handle')
    $nested=Join-Path $junction 'nested';$null=New-Item -ItemType Directory -Path $nested
    $refused=$false
    try{$held=Open-DesktopHeldChain $nested}catch{$refused=$true}
    if($held){foreach($handle in $held){$handle.Dispose()};$held=$null}
    if(-not $refused){throw 'ancestor-junction-accepted'};$cases.Add('ancestor-junction')
    # Rename after failure proves the successfully opened leaf handle released.
    [IO.Directory]::Move($nested,$nested+'-moved');$cases.Add('partial-chain-failure-releases-leaf')
    $file=Join-Path $base 'not-directory';[IO.File]::WriteAllText($file,'inert')
    $refused=$false;try{$held=Open-DesktopHeldChain $file}catch{$refused=$true}
    if($held){foreach($handle in $held){$handle.Dispose()};$held=$null}
    if(-not $refused){throw 'file-accepted-as-directory'};$cases.Add('file-not-directory')
    [IO.File]::Move($file,$file+'-moved');$cases.Add('file-failure-releases-handle')
    if((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -cne $beforeHash -or (Get-Acl -LiteralPath $sentinel).GetSecurityDescriptorSddlForm($sections) -cne $beforeAcl){throw 'sibling-changed'}
    $cases.Add('sibling-content-and-acl-unchanged');$success=$true
} catch {$success=$false}
finally {
    if($held){foreach($handle in $held){try{$handle.Dispose()}catch{$success=$false}}}
    # Deliberately retain all owned scratch, including safe junction targets.
    $json=@{v=1;status=$(if($success){'passed'}else{'failed'});cases=$cases.ToArray();rootRetained=$true;profileAttested=$false;downloadInvoked=$false}|ConvertTo-Json -Depth 3 -Compress
    $bytes=[Text.Encoding]::UTF8.GetBytes($json);if($bytes.Length -gt 4096){throw 'boundary-receipt-bound'}
    $receipt=[IO.File]::Open((Join-Path $Root 'filesystem.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$receipt.Write($bytes,0,$bytes.Length)}finally{$receipt.Dispose()}
}
if(-not $success){exit 1}
