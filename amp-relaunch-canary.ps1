# Relaunch the debug Chrome with THIS folder loaded as an unpacked extension.
# ASCII-only on purpose: PS 5.1 reads BOM-less .ps1 with the system ANSI codepage
# (gb2312 here), so any literal non-ASCII path would be garbled and --load-extension
# would silently load nothing. $PSScriptRoot is Unicode-correct, so we use it.
$ErrorActionPreference = 'SilentlyContinue'
$ext = $PSScriptRoot
$start = 'https://canary.arena.ai/agent/01a12ca1-e28e-7bee-9f00-f476c4b61412'

# kill ONLY the debug instance (never the user's daily Chrome: its cmdline has
# "User Data", not "amp-debug-profile")
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*amp-debug-profile*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2

Start-Process chrome -ArgumentList `
  "--remote-debugging-port=9222", `
  "--user-data-dir=$env:TEMP\amp-debug-profile", `
  "--no-first-run", `
  "--no-default-browser-check", `
  "--disable-features=DisableLoadExtensionCommandLineSwitch", `
  "--load-extension=$ext", `
  $start
Start-Sleep -Seconds 7
try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version).Content } catch { "PORT_NOT_UP: $($_.Exception.Message)" }
