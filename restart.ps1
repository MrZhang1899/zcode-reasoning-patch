param(
    [string]$Executable,
    [int]$ToolProcessId,
    [switch]$LibraryOnly,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'

function Get-RestartProcesses {
    @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath, CommandLine, CreationDate, Name)
}
function Get-RestartWindow($Row) {
    $process = Get-Process -Id $Row.ProcessId -ErrorAction Stop
    if (-not [string]::Equals($process.Path, $Row.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw '正在检查的程序已经变化，已取消重启。'
    }
    return $process
}
function Send-RestartClose($Window) { $Window.CloseMainWindow() }
function Wait-RestartInterval { Start-Sleep -Milliseconds 500 }
function Start-RestartGui([string]$Path) {
    # These changes affect this helper and its GUI child only, never the caller.
    foreach ($name in @('ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'NODE_PATH')) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    Start-Process -FilePath $Path -WorkingDirectory (Split-Path -Parent $Path) -ErrorAction Stop | Out-Null
}
function Get-RestartExclusions([string]$Path, [int]$CallerId, [object[]]$Rows) {
    if ($CallerId -le 0) { throw '无法确认启动重启助手的程序编号，已取消重启。' }
    $caller = @($Rows | Where-Object { $_.ProcessId -eq $CallerId })
    if ($caller.Count -ne 1) { throw '无法唯一确认启动重启助手的程序，已取消重启；请重新打开工具。' }
    $excluded = [System.Collections.Generic.HashSet[int]]::new()
    [void]$excluded.Add($PID)
    [void]$excluded.Add($CallerId)
    $child = $caller[0]
    $parent = [int]$child.ParentProcessId
    while ($parent -gt 0) {
        if ($excluded.Contains($parent)) { throw '检查启动这个工具的程序时发现循环关系，无法确认是否可以安全关闭；已取消重启。' }
        $ancestor = @($Rows | Where-Object { $_.ProcessId -eq $parent })
        # Windows retains the original parent PID after its process exits.
        if ($ancestor.Count -eq 0) { break }
        if ($ancestor.Count -ne 1) { throw '无法唯一确认启动这个工具的程序，无法确认是否可以安全关闭；已取消重启。' }
        $row = $ancestor[0]
        # A newer process cannot be this child's parent. Missing dates do not
        # justify discarding an otherwise possible live ancestor.
        if ($null -ne $row.CreationDate -and $null -ne $child.CreationDate -and
            $row.CreationDate -gt $child.CreationDate) { break }
        [void]$excluded.Add($parent)
        if ([string]::Equals($row.ExecutablePath, $Path, [StringComparison]::OrdinalIgnoreCase)) {
            throw '这个工具是从当前选择的 ZCode 里打开的，重启会影响工具自身，已取消；请在 ZCode 外单独打开 CMD 再运行工具。'
        }
        if ([string]::IsNullOrWhiteSpace($row.ExecutablePath)) {
            # Only the well-known kernel System root can lack a path safely.
            if (-not ($parent -eq 4 -and $row.Name -eq 'System' -and $row.ParentProcessId -eq 0)) {
                throw '无法读取启动这个工具的程序所在位置，已取消重启；请在 ZCode 外单独打开 CMD 重试。'
            }
        }
        $child = $row
        $parent = [int]$row.ParentProcessId
    }
    return ,$excluded
}
function Invoke-ZCodeRestart([string]$Path, [int]$CallerId, [switch]$ValidateOnly) {
    $rows = @(Get-RestartProcesses)
    $excluded = Get-RestartExclusions $Path $CallerId $rows
    if ($ValidateOnly) { return 'validated-only' }
    $selected = @($rows | Where-Object {
        [string]::Equals($_.ExecutablePath, $Path, [StringComparison]::OrdinalIgnoreCase) -and
        -not $excluded.Contains([int]$_.ProcessId)
    })
    # Missing command lines prevent safe classification. Never print command lines.
    if (@($selected | Where-Object { [string]::IsNullOrWhiteSpace($_.CommandLine) }).Count) {
        throw '无法区分当前选择的 ZCode 主程序和后台程序，已取消重启。'
    }
    $mains = @($selected | Where-Object { $_.CommandLine -notmatch '(?i)(?:^|\s)"?--type(?:=|\s|"|$)' })
    $windows = @()
    foreach ($row in $mains) {
        $window = Get-RestartWindow $row
        if ($window.MainWindowHandle -eq 0) { throw '当前选择的 ZCode 程序没有主窗口，请手动关闭 ZCode。' }
        $windows += $window
    }
    if ($selected.Count -gt 0 -and $mains.Count -eq 0) {
        throw '只找到当前选择的 ZCode 的后台程序，请手动关闭 ZCode。'
    }
    foreach ($window in $windows) {
        if (-not (Send-RestartClose $window)) { throw 'ZCode 拒绝了正常关闭请求，未启动新窗口。' }
    }
    # Wait for all exact-path application processes, including renderer children.
    for ($attempt = 0; $attempt -le 40; $attempt++) {
        $remaining = @(Get-RestartProcesses | Where-Object {
            [string]::Equals($_.ExecutablePath, $Path, [StringComparison]::OrdinalIgnoreCase) -and
            -not $excluded.Contains([int]$_.ProcessId)
        })
        if ($remaining.Count -eq 0) {
            Start-RestartGui $Path
            # A successful Start-Process is not evidence that a new GUI survived.
            $oldIds = @($rows | ForEach-Object { [int]$_.ProcessId })
            $confirmedId = 0
            for ($launchAttempt = 0; $launchAttempt -le 30; $launchAttempt++) {
                $newMains = @(Get-RestartProcesses | Where-Object {
                    [string]::Equals($_.ExecutablePath, $Path, [StringComparison]::OrdinalIgnoreCase) -and
                    -not $excluded.Contains([int]$_.ProcessId) -and
                    [int]$_.ProcessId -notin $oldIds -and
                    -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and
                    $_.CommandLine -notmatch '(?i)(?:^|\s)"?--type(?:=|\s|"|$)'
                })
                $visibleIds = @()
                foreach ($row in $newMains) {
                    try {
                        $gui = Get-RestartWindow $row
                        if ($gui.MainWindowHandle -ne 0) { $visibleIds += [int]$row.ProcessId }
                    } catch { # A transient process exit is not a confirmed GUI.
                    }
                }
                if ($confirmedId -gt 0 -and $confirmedId -in $visibleIds) {
                    return $(if ($selected.Count) { 'restarted' } else { 'started' })
                }
                $confirmedId = $(if ($visibleIds.Count) { $visibleIds[0] } else { 0 })
                if ($launchAttempt -lt 30) { Wait-RestartInterval }
            }
            throw '等待 15 秒后仍无法确认当前选择的 ZCode 已启动新窗口；不会强制关闭或重试，窗口仍可能稍后打开。'
        }
        if ($attempt -lt 40) { Wait-RestartInterval }
    }
    throw '等待正常关闭已超时（20 秒）；没有强制关闭，也没有重新启动 ZCode。'
}
if (-not $LibraryOnly) {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    try {
        if (-not (Test-Path -LiteralPath $Executable -PathType Leaf) -or
            [IO.Path]::GetFileName($Executable) -ine 'ZCode.exe') { throw '所选位置没有可用的 ZCode.exe 文件。' }
        $resolved = (Get-Item -LiteralPath $Executable).FullName
        Invoke-ZCodeRestart $resolved $ToolProcessId -ValidateOnly:$ValidateOnly
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
