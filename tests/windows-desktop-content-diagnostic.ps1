# Diagnostic only: isolated first cmdlet from unchanged copied SID script.
param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference='Stop'
$stage=[IO.Path]::Combine($Root,'stages.txt')
[IO.File]::WriteAllText($stage,"content-start`n")
$null=Get-Content -LiteralPath ([IO.Path]::Combine($Root,'inputs.json')) -Raw
[IO.File]::AppendAllText($stage,"content-complete`n")
