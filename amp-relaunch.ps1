Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*amp-debug-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
Start-Process chrome -ArgumentList "--remote-debugging-port=9222","--user-data-dir=$env:TEMP\amp-debug-profile","--no-first-run","--no-default-browser-check","--disable-features=DisableLoadExtensionCommandLineSwitch","--load-extension=E:\下载\Arena模型探测-指纹-BYPERKICA","https://arena.ai"
Start-Sleep -Seconds 7
try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version).Content } catch { "PORT_NOT_UP: $($_.Exception.Message)" }
