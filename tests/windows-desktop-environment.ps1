# Classic managed regression. No valid Start, P/Invoke, profile or account operations.
param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference='Stop'
foreach($name in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility')) {
    Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules',$name,($name+'.psd1'))) -ErrorAction Stop
}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source=[IO.File]::ReadAllText((Join-Path $repo 'tools/acceptance/windows-desktop-job.ps1'))
$start=$source.IndexOf('using System;');$end=$source.IndexOf("`n'@",$start)
if($start -lt 0 -or $end -lt $start){throw 'environment-source-anchor-refused'}
$fixture=@'
public static class DesktopEnvironmentFixture {
 public static string Serialize(System.Collections.IDictionary values){return DesktopOwnedJob.BuildEnvironment(values);}
 public static bool StringEntries(System.Collections.IDictionary values){
  foreach(System.Collections.DictionaryEntry entry in values)if(!(entry.Key is string)||!(entry.Value is string))return false;
  return true;
 }
}
'@
Add-Type -TypeDefinition ($source.Substring($start,$end-$start)+"`n"+$fixture)
$cases=[Collections.Generic.List[string]]::new()
# Exact original cmdlet-result insertion, sent through the SAME serializer.
$legacy=@{};$legacy['TEMP']=Join-Path $Root 'temp';$legacy['TMP']=Join-Path $Root 'temp'
$legacyRefused=$false
try {$null=[DesktopEnvironmentFixture]::Serialize($legacy)}catch{
    if($_.Exception.GetBaseException().GetType() -ne [InvalidCastException]){throw 'legacy-unexpected-failure'}
    $legacyRefused=$true
}
if(-not $legacyRefused){throw 'legacy-cast-not-reproduced'}
$cases.Add('original-join-path-invalid-cast-reproduced')
# Execute only the reviewed wrapper's fixed map-construction slice. This keeps
# the regression tied to actual insertion code without launching its entrypoint.
$wrapper=[IO.File]::ReadAllText((Join-Path $repo 'scripts/windows-desktop-acceptance.ps1'))
$begin=$wrapper.IndexOf('    $allowed = @(');$finish=$wrapper.IndexOf('    $memory = ',$begin)
if($begin -lt 0 -or $finish -le $begin -or $wrapper.IndexOf('    $allowed = @(',$begin+1) -ge 0){throw 'wrapper-environment-anchor-refused'}
$build=[scriptblock]::Create('param($root)'+"`n"+$wrapper.Substring($begin,$finish-$begin)+"`nreturn ,`$clean")
$fixed=& $build $Root
if(-not [DesktopEnvironmentFixture]::StringEntries($fixed)){throw 'typed-map-not-strings'}
$block=[DesktopEnvironmentFixture]::Serialize($fixed)
if(-not $block.EndsWith("`0`0") -or $block.Length -gt 32767){throw 'typed-block-refused'}
$expectedTemp=[string](Join-Path $Root 'temp')
if($fixed['TEMP'] -cne $expectedTemp -or $fixed['TMP'] -cne $expectedTemp){throw 'typed-temp-changed'}
$allowed=@('PATH','SystemRoot','WINDIR','COMSPEC','USERPROFILE','LOCALAPPDATA','APPDATA','USERNAME','USERDOMAIN','USERDNSDOMAIN','PROCESSOR_ARCHITECTURE','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)','TEMP','TMP')
foreach($key in $fixed.Keys){if($allowed -cnotcontains $key){throw 'environment-allowlist-expanded'}}
$cases.Add('actual-wrapper-typed-map-admitted');$cases.Add('fixed-temp-tmp-and-allowlist-preserved')
function Refused($Name,$Values) {
    $refused=$false
    try {$null=[DesktopEnvironmentFixture]::Serialize($Values)}catch{$refused=$true}
    if(-not $refused){throw 'strict-environment-refusal-missing'}
    $cases.Add($Name)
}
Refused 'non-string-value-refused' @{TEMP=1}
Refused 'non-string-key-refused' @{1='value'}
Refused 'empty-key-refused' @{''='value'}
Refused 'equals-key-refused' @{'A=B'='value'}
Refused 'nul-key-refused' @{("A`0B")='value'}
Refused 'nul-value-refused' @{A="B`0C"}
Refused 'null-value-refused' @{A=$null}
Refused 'oversized-block-refused' @{A=('x'*32766)}
$ordered=[DesktopEnvironmentFixture]::Serialize(@{Z='last';A='first'})
if($ordered -cne "A=first`0Z=last`0`0"){throw 'environment-order-changed'}
$cases.Add('ordinal-ignore-case-order-and-double-nul-preserved')
$json=@{v=1;status='passed';cases=@($cases);nativeInvoked=$false;processCreated=$false;rootRetained=$true}|ConvertTo-Json -Depth 4 -Compress
if([Text.Encoding]::UTF8.GetByteCount($json) -gt 2048){throw 'environment-receipt-bound'}
[IO.File]::WriteAllText((Join-Path $Root 'environment.json'),$json)
