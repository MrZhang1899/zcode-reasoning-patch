param([switch]$Runtime)
$ErrorActionPreference = 'SilentlyContinue'
$roots = [System.Collections.Generic.List[string]]::new()
function Add-Root([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return }
    $value = [Environment]::ExpandEnvironmentVariables($value.Trim())
    if ($value -match '^"([^"]+\.exe)"') { $value = $Matches[1] }
    $value = $value -replace ',\s*-?\d+$', ''
    $value = $value.Trim('"')
    if ($value -match '\.exe$') { $value = Split-Path -Parent $value }
    if ($value) { $roots.Add($value) }
}
Add-Root 'D:\ZCode'
foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($base) { Add-Root (Join-Path $base 'ZCode') }
}
if ($env:LOCALAPPDATA) { Add-Root (Join-Path $env:LOCALAPPDATA 'Programs\ZCode') }
foreach ($hive in @('HKCU:', 'HKLM:')) {
    foreach ($branch in @('SOFTWARE', 'SOFTWARE\WOW6432Node')) {
        $uninstall = "$hive\$branch\Microsoft\Windows\CurrentVersion\Uninstall"
        Get-ChildItem -LiteralPath $uninstall | ForEach-Object {
            $entry = Get-ItemProperty -LiteralPath $_.PSPath
            if ($entry.DisplayName -match '(?i)\bzcode\b') {
                Add-Root $entry.InstallLocation
                Add-Root $entry.DisplayIcon
            }
        }
        $app = Get-ItemProperty -LiteralPath "$hive\$branch\Microsoft\Windows\CurrentVersion\App Paths\ZCode.exe"
        if ($app) { Add-Root $app.'(default)'; Add-Root $app.Path }
    }
}
Get-CimInstance Win32_Process -Filter "Name = 'ZCode.exe'" | ForEach-Object { Add-Root $_.ExecutablePath }
$found = @($roots | Select-Object -Unique | ForEach-Object {
    $root = $_
    $target = Join-Path $root 'resources\glm\zcode.cjs'
    $exe = Join-Path $root 'ZCode.exe'
    if (Test-Path -LiteralPath $target -PathType Leaf) {
        [pscustomobject]@{root=$root; target=$target; executable=$(if (Test-Path -LiteralPath $exe -PathType Leaf) {$exe} else {$null})}
    }
})
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($Runtime) {
    $found | Where-Object executable | Select-Object -First 1 -ExpandProperty executable
} else {
    ConvertTo-Json -InputObject $found -Compress
}
