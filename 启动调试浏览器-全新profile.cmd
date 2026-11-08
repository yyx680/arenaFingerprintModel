@echo off
REM ============================================================
REM  Arena Model Probe - FRESH debug Chrome launcher
REM
REM  Uses a BRAND-NEW profile folder so --load-extension takes
REM  effect (Chrome 137+ only honors it on a clean profile) and
REM  so we can verify the "first install" tab-init fix.
REM
REM  You will need to log in to Arena again (new profile = no
REM  cookies). That is expected.
REM ============================================================
setlocal
set "EXT=%~dp0"
if "%EXT:~-1%"=="\" set "EXT=%EXT:~0,-1%"
set "PROF=%TEMP%\amp-fresh-profile"

echo [1/3] stopping old debug instances...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*amp-debug-profile*' -or $_.CommandLine -like '*amp-fresh-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 2 /nobreak >nul

echo [2/3] starting with a FRESH profile...
echo       extension dir: %EXT%
echo       profile dir  : %PROF%
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%PROF%" ^
  --no-first-run ^
  --no-default-browser-check ^
  --load-extension="%EXT%" ^
  "https://canary.arena.ai/"

echo [3/3] waiting for debug port...
timeout /t 9 /nobreak >nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 5; Write-Host 'PORT 9222 OK'; Write-Host $r.Content } catch { Write-Host ('PORT_NOT_UP: ' + $_.Exception.Message) }"

echo.
echo Done. NOTE: new profile has no Arena login - log in, then
echo       open any agent session page so the HUD can attach.
pause
