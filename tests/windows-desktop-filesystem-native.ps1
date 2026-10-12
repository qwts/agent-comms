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
$cases=[Collections.Generic.List[string]]::new()
$held=$null;$success=$false;$stage='initialize-shared-helper';$failure=$null;$probeState=$null
function Set-OwnedAcl($Path,$Rights=[Security.AccessControl.FileSystemRights]::FullControl,$Inheritance=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',$Propagation=[Security.AccessControl.PropagationFlags]::None,$Type=[Security.AccessControl.AccessControlType]::Allow) {
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,$Rights,$Inheritance,$Propagation,$Type))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Expect-Refusal($Name,[scriptblock]$Action) {
    $script:stage=$Name
    $refused=$false
    try {& $Action} catch {$refused=$true}
    if(-not $refused){throw 'boundary-refusal-missing'}
    $cases.Add($Name)
}
function Get-FixedFailure($Record) {
    $known=@('probe-path-refused','probe-terminal-unconfirmed','probe-eof-unconfirmed','probe-output-refused','probe-record-refused','held-leaf-renamed','held-ancestor-renamed','boundary-refusal-missing')
    $code='native-operation-failed'
    if($known -ccontains $Record.Exception.Message){$code=$Record.Exception.Message}
    return @{stage=$stage;code=$code;exceptionType=$Record.Exception.GetType().FullName;hresult=$Record.Exception.HResult}
}
function Move-Probe($Path) {
    $script:probeState=@{substage='validate-path';terminal=$false;eof=$false;exitCode=$null;stdoutLength=$null;stderrLength=$null;moved=$null;killRequested=$false;cleanupTerminal=$false}
    $shell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    foreach($value in @($PSCommandPath,$Root,$Path)){if($value.Contains('"')){throw 'probe-path-refused'}}
    $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$shell;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.Arguments='-NoLogo -NoProfile -NonInteractive -File "'+$PSCommandPath+'" -Root "'+$Root+'" -Mode move-probe -Probe "'+$Path+'"'
    $child=$null;$terminal=$false
    try {
        $script:probeState.substage='start-process'
        $child=[Diagnostics.Process]::Start($info)
        $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
        $script:probeState.substage='wait-terminal'
        $terminal=$child.WaitForExit(10000);$script:probeState.terminal=$terminal
        if($terminal){$script:probeState.exitCode=$child.ExitCode}
        if(-not $terminal){throw 'probe-terminal-unconfirmed'}
        $script:probeState.substage='wait-eof'
        $clock=[Diagnostics.Stopwatch]::StartNew()
        while((-not $stdout.IsCompleted -or -not $stderr.IsCompleted) -and $clock.ElapsedMilliseconds -lt 1000){[Threading.Thread]::Sleep(10)}
        if(-not $stdout.IsCompleted -or -not $stderr.IsCompleted){throw 'probe-eof-unconfirmed'}
        $script:probeState.eof=$true;$script:probeState.substage='validate-output'
        $out=$stdout.GetAwaiter().GetResult();$err=$stderr.GetAwaiter().GetResult()
        $script:probeState.stdoutLength=$out.Length;$script:probeState.stderrLength=$err.Length
        if($child.ExitCode -ne 0 -or $out.Length -gt 256 -or $err.Length -ne 0){throw 'probe-output-refused'}
        $script:probeState.substage='decode-record'
        $record=$out|ConvertFrom-Json
        if($record.v -ne 1 -or $record.moved -isnot [bool]){throw 'probe-record-refused'}
        $script:probeState.moved=$record.moved;$script:probeState.substage='record-complete'
        return $record.moved
    } finally {
        if($child){if(-not $terminal){try{$script:probeState.killRequested=$true;$child.Kill();$terminal=$child.WaitForExit(1000)}catch{}};$script:probeState.cleanupTerminal=$terminal;$child.Dispose()}
    }
}
try {
    $repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    . (Join-Path $repo 'tools/acceptance/windows-desktop-root.ps1')
    Initialize-DesktopRootHandle
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $stage='validate-scratch'
    $base=[IO.Path]::GetFullPath($Root)
    if(-not [IO.Directory]::Exists($base) -or (((Get-Item -LiteralPath $base -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'scratch-refused'}
    $stage='create-sibling-sentinel'
    $sentinel=Join-Path $base 'sibling-sentinel.txt';[IO.File]::WriteAllText($sentinel,'desktop-boundary-sibling-canary')
    $stage='hash-sibling-sentinel'
    $beforeHash=(Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
    $stage='read-sibling-acl'
    $sections=[Security.AccessControl.AccessControlSections]'Access,Owner,Group'
    $beforeAcl=(Get-Acl -LiteralPath $sentinel).GetSecurityDescriptorSddlForm($sections)
    $stage='create-owned-directories'
    $parent=Join-Path $base 'owned-parent';$leaf=Join-Path $parent 'leaf'
    $null=New-Item -ItemType Directory -Path $parent
    $null=New-Item -ItemType Directory -Path $leaf
    $stage='set-exact-owned-acl'
    Set-OwnedAcl $leaf
    $stage='open-held-chain'
    $held=Open-DesktopHeldChain $leaf
    $stage='assert-exact-owned-acl'
    Assert-DesktopRootAcl $leaf $sid;$cases.Add('exact-acl-and-held-chain')
    Expect-Refusal 'relative-root-placement' {Open-DesktopRootChain 'relative'}
    Expect-Refusal 'oversized-root-placement' {Open-DesktopRootChain ('C:\'+('x'*241))}
    $local=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    Expect-Refusal 'wrong-root-basename' {Open-DesktopRootChain (Join-Path $local 'not-desktop-root')}
    Expect-Refusal 'wrong-root-anchor' {Open-DesktopRootChain (Join-Path $base ('agent-comms-desktop-'+[Guid]::NewGuid().ToString('N')))}
    $stage='held-leaf-rename'
    if(Move-Probe $leaf){throw 'held-leaf-renamed'};$cases.Add('held-leaf-rename-refused')
    $stage='held-ancestor-rename'
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
    $stage='create-junction-target'
    $target=Join-Path $base 'junction-target';$null=New-Item -ItemType Directory -Path $target
    $stage='root-junction'
    $junction=Join-Path $base 'owned-junction';$null=New-Item -ItemType Junction -Path $junction -Target $target
    $refused=$false;try{$held=Open-DesktopHeldChain $junction}catch{$refused=$true}
    if($held){foreach($handle in $held){$handle.Dispose()};$held=$null}
    if(-not $refused){throw 'root-junction-accepted'};$cases.Add('root-junction')
    if(-not (Move-Probe $junction)){throw 'failed-junction-still-held'}
    [IO.Directory]::Move($junction+'-moved',$junction);$cases.Add('root-junction-failure-releases-handle')
    $stage='ancestor-junction'
    $nested=Join-Path $junction 'nested';$null=New-Item -ItemType Directory -Path $nested
    $refused=$false
    try{$held=Open-DesktopHeldChain $nested}catch{$refused=$true}
    if($held){foreach($handle in $held){$handle.Dispose()};$held=$null}
    if(-not $refused){throw 'ancestor-junction-accepted'};$cases.Add('ancestor-junction')
    # Rename after failure proves the successfully opened leaf handle released.
    [IO.Directory]::Move($nested,$nested+'-moved');$cases.Add('partial-chain-failure-releases-leaf')
    $stage='file-not-directory'
    $file=Join-Path $base 'not-directory';[IO.File]::WriteAllText($file,'inert')
    $refused=$false;try{$held=Open-DesktopHeldChain $file}catch{$refused=$true}
    if($held){foreach($handle in $held){$handle.Dispose()};$held=$null}
    if(-not $refused){throw 'file-accepted-as-directory'};$cases.Add('file-not-directory')
    [IO.File]::Move($file,$file+'-moved');$cases.Add('file-failure-releases-handle')
    $stage='verify-sibling'
    if((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -cne $beforeHash -or (Get-Acl -LiteralPath $sentinel).GetSecurityDescriptorSddlForm($sections) -cne $beforeAcl){throw 'sibling-changed'}
    $cases.Add('sibling-content-and-acl-unchanged');$success=$true
} catch {$success=$false;$failure=Get-FixedFailure $_}
finally {
    if($held){foreach($handle in $held){try{$handle.Dispose()}catch{$success=$false;$failure=@{stage='close-held-chain';exceptionType=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult}}}}
    # Deliberately retain all owned scratch, including safe junction targets.
    $json=@{v=1;status=$(if($success){'passed'}else{'failed'});cases=$cases.ToArray();failure=$failure;probe=$probeState;rootRetained=$true;profileAttested=$false;downloadInvoked=$false}|ConvertTo-Json -Depth 3 -Compress
    $bytes=[Text.Encoding]::UTF8.GetBytes($json);if($bytes.Length -gt 4096){throw 'boundary-receipt-bound'}
    $receipt=[IO.File]::Open((Join-Path $Root 'filesystem.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$receipt.Write($bytes,0,$bytes.Length)}finally{$receipt.Dispose()}
}
if(-not $success){exit 1}
