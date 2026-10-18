$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'native/windows/AgentCommsPipeRelay.cs'
$directory = Join-Path $root 'bin/windows'
$binary = Join-Path $directory 'agent-comms-pipe-relay.exe'
# Probe only the fixed operating-system Framework paths, never PATH.
$compiler = @('Framework64', 'Framework') | ForEach-Object {
    Join-Path $env:WINDIR "Microsoft.NET/$_/v4.0.30319/csc.exe"
} | Where-Object { Test-Path $_ -PathType Leaf } | Select-Object -First 1
if (-not $compiler) { throw 'Windows .NET Framework compiler unavailable' }
if (Test-Path (Join-Path $root '.git')) {
    $commit = (& git -C $root rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Relay build source commit unavailable' }
} else {
    $commit = (Get-Content (Join-Path $root 'RELEASE_COMMIT') -Raw).Trim()
}
if ($commit -cnotmatch '\A(?:[0-9a-f]{40}|[0-9a-f]{64})\z') { throw 'Relay build source commit invalid' }
[void](New-Item -ItemType Directory -Force $directory)
& $compiler /nologo /optimize+ /target:winexe /platform:anycpu "/out:$binary" $source
if ($LASTEXITCODE -ne 0) { throw 'Relay compilation failed' }
$manifest = [ordered]@{
    format = 1
    sourceCommit = $commit
    sourceSha256 = (Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant()
    binarySha256 = (Get-FileHash $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    subsystem = 'windows'
}
$manifest | ConvertTo-Json -Compress | Set-Content (Join-Path $directory 'relay-build.json') -Encoding ascii
