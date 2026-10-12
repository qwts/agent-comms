# Private wrapper cleanup algorithm. No configurable budget or task selector.
function Complete-DesktopOwnedCleanup {
    param([Parameter(Mandatory)]$Child,
        [Parameter(Mandatory)][Diagnostics.Stopwatch]$Clock,
        [bool]$Terminal,[bool]$OuterEmpty,[bool]$StreamsClosed,$OutCopy,$ErrCopy)
    $uncertain=$false
    try {$Child.Terminate()} catch {$uncertain=$true}
    # Caller owns this clock across supervision and finally. Never restart it.
    while($Clock.ElapsedMilliseconds -lt 10000) {
        $remaining=[Math]::Max(0,10000-$Clock.ElapsedMilliseconds)
        try {if(-not $Terminal){$Terminal=$Child.WaitForExit([int][Math]::Min(100,$remaining))}} catch {$uncertain=$true}
        try {$OuterEmpty=$Child.ActiveMembers() -eq 0} catch {$uncertain=$true}
        if($OutCopy -and $ErrCopy -and $OutCopy.IsCompleted -and $ErrCopy.IsCompleted) {
            try {$StreamsClosed=$OutCopy.GetAwaiter().GetResult() -and $ErrCopy.GetAwaiter().GetResult()} catch {$uncertain=$true}
        }
        if($Terminal -and $OuterEmpty -and $StreamsClosed){break}
        [Threading.Thread]::Sleep(10)
    }
    if(-not $Terminal -or -not $OuterEmpty -or -not $StreamsClosed){$uncertain=$true}
    return @{terminal=$Terminal;outerEmpty=$OuterEmpty;streamsClosed=$StreamsClosed;uncertain=$uncertain}
}
