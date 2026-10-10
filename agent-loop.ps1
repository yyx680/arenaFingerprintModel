# Keep-listening loop for the Vodka Code bridge (conversation window pinned).
# JSON bodies are built with ConvertTo-Json to avoid quoting pitfalls in PS 5.1.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Url = 'https://vcode.yyx680.us.kg/mcp/9fe443497355ba4f421a7377ac6a9226'
$WaitMs = 300000
$Window = '主窗口'
$script:Sid = ''
$script:Seq = 10
function Post-Json($bodyObj, $timeoutSec) {
  $json = ConvertTo-Json -InputObject $bodyObj -Compress -Depth 10
  $headers = @{ Accept = 'application/json, text/event-stream' }
  if ($script:Sid) { $headers['mcp-session-id'] = $script:Sid }
  return Invoke-WebRequest -UseBasicParsing -Uri $Url -Method Post -ContentType 'application/json' -Headers $headers -Body $json -TimeoutSec $timeoutSec
}
function New-Session {
  $r = Post-Json @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'agent-loop'; version = '1.0' } } } 30
  $h = $r.Headers['mcp-session-id']
  $script:Sid = [string]($h -join '')
  if ($script:Sid) { Post-Json @{ jsonrpc = '2.0'; method = 'notifications/initialized' } 30 | Out-Null }
  return [bool]$script:Sid
}
function Listen-Once {
  $script:Seq++
  $body = @{ jsonrpc = '2.0'; id = $script:Seq; method = 'tools/call'; params = @{ name = 'chat_listen'; arguments = @{ timeout_ms = $WaitMs; conversation = $Window } } }
  $r = Post-Json $body ([int]($WaitMs / 1000) + 50)
  $out = ''
  foreach ($line in ($r.Content -split [string][char]10)) { if ($line.StartsWith('data: ')) { $out += $line.Substring(6) + [string][char]10 } }
  return $out
}
if (-not (New-Session)) { Write-Output ('INIT_FAILED: could not reach ' + $Url); exit 2 }
while ($true) {
  try { $out = Listen-Once } catch { Start-Sleep -Seconds 2; New-Session | Out-Null; continue }
  if ($out -like '*from the Vodka Code sidebar*') {
    Write-Output 'NEW USER MESSAGE(S)'
    foreach ($line in ($out -split [string][char]10)) {
      if (-not $line.Trim()) { continue }
      try { $json = $line | ConvertFrom-Json } catch { continue }
      if ($json.result -and $json.result.content) { foreach ($c in @($json.result.content)) { if ($c.type -eq 'text') { Write-Output $c.text } } }
    }
    break
  }
  if ($out -like '*IDLE_TIMEOUT*') { Write-Output ('IDLE ' + $WaitMs + 'ms - listening on [' + $Window + ']'); continue }
  if ($out -like '*xpired*' -or $out -like '*mcp-session*') { New-Session | Out-Null; continue }
  if (-not $out.Trim()) { Start-Sleep -Seconds 1; continue }
  Write-Output ($out.Substring(0, [Math]::Min(400, $out.Length))); Start-Sleep -Seconds 2
}

