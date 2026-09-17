@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "PATCH_NO_PAUSE=%ZCODE_PATCH_NO_PAUSE%"
for %%A in (%*) do if /I "%%~A"=="--no-pause" set "PATCH_NO_PAUSE=1"
where node.exe >nul 2>nul
if errorlevel 1 goto find_electron
node.exe "%~dp0patcher.cjs" %*
set "PATCH_EXIT=%ERRORLEVEL%"
goto finish

:find_electron
set "PATCH_ELECTRON="
set "PATH=%SystemRoot%\System32\WindowsPowerShell\v1.0;%PATH%"
for /f "usebackq delims=" %%E in (`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0discover.ps1" -Runtime`) do set "PATCH_ELECTRON=%%E"
if defined PATCH_ELECTRON goto use_electron
echo 未找到能运行这个工具的 Node.js 或 ZCode.exe。
set /p "PATCH_ELECTRON=请输入 ZCode.exe 的完整路径（不带引号，空行退出）："
if not defined PATCH_ELECTRON goto unavailable
if not exist "%PATCH_ELECTRON%" goto unavailable
:use_electron
set "ELECTRON_RUN_AS_NODE=1"
"%PATCH_ELECTRON%" "%~dp0patcher.cjs" %*
set "PATCH_EXIT=%ERRORLEVEL%"
goto finish
:unavailable
echo 无法启动。请安装当前 Node.js LTS 或提供有效的 ZCode.exe 路径。
set "PATCH_EXIT=1"
:finish
if not defined PATCH_NO_PAUSE pause
endlocal & exit /b %PATCH_EXIT%
