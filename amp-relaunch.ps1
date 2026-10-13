# Relaunch the debug Chrome with THIS folder loaded as an unpacked extension.
#
# Encoding rule (do not break): keep this file ASCII-only.
# PowerShell 5.1 reads a BOM-less .ps1 using the *system ANSI codepage*
# (gb2312 on this machine), so a literal non-ASCII path written here would be
# garbled, and --load-extension would silently point at a directory that does
# not exist, so Chrome would load NO extension at all.
# $PSScriptRoot is derived from the real file path (correct Unicode), so we use
# it instead of any hard-coded path.
$ErrorActionPreference = 'SilentlyContinue'
$ext = $PSScriptRoot
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*amp-debug-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
Start-Process chrome -ArgumentList "--remote-debugging-port=9222","--user-data-dir=$env:TEMP\amp-debug-profile","--no-first-run","--no-default-browser-check","--disable-features=DisableLoadExtensionCommandLineSwitch","--load-extension=$ext","https://arena.ai"
Start-Sleep -Seconds 7
try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version).Content } catch { "PORT_NOT_UP: $($_.Exception.Message)" }
