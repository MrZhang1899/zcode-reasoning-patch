$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\restart.ps1" -LibraryOnly
# All OS process operations are replaced before invoking the restart workflow.
function Get-CimInstance { throw 'TEST SAFETY: real process query blocked' }
function Get-Process { throw 'TEST SAFETY: real process access blocked' }
function Start-Process { throw 'TEST SAFETY: real launch blocked' }
function Stop-Process { throw 'TEST SAFETY: process termination blocked' }
$script:exe = 'C:\Test install with spaces\ZCode.exe'
function Row($id, $parent, $exe, $command) {
    [pscustomobject]@{ProcessId=$id; ParentProcessId=$parent; ExecutablePath=$exe; CommandLine=$command; CreationDate=[datetime]'2026-01-01'; Name=[IO.Path]::GetFileName($exe)}
}
function Reset-State {
    $script:rows = @((Row 100 90 $script:exe 'electron patcher.cjs'), (Row 90 0 'C:\Windows\cmd.exe' 'cmd'))
    $script:closed = @()
    $script:launched = @()
    $script:stuck = $false
    $script:noWindow = $false
    $script:refuse = $false
    $script:waits = 0
    $script:launchMode = 'normal'
}
function Get-RestartProcesses { $script:rows }
function Get-RestartWindow($Row) {
    [pscustomobject]@{Id=$Row.ProcessId; MainWindowHandle=$(if ($script:noWindow) {0} else {1})}
}
function Send-RestartClose($Window) {
    $script:closed += $Window.Id
    if ($script:refuse) { return $false }
    if (-not $script:stuck) { $script:rows = @($script:rows | Where-Object { $_.ProcessId -notin @(200,201) }) }
    return $true
}
function Wait-RestartInterval { $script:waits++ }
function Start-RestartGui($Path) {
    $script:launched += $Path
    switch ($script:launchMode) {
        'normal' { $script:rows += (Row 400 90 $Path 'ZCode.exe') }
        'wrongPath' { $script:rows += (Row 400 90 'D:\Other\ZCode.exe' 'ZCode.exe') }
        'renderer' { $script:rows += (Row 400 90 $Path 'ZCode.exe --type=renderer') }
        'reused' { $script:rows += (Row 200 90 $Path 'ZCode.exe') }
        'missingCommand' { $script:rows += (Row 400 90 $Path '') }
    }
}
$script:assertions = 0
function Assert($condition, $message) { if (-not $condition) { throw $message }; $script:assertions++ }
function Expect-Failure($pattern) {
    $message = ''
    try { Invoke-ZCodeRestart $script:exe 100 | Out-Null } catch { $message = $_.Exception.Message }
    Assert ($message -match $pattern) "Expected $pattern, got $message"
    Assert ($script:launched.Count -eq 0) 'Failure must not launch'
}
Reset-State
$result = Invoke-ZCodeRestart $script:exe 100
Assert ($result -eq 'started' -and $script:closed.Count -eq 0 -and $script:launched.Count -eq 1) 'Launch stopped app once; exclude interpreter'
Reset-State
$script:rows += (Row 200 1 $script:exe '"C:\Test install with spaces\ZCode.exe"')
$script:rows += (Row 201 200 $script:exe 'ZCode.exe --type=renderer')
$script:rows += (Row 300 1 'D:\Other\ZCode.exe' 'ZCode.exe')
$result = Invoke-ZCodeRestart $script:exe 100
Assert ($result -eq 'restarted' -and $script:closed.Count -eq 1 -and $script:closed[0] -eq 200) 'Close only exact-path main'
Assert ($script:launched.Count -eq 1 -and $script:launched[0] -eq $script:exe) 'Launch selected path exactly once'
Assert (@($script:rows | Where-Object ProcessId -eq 300).Count -eq 1) 'Other installation untouched'
Reset-State
$script:rows[1].ExecutablePath = $script:exe
Expect-Failure 'CMD'
Assert ($script:closed.Count -eq 0) 'Ancestor refusal before close'
Reset-State
$script:rows += (Row 200 1 $script:exe 'ZCode.exe')
$script:stuck = $true
Expect-Failure '等待正常关闭已超时'
Assert ($script:waits -eq 40) 'Bounded wait'
Reset-State
$script:rows += (Row 200 1 $script:exe 'ZCode.exe')
$script:noWindow = $true
Expect-Failure '程序没有主窗口'
Assert ($script:closed.Count -eq 0) 'Background refusal before close'
Reset-State
$script:rows += (Row 201 200 $script:exe 'ZCode.exe --type=renderer')
Expect-Failure '只找到当前选择的 ZCode 的后台程序'
Reset-State
$script:rows += (Row 200 1 $script:exe '')
Expect-Failure '无法区分当前选择的 ZCode 主程序和后台程序'
Reset-State
$script:rows += (Row 200 1 $script:exe 'ZCode.exe')
$script:refuse = $true
Expect-Failure '拒绝了正常关闭请求'
Reset-State
$script:rows[1].ParentProcessId = 999
$excluded = Get-RestartExclusions $script:exe 100 $script:rows
Assert ($excluded.Contains(100) -and $excluded.Contains(90) -and $excluded.Contains($PID)) 'Exited ancestor ends traversal, preserving tool exclusions'
Assert (-not $excluded.Contains(999)) 'Missing PID is not a live exclusion'
$result = Invoke-ZCodeRestart $script:exe 100 -ValidateOnly
Assert ($result -eq 'validated-only' -and $script:closed.Count -eq 0 -and $script:launched.Count -eq 0 -and $script:waits -eq 0) 'Validation has no close, launch or wait'
foreach ($missingSide in @('neither', 'parent', 'child', 'both')) {
    Reset-State
    $script:rows[1].ExecutablePath = $script:exe
    $script:rows[1].CreationDate = [datetime]'2026-01-02'
    if ($missingSide -in @('parent', 'both')) { $script:rows[1].CreationDate = $null }
    if ($missingSide -in @('child', 'both')) { $script:rows[0].CreationDate = $null }
    if ($missingSide -eq 'neither') {
        $excluded = Get-RestartExclusions $script:exe 100 $script:rows
        Assert (-not $excluded.Contains(90)) 'Newer reused PID is not an ancestor or exclusion'
        Assert ($excluded.Contains(100) -and $excluded.Contains($PID)) 'Reused PID does not weaken own exclusions'
    } else {
        Expect-Failure 'CMD'
        Assert ($script:closed.Count -eq 0) 'Missing age cannot bypass exact-path ancestor guard'
    }
}
Reset-State
$script:rows[1].CreationDate = [datetime]'2025-12-31'
$script:rows[1].ExecutablePath = $script:exe
Expect-Failure 'CMD'
Assert ($script:closed.Count -eq 0) 'Older selected ancestor refused before close'
Reset-State
$script:rows = @($script:rows[1])
Expect-Failure '.'
Assert ($script:closed.Count -eq 0) 'Absent caller refused before close'
Reset-State
$script:rows += $script:rows[0]
Expect-Failure '.'
Reset-State
$script:rows[1].ParentProcessId = 100
Expect-Failure '.'
Assert ($script:closed.Count -eq 0) 'Caller loop refused before close'
Reset-State
$script:rows[1].ParentProcessId = 90
Expect-Failure '.'
Reset-State
$script:rows[1].ExecutablePath = $null
Expect-Failure 'CMD'
Assert ($script:closed.Count -eq 0) 'Unknown live ancestor path refused before close'
Reset-State
$script:rows[1].ParentProcessId = 4
$root = Row 4 0 '' ''
$root.Name = 'System'
$root.CreationDate = $null
$script:rows += $root
$excluded = Get-RestartExclusions $script:exe 100 $script:rows
Assert ($excluded.Contains(4)) 'Benign System root allowed and excluded without creation time'
$root.Name = 'ZCode.exe'
Expect-Failure 'CMD'
Reset-State
$script:rows[1].CreationDate = $null
$excluded = Get-RestartExclusions $script:exe 100 $script:rows
Assert ($excluded.Contains(90)) 'Unknown age retains readable non-selected ancestor'
foreach ($mode in @('noGui', 'wrongPath', 'renderer', 'reused', 'missingCommand', 'noWindow')) {
    Reset-State
    $script:launchMode = $mode
    if ($mode -eq 'reused') { $script:rows += (Row 200 1 $script:exe 'ZCode.exe') }
    if ($mode -eq 'noWindow') { $script:launchMode = 'normal'; $script:noWindow = $true }
    $message = ''
    try { Invoke-ZCodeRestart $script:exe 100 | Out-Null } catch { $message = $_.Exception.Message }
    Assert ($message -match '无法确认当前选择的 ZCode 已启动新窗口') "Must reject unconfirmed launch: $mode"
    Assert ($script:launched.Count -eq 1) 'Do not retry a failed launch'
    Assert ($script:waits -eq 30) 'GUI confirmation timeout is bounded'
}
Write-Output "PASS: $script:assertions PowerShell assertions; real close/launch never invoked."
