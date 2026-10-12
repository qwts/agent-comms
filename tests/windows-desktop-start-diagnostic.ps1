# Inert record/projection tests. No Start with valid limits or native calls.
param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference='Stop'
foreach($name in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility')) {
    Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules',$name,($name+'.psd1'))) -ErrorAction Stop
}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $repo 'tools/acceptance/windows-desktop-start-diagnostic.ps1')
$source=[IO.File]::ReadAllText((Join-Path $repo 'tools/acceptance/windows-desktop-job.ps1'))
$start=$source.IndexOf('using System;');$end=$source.IndexOf("`n'@",$start)
if($start -lt 0 -or $end -lt $start){throw 'diagnostic-source-anchor-refused'}
$fixture=@'
public static class DesktopStartRecordFixture {
 public static DesktopJobStartRecord Build() {
  var record=new DesktopJobStartRecord();
  record.Failure("create-suspended",new DesktopJobNativeFailure(5));
  record.Failure("resume",new System.Exception("private-first-overwrite-canary"));
  record.Cleanup("terminate-job",new DesktopJobNativeFailure(6));
  record.Cleanup("close-process",null);
  record.Cleanup("close-job",new System.Exception("private-cleanup-overwrite-canary"));
  return record;
 }
 public static DesktopJobStartRecord PrimaryAndBufferCleanup() {
  var record=new DesktopJobStartRecord();
  record.Failure("set-job-limits",new DesktopJobNativeFailure(5));
  var error=new DesktopJobNativeFailure(6);record.Cleanup("free-limit-buffer",error);record.CleanupFailure(error);return record;
 }
 public static object Forge(string name,bool failure) {
  var assembly=System.AppDomain.CurrentDomain.DefineDynamicAssembly(new System.Reflection.AssemblyName("DesktopDiagnosticForgery"+System.Guid.NewGuid().ToString("N")),System.Reflection.Emit.AssemblyBuilderAccess.Run);
  var module=assembly.DefineDynamicModule("proof");
  var type=module.DefineType(name,System.Reflection.TypeAttributes.Public,failure?typeof(System.Exception):typeof(object));
  type.DefineDefaultConstructor(System.Reflection.MethodAttributes.Public);
  return System.Activator.CreateInstance(type.CreateType());
 }
 public static DesktopJobStartRecord CleanupOnly() {
  var record=new DesktopJobStartRecord();var error=new DesktopJobNativeFailure(6);
  record.Cleanup("free-limit-buffer",error);record.CleanupFailure(error);return record;
 }
}
'@
Add-Type -TypeDefinition ($source.Substring($start,$end-$start)+"`n"+$fixture)
if([DesktopOwnedJob].GetField('BeforeResumeProof')){throw 'normal-proof-field-present'}
$record=ConvertTo-DesktopStartDiagnostic ([DesktopStartRecordFixture]::Build())
if($record.stage -cne 'create-suspended' -or $record.win32Error -ne 5 -or $record.cleanupFailureStage -cne 'terminate-job' -or $record.cleanupWin32Error -ne 6 -or -not $record.cleanupUncertain){throw 'first-failure-latch-refused'}
if($record.cleanupSteps.Count -ne 3 -or $record.cleanupSteps[0].succeeded -or -not $record.cleanupSteps[1].succeeded -or $record.cleanupSteps[2].succeeded){throw 'cleanup-progress-refused'}
if($record.processCreated -or $record.resumeAttempted -or $null -ne $record.processTerminal -or $record.jobEmptyObserved -or $record.pipeEofObserved -or $record.safeHandleNativeCloseProven){throw 'diagnostic-invented-evidence'}
$cleanup=ConvertTo-DesktopStartDiagnostic ([DesktopStartRecordFixture]::CleanupOnly())
if($cleanup.stage -cne 'final-cleanup' -or $cleanup.cleanupFailureStage -cne 'free-limit-buffer' -or $cleanup.win32Error -ne 6){throw 'cleanup-only-refused'}
$both=ConvertTo-DesktopStartDiagnostic ([DesktopStartRecordFixture]::PrimaryAndBufferCleanup())
if($both.stage -cne 'set-job-limits' -or $both.win32Error -ne 5 -or $both.cleanupFailureStage -cne 'free-limit-buffer' -or $both.cleanupWin32Error -ne 6){throw 'native-and-buffer-latch-refused'}
$forged=[DesktopStartRecordFixture]::Forge('DesktopJobStartRecord',$false)
if($forged.GetType().FullName -cne 'DesktopJobStartRecord'){throw 'forged-type-fixture-refused'}
$forgedRejected=$false
try {$null=ConvertTo-DesktopStartDiagnostic $forged}catch{$forgedRejected=$true}
if(-not $forgedRejected){throw 'forged-record-admitted'}
$forgedFailure=[DesktopStartRecordFixture]::Forge('DesktopJobStartFailure',$true)
$forgedUnavailable=Get-DesktopStartFailureDiagnostic $forgedFailure
if($forgedUnavailable.available -or $forgedUnavailable.stage -cne 'start-diagnostic-unavailable'){throw 'forged-failure-admitted'}
$unavailable=Get-DesktopStartFailureDiagnostic ([ArgumentException]::new('private-binding-canary'))
if($unavailable.available -or $unavailable.stage -cne 'start-diagnostic-unavailable'){throw 'binding-unavailable-refused'}
$rejected=$false
try {$null=ConvertTo-DesktopStartDiagnostic ([pscustomobject]@{FailureStage='create-suspended';Raw='private-input-canary'})}catch{$rejected=$true}
if(-not $rejected){throw 'foreign-record-admitted'}
$invalid=$null
try {$null=[DesktopOwnedJob]::Start('unused','unused','unused',@{},[uint64]0)}catch{$invalid=Get-DesktopStartFailureDiagnostic $_.Exception}
if(-not $invalid.available -or $invalid.stage -cne 'validate-limit' -or $invalid.processCreated -or $invalid.cleanupSteps.Count -ne 0){throw 'invalid-limit-native-path-entered'}
$json=@{v=1;status='passed';cases=@('normal-proof-field-absent','first-failure-latched','cleanup-first-failure-latched','later-cleanup-observed','cleanup-only-distinct','native-before-buffer-cleanup-preserved','forged-fullname-record-refused','forged-fullname-failure-refused','binding-unavailable','foreign-record-refused','invalid-limit-no-native');nativeInvoked=$false;profileAttested=$false;rootRetained=$true}|ConvertTo-Json -Depth 5 -Compress
if($json.Length -gt 2048 -or (($record|ConvertTo-Json -Depth 5 -Compress) -match 'private-')){throw 'diagnostic-output-refused'}
[IO.File]::WriteAllText((Join-Path $Root 'start-diagnostic.json'),$json)
