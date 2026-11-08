@echo off
REM ============================================================
REM  Arena Model Probe - debug Chrome launcher (v2.19.3)
REM  Double-click this file to start a debug Chrome with the
REM  extension in THIS folder loaded as an unpacked extension.
REM
REM  Why a .cmd launcher: Chrome launched from inside the agent
REM  session gets reaped when the tool call returns. Launched from
REM  Explorer (by you, double-clicking) it lives independently.
REM
REM  What it does:
REM    1. kills ONLY the old debug instance (profile folder
REM       "amp-debug-profile"). Your daily Chrome is NOT touched.
REM    2. starts Chrome with --remote-debugging-port=9222 and
REM       --load-extension pointing at this folder.
REM ============================================================
setlocal
set "EXT=%~dp0"
if "%EXT:~-1%"=="\" set "EXT=%EXT:~0,-1%"

echo [1/3] stopping old debug instance (if any)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*amp-debug-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 2 /nobreak >nul

echo [2/3] starting debug Chrome with extension loaded...
echo       extension dir: %EXT%
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%TEMP%\amp-debug-profile" ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-features=DisableLoadExtensionCommandLineSwitch ^
  --load-extension="%EXT%" ^
  "https://canary.arena.ai/agent/01a12ca1-e28e-7bee-9f00-f476c4b61412"

echo [3/3] waiting for debug port...
timeout /t 7 /nobreak >nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 5; Write-Host 'PORT 9222 OK'; Write-Host $r.Content } catch { Write-Host ('PORT_NOT_UP: ' + $_.Exception.Message) }"

echo.
echo Done. You can close this window. Tell the agent it is ready.
pause
