# Diagnostic only: no substitute for unchanged direct SID acceptance.
param([Parameter(Mandatory)][string]$Root,
    [ValidateSet('autoload','management-import','utility-import')][string]$Mode='autoload')
$ErrorActionPreference='Stop'
$stage=[IO.Path]::Combine($Root,'stages.txt')
[IO.File]::WriteAllText($stage,"content-start`n")
if($Mode -eq 'autoload') {
    $null=Get-Content -LiteralPath ([IO.Path]::Combine($Root,'inputs.json')) -Raw
} else {
    # Exact native PSHOME manifest; never search ambient module names or paths.
    $module=if($Mode -eq 'management-import'){'Microsoft.PowerShell.Management'}else{'Microsoft.PowerShell.Utility'}
    $manifest=[IO.Path]::Combine($PSHOME,'Modules',$module,($module+'.psd1'))
    [IO.File]::AppendAllText($stage,"import-start`n")
    Import-Module -Name $manifest -ErrorAction Stop
    [IO.File]::AppendAllText($stage,"import-complete`ncommand-start`n")
    if($Mode -eq 'management-import') {
        $null=Get-Content -LiteralPath ([IO.Path]::Combine($Root,'inputs.json')) -Raw
    } else {
        $probe=[IO.Path]::Combine($Root,'inert-probe.ps1')
        [IO.File]::WriteAllText($probe,'$null=1')
        $null=Set-PSBreakpoint -Script $probe -Line 1 -Action {}
        # The target is never invoked; process exit owns breakpoint teardown.
    }
    [IO.File]::AppendAllText($stage,"command-complete`n")
}
[IO.File]::AppendAllText($stage,"content-complete`n")
