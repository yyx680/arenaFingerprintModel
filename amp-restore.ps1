$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*amp-debug-profile*' }
$restored = 0
foreach ($p in $procs) {
  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne 0) {
    [Win32]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
    [Win32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
    $restored++
  }
}
Write-Output "RESTORED:$restored"
