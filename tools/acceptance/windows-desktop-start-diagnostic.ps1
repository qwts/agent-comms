# Fixed projection only. Dot-sourcing performs no native or profile operations.
function ConvertTo-DesktopStartDiagnostic($Record) {
    $stages=@('validate-limit','create-job','job-noninheritable','set-job-limits','pipe-input','pipe-output','pipe-error',
        'parent-input-noninheritable','parent-output-noninheritable','parent-error-noninheritable','attribute-size','attribute-init',
        'attribute-stdio','attribute-job','environment','create-suspended','verify-membership','child-input-close','child-output-close',
        'child-error-close','safe-input','safe-output','safe-error','stream-input','stream-output','stream-error','proof-before-resume',
        'resume','thread-close','final-cleanup')
    $cleanupStages=@('terminate-job','terminate-process','wait-process','dispose-input-safe','dispose-output-safe','dispose-error-safe',
        'close-process','close-job','close-thread','close-input-read','close-input-write','close-output-read','close-output-write','close-error-read','close-error-write',
        'free-limit-buffer','delete-attributes','free-attributes','free-handle-list','free-job-list','free-environment')
    if($null -eq $Record){return @{available=$false;stage='start-diagnostic-unavailable'}}
    if($Record.GetType() -ne [DesktopOwnedJob].Assembly.GetType('DesktopJobStartRecord',$true) -or $stages -cnotcontains $Record.FailureStage){throw 'desktop-start-diagnostic-refused'}
    $result=@{available=$true;stage=$Record.FailureStage;cleanupFailureStage=$null;cleanupSteps=@();jobEmptyObserved=$false;pipeEofObserved=$false;safeHandleNativeCloseProven=$false}
    foreach($pair in @(@('ExceptionType','exceptionType'),@('CleanupExceptionType','cleanupExceptionType'))) {
        $value=$Record.($pair[0])
        if($null -ne $value -and ($value -isnot [string] -or $value -cnotmatch '^[A-Za-z0-9_.+]{1,128}$')){throw 'desktop-start-diagnostic-refused'}
        $result[$pair[1]]=$value
    }
    foreach($pair in @(@('HResult','hresult'),@('Win32Error','win32Error'),@('CleanupHResult','cleanupHresult'),@('CleanupWin32Error','cleanupWin32Error'))) {
        $value=$Record.($pair[0]);if($null -ne $value -and $value -isnot [int]){throw 'desktop-start-diagnostic-refused'}
        $result[$pair[1]]=$value
    }
    if($null -ne $Record.CleanupFailureStage) {
        if($cleanupStages -cnotcontains $Record.CleanupFailureStage){throw 'desktop-start-diagnostic-refused'}
        $result.cleanupFailureStage=$Record.CleanupFailureStage
    }
    foreach($pair in @(@('ProcessCreated','processCreated'),@('MembershipConfirmed','membershipConfirmed'),@('ResumeAttempted','resumeAttempted'),
        @('ResumeConfirmed','resumeConfirmed'),@('ProcessTerminal','processTerminal'),@('CleanupUncertain','cleanupUncertain'),
        @('TerminateJobAccepted','terminateJobAccepted'),@('TerminateProcessAccepted','terminateProcessAccepted'),@('TerminationFallbackTerminal','terminationFallbackTerminal'))) {
        $value=$Record.($pair[0]);if($null -ne $value -and $value -isnot [bool]){throw 'desktop-start-diagnostic-refused'}
        $result[$pair[1]]=$value
    }
    $value=$Record.ResumeResult;if($null -ne $value -and $value -isnot [uint32]){throw 'desktop-start-diagnostic-refused'}
    $result.resumeResult=$value
    $steps=@($Record.CleanupSteps);if($steps.Count -gt 32){throw 'desktop-start-diagnostic-refused'}
    $result.cleanupSteps=@(foreach($step in $steps) {
        if($cleanupStages -cnotcontains $step.Stage -or $step.Succeeded -isnot [bool]){throw 'desktop-start-diagnostic-refused'}
        @{stage=$step.Stage;succeeded=$step.Succeeded}
    })
    return $result
}
function Get-DesktopStartFailureDiagnostic($Exception) {
    # PowerShell wraps static-method exceptions. Follow only a bounded chain and
    # admit only our exact compiled exception/record; never serialize wrappers.
    $cursor=$Exception
    for($i=0;$i -lt 8 -and $null -ne $cursor;$i++) {
        if($cursor.GetType() -eq [DesktopOwnedJob].Assembly.GetType('DesktopJobStartFailure',$true)){return ConvertTo-DesktopStartDiagnostic $cursor.Diagnostic}
        $cursor=$cursor.InnerException
    }
    return ConvertTo-DesktopStartDiagnostic $null
}
