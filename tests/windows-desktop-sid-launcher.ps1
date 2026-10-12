# Fixed classic module initialization; original copied SID script stays unchanged.
param([Parameter(Mandatory)][string]$Child)
$ErrorActionPreference='Stop'
try {
    foreach($module in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility')) {
        $manifest=[IO.Path]::Combine($PSHOME,'Modules',$module,($module+'.psd1'))
        Import-Module -Name $manifest -ErrorAction Stop
    }
    # A script exit must supply its own exit code; the launcher never invents 0.
    $LASTEXITCODE=$null
    & $Child
    $childExitCode=$LASTEXITCODE
    if($childExitCode -isnot [int]){exit 1}
    exit $childExitCode
} catch {exit 1}
