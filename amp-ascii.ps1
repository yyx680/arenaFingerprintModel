$ErrorActionPreference='SilentlyContinue'
# amp-ascii.ps1 — capture arena tab screenshot via CDP, print as ASCII art (small)
Add-Type -AssemblyName System.Drawing
node $PSScriptRoot\cdp-shot.mjs 9222 | Out-Null
$b64 = Get-Content "$env:TEMP\amp-shot.b64" -Raw
$bytes = [Convert]::FromBase64String($b64)
$ms = New-Object System.IO.MemoryStream(,$bytes)
$bmp = New-Object System.Drawing.Bitmap($ms)
$cols = 110; $rows = 42
$cw = [math]::Floor($bmp.Width / $cols); $ch = [math]::Floor($bmp.Height / $rows)
$chars = ' .:-=+*#%@'
$sb = New-Object System.Text.StringBuilder
for ($r = 0; $r -lt $rows; $r++) {
  $line = ''
  for ($c = 0; $c -lt $cols; $c++) {
    $x = [math]::Min($bmp.Width - 1, $c * $cw + [int]($cw / 2)); $y = [math]::Min($bmp.Height - 1, $r * $ch + [int]($ch / 2))
    try { $px = $bmp.GetPixel($x, $y); $lum = [int](($px.R + $px.G + $px.B) / 3) } catch { $lum = 255 }
    $line += $chars[[math]::Min(9, [int](10 * (255 - $lum) / 256))]
  }
  [void]$sb.AppendLine($line)
}
Write-Output ("SIZE: " + $bmp.Width + "x" + $bmp.Height)
Write-Output $sb.ToString()
$bmp.Dispose(); $ms.Dispose()
