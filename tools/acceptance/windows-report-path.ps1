# Resolve against PowerShell's provider location, independently of .NET cwd.
function Resolve-WindowsAcceptanceReportPath([string]$Path) {
    $provider = $null
    $drive = $null
    $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path, [ref]$provider, [ref]$drive)
    if ($provider.Name -ne 'FileSystem') { throw 'Report requires FileSystem provider' }
    return $resolved
}
