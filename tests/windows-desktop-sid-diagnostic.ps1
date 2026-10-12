# Diagnostic timing only; never substitutes for the unchanged direct SID case.
param([Parameter(Mandatory)][string]$Child,[Parameter(Mandatory)][string]$Stage)
$ErrorActionPreference='Stop'
# First observable point uses no cmdlet or module autoload.
[IO.File]::WriteAllText($Stage,"driver-start`n")
$global:DesktopSidDiagnosticStage=$Stage
$lines=[IO.File]::ReadAllLines($Child)
[IO.File]::AppendAllText($Stage,"source-read`n")
$anchors=@(
    @{text='$inputs = Get-Content -LiteralPath (Join-Path $PSScriptRoot ''inputs.json'') -Raw | ConvertFrom-Json';stage='input-parse'},
    @{text='    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()';stage='identity'},
    @{text='    if ($identity.User.Value -ne $inputs.sid) { throw ''Unexpected CI account SID'' }';stage='sid-compare'},
    @{text='    $result.failure = @{gate=$gate;errorType=$_.Exception.GetType().Name}';stage='catch'},
    @{text='    $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $report -Encoding utf8';stage='receipt'},
    @{text='exit $exitCode';stage='exit'}
)
foreach($anchor in $anchors) {
    $matches=@();for($index=0;$index -lt $lines.Length;$index++){if($lines[$index] -ceq $anchor.text){$matches+=($index+1)}}
    if($matches.Count -ne 1){throw 'diagnostic-anchor-refused'}
    # Stage comes solely from the fixed table; paths/variables/output never logged.
    $action=[scriptblock]::Create('if(([IO.FileInfo]::new($global:DesktopSidDiagnosticStage)).Length -gt 2000){throw ''diagnostic-stage-bound''};[IO.File]::AppendAllText($global:DesktopSidDiagnosticStage,"'+$anchor.stage+'`n")')
    [IO.File]::AppendAllText($Stage,("install-"+$anchor.stage+"`n"))
    $null=Set-PSBreakpoint -Script $Child -Line $matches[0] -Action $action
    [IO.File]::AppendAllText($Stage,("installed-"+$anchor.stage+"`n"))
}
[IO.File]::AppendAllText($Stage,"breakpoints-ready`n")
& $Child
