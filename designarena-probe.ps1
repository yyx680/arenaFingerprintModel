#requires -Version 5.1
<#
.SYNOPSIS
  designarena.ai 探针 —— 纯 PowerShell 5.1,零依赖。
.DESCRIPTION
  五种模式:
    infra  基础设施指纹:响应头(server / x-vercel-id / x-matched-path / cookie)、耗时、TLS 证书
    api    官方公共 API v1:GET /api/v1/arenas、/models、/leaderboard/{arena}/{category}
           不带 key 应得 401(证明路由存活);带 -ApiKey sk_live_... 拿真实榜单
    run    Agent 模式运行探针:解码 public-access-token(JWT),并尝试 Trigger.dev 只读端点,
           从运行轨迹里抠出底层 modelName / provider 模型名
    auto   单 agent 全程自助:一次粘贴登录 Bearer(Firebase idToken)即可自动
           建会话 -> 枚举 agent -> 拉 system-prompt/tools/status/events -> 汇总身份线索
    watch  以固定间隔循环执行 infra 探测,JSONL 追加到日志文件
.EXAMPLE
  .\designarena-probe.ps1 -Mode infra
.EXAMPLE
  .\designarena-probe.ps1 -Mode api -ApiKey "sk_live_xxxx"
.EXAMPLE
  .\designarena-probe.ps1 -Mode run -PublicToken "eyJhbGciOi..."
.EXAMPLE
  .\designarena-probe.ps1 -Mode auto -BearerToken "eyJhbGciOi..." -Prompt "Build a todo app" -FollowMin 3
.EXAMPLE
  .\designarena-probe.ps1 -Mode watch -WatchSeconds 60 -OutFile "da-probe.jsonl"
.NOTES
  -BearerToken 获取:designarena.ai 登录后,F12 -> Network -> 任意 /api/agon 请求 ->
  请求头 Authorization: Bearer 后面那串。邮箱验证码登录受 Cloudflare Turnstile 保护,无法纯脚本化。
#>
param(
  [ValidateSet('infra','api','run','auto','watch')]
  [string]$Mode = 'infra',
  [string]$ApiKey = '',
  [string]$PublicToken = '',
  [string]$RunId = '',
  [string]$TriggerHost = 'https://api.trigger.dev',
  [string]$BaseUrl = 'https://www.designarena.ai',
  [string]$BearerToken = '',
  [string]$Prompt = 'Build a minimal landing page for a coffee shop.',
  [string]$TemplateType = 'vite-react-ts',
  [string[]]$Models = @(),
  [int]$FollowMin = 0,
  [switch]$Cleanup,
  [int]$WatchSeconds = 60,
  [int]$TimeoutSec = 30,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 DesignArenaProbe/1.1'
$script:AgonBase = $BaseUrl.TrimEnd('/') + '/api/agon'

# ---------- 通用 HTTP 探测(PS 5.1:4xx/5xx 会抛异常,需从异常里捞响应) ----------
function Invoke-Probe {
  param(
    [Parameter(Mandatory=$true)][string]$Url,
    [hashtable]$Headers = @{},
    [string]$Method = 'GET',
    [string]$Body = $null,
    [int]$TimeoutSec = 30
  )
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $result = [ordered]@{
    url = $Url; method = $Method; ok = $false; status = 0; statusDesc = ''
    elapsedMs = 0; server = ''; headers = @{}; bodyPreview = ''; error = ''
  }
  try {
    $params = @{
      Uri = $Url; Method = $Method; TimeoutSec = $TimeoutSec
      UseBasicParsing = $true; MaximumRedirection = 5
      Headers = (@{ 'User-Agent' = $script:UA; 'Accept' = 'application/json, text/html;q=0.9, */*;q=0.1' } + $Headers)
    }
    if ($Body) { $params['Body'] = $Body; $params['ContentType'] = 'application/json' }
    $resp = Invoke-WebRequest @params
    $sw.Stop()
    $result.ok = $true; $result.status = [int]$resp.StatusCode
    $result.statusDesc = [string]$resp.StatusDescription
    foreach ($k in $resp.Headers.Keys) { $result.headers[$k] = [string]$resp.Headers[$k] }
    $content = [string]$resp.Content
    $result.bodyPreview = $content.Substring(0, [Math]::Min(4000, $content.Length))
  }
  catch [System.Net.WebException] {
    $sw.Stop()
    $wresp = $_.Exception.Response
    if ($wresp) {
      $result.status = [int]$wresp.StatusCode
      $result.statusDesc = [string]$wresp.StatusDescription
      foreach ($k in $wresp.Headers.AllKeys) { $result.headers[$k] = [string]$wresp.Headers[$k] }
      try {
        $sr = New-Object IO.StreamReader($wresp.GetResponseStream())
        $txt = $sr.ReadToEnd(); $sr.Close()
        $result.bodyPreview = $txt.Substring(0, [Math]::Min(4000, $txt.Length))
      } catch {}
    } else { $result.error = $_.Exception.Message }
  }
  catch { $sw.Stop(); $result.error = $_.Exception.Message }
  $result.elapsedMs = $sw.ElapsedMilliseconds
  if ($result.headers.ContainsKey('server')) { $result.server = $result.headers['server'] }
  return $result
}

# ---------- TLS 证书信息 ----------
function Get-TlsInfo {
  param([string]$Url, [int]$TimeoutSec = 15)
  $info = [ordered]@{ subject=''; issuer=''; expires=''; protocol=''; error='' }
  try {
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.Method = 'GET'; $req.Timeout = $TimeoutSec * 1000
    $req.UserAgent = $script:UA
    $resp = $req.GetResponse()
    $cert = $req.ServicePoint.Certificate
    if ($cert) {
      $info.subject  = $cert.Subject
      $info.issuer   = $cert.Issuer
      $info.expires  = $cert.GetExpirationDateString()
    }
    $info.protocol = [string]$req.ServicePoint.CurrentCipherAlgorithm
    $resp.Close()
  } catch { $info.error = $_.Exception.Message }
  return $info
}

# ---------- Base64Url -> JSON 对象(解 JWT payload) ----------
function ConvertFrom-Base64UrlJson {
  param([string]$Segment)
  $s = $Segment.Replace('-', '+').Replace('_', '/')
  switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } 1 { throw '非法 base64url 段' } }
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))
  return ($json | ConvertFrom-Json)
}

# ---------- 在 JSON 文本里扫描疑似模型字段 ----------
function Find-ModelHints {
  param([string]$Text)
  $rx = '"[a-zA-Z_.-]*(?:model|provider|engine)[a-zA-Z_.-]*"\s*:\s*"[^"]+"'
  return ([regex]::Matches($Text, $rx, 'IgnoreCase') | ForEach-Object { $_.Value } | Select-Object -Unique)
}

function Write-Section([string]$t) { Write-Host ''; Write-Host "== $t ==" -ForegroundColor Cyan }

function Save-JsonLine {
  param([object]$Obj, [string]$Path)
  if (-not $Path) { return }
  ($Obj | ConvertTo-Json -Depth 6 -Compress) | Out-File -FilePath $Path -Append -Encoding utf8
}

# ================= infra =================
function Invoke-Infra {
  $targets = @($BaseUrl, 'https://docs.designarena.ai/llms.txt')
  $report = [ordered]@{ mode='infra'; at=(Get-Date).ToUniversalTime().ToString('o'); targets=@() }
  foreach ($t in $targets) {
    $r = Invoke-Probe -Url $t -TimeoutSec $TimeoutSec
    Write-Section $t
    Write-Host ("HTTP {0} {1}  ({2} ms)" -f $r.status, $r.statusDesc, $r.elapsedMs)
    $interesting = 'server','x-vercel-id','x-vercel-cache','x-matched-path','x-powered-by','cache-control','set-cookie','strict-transport-security','cf-ray','via'
    foreach ($k in $interesting) {
      if ($r.headers.ContainsKey($k)) {
        $v = [string]$r.headers[$k]
        if ($v.Length -gt 110) { $v = $v.Substring(0,110) + '...' }
        Write-Host ("  {0}: {1}" -f $k, $v)
      }
    }
    if ($r.error) { Write-Host ("  ERROR: " + $r.error) -ForegroundColor Red }
    $report.targets += $r
  }
  Write-Section "TLS 证书 ($BaseUrl)"
  $tls = Get-TlsInfo -Url $BaseUrl -TimeoutSec $TimeoutSec
  if ($tls.error) { Write-Host ("  ERROR: " + $tls.error) -ForegroundColor Red }
  else { Write-Host ("  subject : {0}`n  issuer  : {1}`n  expires : {2}" -f $tls.subject, $tls.issuer, $tls.expires) }
  $report.tls = $tls
  return $report
}

# ================= api =================
function Invoke-Api {
  $headers = @{}
  if ($ApiKey) { $headers['Authorization'] = "Bearer $ApiKey" } else {
    Write-Host '(未提供 -ApiKey,401 属预期:可证明路由存活且鉴权生效)' -ForegroundColor Yellow
  }
  $endpoints = @('/api/v1/arenas', '/api/v1/models', '/api/v1/leaderboard/agents/agon_webapps', '/api/v1/leaderboard/models/website')
  $report = [ordered]@{ mode='api'; at=(Get-Date).ToUniversalTime().ToString('o'); endpoints=@() }
  foreach ($ep in $endpoints) {
    $url = $BaseUrl.TrimEnd('/') + $ep
    $r = Invoke-Probe -Url $url -Headers $headers -TimeoutSec $TimeoutSec
    Write-Section $ep
    Write-Host ("HTTP {0} {1}  ({2} ms)  cache: {3}" -f $r.status, $r.statusDesc, $r.elapsedMs, [string]$r.headers['cache-control'])
    if ($r.status -eq 200 -and $r.bodyPreview) {
      try {
        $j = $r.bodyPreview | ConvertFrom-Json
        if ($j.data -is [array]) {
          Write-Host ("  success={0}  data 条数: {1}" -f $j.success, $j.data.Count)
          $j.data | Select-Object -First 3 | ForEach-Object {
            if ($_.displayName) { Write-Host ("    - {0} ({1})  elo={2}  winRate={3}" -f $_.displayName, $_.provider, $_.elo, $_.winRate) }
            elseif ($_.name) { Write-Host ("    - {0}" -f $_.name) }
          }
        } else { Write-Host ("  响应预览: " + $r.bodyPreview.Substring(0,[Math]::Min(300,$r.bodyPreview.Length))) }
      } catch { Write-Host ("  响应预览: " + $r.bodyPreview.Substring(0,[Math]::Min(300,$r.bodyPreview.Length))) }
    } elseif ($r.bodyPreview) {
      Write-Host ("  响应: " + $r.bodyPreview.Substring(0,[Math]::Min(300,$r.bodyPreview.Length)))
    }
    if ($r.error) { Write-Host ("  ERROR: " + $r.error) -ForegroundColor Red }
    $report.endpoints += $r
  }
  return $report
}

# ================= run(Agent 模式运行探针) =================
function Invoke-Run {
  if (-not $PublicToken) { throw '缺少 -PublicToken。获取方法:浏览器 F12 -> Network -> 在 designarena.ai 发起一次 Agent 生成 -> 看响应头 public-access-token。' }
  $parts = $PublicToken.Split('.')
  if ($parts.Count -ne 3) { throw 'public-access-token 不是标准三段 JWT' }
  Write-Section 'JWT 解析'
  $payload = ConvertFrom-Base64UrlJson $parts[1]
  $payload | ConvertTo-Json -Depth 6 | Write-Host
  if ($payload.exp) {
    $exp = [DateTimeOffset]::FromUnixTimeSeconds([long]$payload.exp).LocalDateTime
    $state = '有效'
    if ([long]$payload.exp * 1000 -lt [DateTimeOffset]::Now.ToUnixTimeMilliseconds()) { $state = '已过期!' }
    Write-Host ("  过期时间: {0}  ({1})" -f $exp, $state)
  }
  if (-not $RunId) {
    foreach ($claim in 'run_id','runId','sub','jti') {
      if ($payload.PSObject.Properties.Name -contains $claim) { $RunId = [string]$payload.$claim; break }
    }
    if ($RunId) { Write-Host ("  从 JWT claims 推断 runId: $RunId") }
  }
  if (-not $RunId) { Write-Host '  未能从 JWT 推断 runId,请用 -RunId 显式传入(形如 run_xxxx,通常出现在生成页 URL 或响应里)' -ForegroundColor Yellow }

  $auth = @{ 'Authorization' = "Bearer $PublicToken" }
  $candidates = @(
    "/api/v3/runs/$RunId",
    "/api/v3/runs/$RunId/trace",
    "/api/v3/runs/$RunId/events",
    "/api/v1/runs/$RunId"
  )
  $report = [ordered]@{ mode='run'; at=(Get-Date).ToUniversalTime().ToString('o'); runId=$RunId; attempts=@() }
  foreach ($path in $candidates) {
    $url = $TriggerHost.TrimEnd('/') + $path
    $r = Invoke-Probe -Url $url -Headers $auth -TimeoutSec $TimeoutSec
    Write-Section $path
    Write-Host ("HTTP {0} {1}  ({2} ms)" -f $r.status, $r.statusDesc, $r.elapsedMs)
    if ($r.status -eq 200 -and $r.bodyPreview) {
      $hints = Find-ModelHints -Text $r.bodyPreview
      if ($hints) {
        Write-Host '  *** 命中疑似模型字段:' -ForegroundColor Green
        $hints | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor Green }
        $report.modelHints = $hints
      }
      Write-Host ('  预览: ' + $r.bodyPreview.Substring(0,[Math]::Min(500,$r.bodyPreview.Length)))
    } elseif ($r.bodyPreview) {
      Write-Host ('  响应: ' + $r.bodyPreview.Substring(0,[Math]::Min(200,$r.bodyPreview.Length)))
    }
    if ($r.error) { Write-Host ("  ERROR: " + $r.error) -ForegroundColor Red }
    $report.attempts += ($r | Select-Object url, status, elapsedMs, error)
  }
  Write-Host ''
  Write-Host '提示:若 401/403,说明 token 与 run 不匹配或已过期(该类 token 通常只存活几小时、且只授权单个 run)。' -ForegroundColor DarkGray
  return $report
}

# ================= auto(单 agent 全程自助) =================
function Invoke-Auto {
  $report = [ordered]@{ mode='auto'; at=(Get-Date).ToUniversalTime().ToString('o') }

  Write-Section '公开运行时指纹:GET /api/agon/api/tools'
  $tools = Invoke-Probe -Url ($script:AgonBase + '/api/tools') -TimeoutSec $TimeoutSec
  Write-Host ("HTTP {0}  ({1} ms)" -f $tools.status, $tools.elapsedMs)
  if ($tools.status -eq 200 -and $tools.bodyPreview) {
    try {
      $tj = $tools.bodyPreview | ConvertFrom-Json
      Write-Host ("  工具目录条数: {0}" -f $tj.Count)
      $tj | Select-Object -First 12 | ForEach-Object { Write-Host ("    - {0}: {1}" -f $_.name, $_.description) }
    } catch { Write-Host ('  预览: ' + $tools.bodyPreview.Substring(0,[Math]::Min(300,$tools.bodyPreview.Length))) }
  }
  $report.tools = ($tools | Select-Object status, elapsedMs)

  if (-not $BearerToken) {
    Write-Host ''
    Write-Host '[!] 全自动建会话需要一次登录凭据(邮箱验证码登录被 Turnstile 人机校验挡住,无法纯脚本化):' -ForegroundColor Yellow
    Write-Host '    1) 浏览器打开 designarena.ai 并登录'
    Write-Host '    2) F12 -> Network -> 随便触发一次操作(或刷新) -> 点任意 /api/agon 请求'
    Write-Host '    3) 复制请求头 Authorization: Bearer 后面的整串,重新运行:'
    Write-Host '       .\designarena-probe.ps1 -Mode auto -BearerToken "<粘贴>"' -ForegroundColor Cyan
    $report.error = 'missing BearerToken'
    return $report
  }

  $auth = @{ 'Authorization' = "Bearer $BearerToken" }

  Write-Section '解码 Firebase idToken'
  try {
    $claims = ConvertFrom-Base64UrlJson $BearerToken.Split('.')[1]
    $expired = $false
    if ($claims.exp) {
      $expired = ([long]$claims.exp * 1000 -lt [DateTimeOffset]::Now.ToUnixTimeMilliseconds())
      Write-Host ("  uid: {0}   email: {1}" -f $claims.user_id, $claims.email)
      Write-Host ("  exp: {0}  {1}" -f [DateTimeOffset]::FromUnixTimeSeconds([long]$claims.exp).LocalDateTime, $(if ($expired) { '(已过期,请重新获取!)' } else { '(有效)' }))
    }
    if ($expired) { $report.error = 'token expired'; return $report }
  } catch { Write-Host ('  (解码失败,仍按原样尝试: ' + $_.Exception.Message + ')') -ForegroundColor DarkYellow }

  Write-Section 'POST /api/agon/api/sessions(建会话)'
  $payload = @{ models = @($Models); template_type = $TemplateType; initial_prompt = $Prompt }
  $body = $payload | ConvertTo-Json -Compress
  Write-Host ("  payload: " + $body)
  $create = Invoke-Probe -Url ($script:AgonBase + '/api/sessions') -Method 'POST' -Headers $auth -Body $body -TimeoutSec ([Math]::Max($TimeoutSec, 120))
  Write-Host ("HTTP {0} {1}  ({2} ms)" -f $create.status, $create.statusDesc, $create.elapsedMs)
  if ($create.status -ne 200 -and $create.status -ne 201) {
    Write-Host ('  失败响应: ' + $create.bodyPreview) -ForegroundColor Red
    Write-Host '  排查:401=token 无效/过期;403=人机校验或权限拦截;429=看 Retry-After。' -ForegroundColor Yellow
    $report.create = ($create | Select-Object status, elapsedMs, bodyPreview)
    return $report
  }
  $session = $create.bodyPreview | ConvertFrom-Json
  $sessionId = [string]$session.session_id
  Write-Host ("  session_id: {0}" -f $sessionId) -ForegroundColor Green
  $report.sessionId = $sessionId

  $agentIds = @()
  if ($session.agents) {
    foreach ($a in $session.agents) {
      $mid = ''
      if ($a.model_id) { $mid = [string]$a.model_id } elseif ($a.id) { $mid = [string]$a.id } elseif ($a -is [string]) { $mid = $a }
      if ($mid) { $agentIds += $mid }
    }
  }
  Write-Host ("  agents: {0}" -f ($agentIds -join ', '))
  $report.agents = $agentIds

  Write-Section '逐 agent 拉取身份线索(status / system-prompt / tools)'
  $report.agentDetails = @()
  foreach ($mid in $agentIds) {
    Write-Host ("-- {0}" -f $mid) -ForegroundColor Magenta
    $detail = [ordered]@{ agent = $mid }
    $st = Invoke-Probe -Url ($script:AgonBase + "/api/sessions/$sessionId/agents/$mid/status") -Headers $auth -TimeoutSec $TimeoutSec
    Write-Host ("   status: HTTP {0}  {1}" -f $st.status, ($st.bodyPreview.Substring(0,[Math]::Min(140,$st.bodyPreview.Length))))
    $detail.statusRaw = $st.bodyPreview
    $sp = Invoke-Probe -Url ($script:AgonBase + "/api/sessions/$sessionId/agents/$mid/system-prompt") -Headers $auth -TimeoutSec $TimeoutSec
    if ($sp.status -eq 200 -and $sp.bodyPreview) {
      $spText = $sp.bodyPreview
      Write-Host ("   system-prompt 开头: " + $spText.Substring(0,[Math]::Min(180,$spText.Length)).Replace("`n",' '))
      $spHints = ([regex]::Matches($spText, '(?i)\b(claude|gpt[- ]?\w*|gemini|llama|qwen|deepseek|mistral|grok|kimi|opus|sonnet|haiku|codex|o[0-9])\w*[-.0-9a-z]*\b') | ForEach-Object { $_.Value } | Select-Object -Unique -First 8)
      if ($spHints) { Write-Host ("   *** system-prompt 提及: " + ($spHints -join ', ')) -ForegroundColor Green; $detail.spHints = @($spHints) }
      $detail.systemPromptHead = $spText.Substring(0,[Math]::Min(400,$spText.Length))
    } else { Write-Host ("   system-prompt: HTTP {0}" -f $sp.status) }
    $tl = Invoke-Probe -Url ($script:AgonBase + "/api/sessions/$sessionId/agents/$mid/tools") -Headers $auth -TimeoutSec $TimeoutSec
    if ($tl.status -eq 200 -and $tl.bodyPreview) {
      try { $tj = $tl.bodyPreview | ConvertFrom-Json; Write-Host ("   tools: {0} 个" -f $tj.Count); $detail.toolCount = $tj.Count }
      catch { $detail.toolsRaw = $tl.bodyPreview }
    } else { Write-Host ("   tools: HTTP {0}" -f $tl.status) }
    $report.agentDetails += $detail
  }

  $deadline = (Get-Date).AddMinutes([Math]::Max($FollowMin, 0.2))
  Write-Section ("事件流 GET /api/sessions/{id}/events(跟踪 " + [Math]::Max($FollowMin,0.2) + " 分钟)")
  $seenEvents = 0
  while ((Get-Date) -lt $deadline) {
    $ev = Invoke-Probe -Url ($script:AgonBase + "/api/sessions/$sessionId/events?limit=100") -Headers $auth -TimeoutSec $TimeoutSec
    if ($ev.status -eq 200 -and $ev.bodyPreview) {
      $seenEvents++
      $evHints = Find-ModelHints -Text $ev.bodyPreview
      if ($evHints) {
        Write-Host '  *** 事件流疑似模型字段:' -ForegroundColor Green
        $evHints | Select-Object -First 10 | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor Green }
        $report.eventHints = $evHints
      }
      $report.eventsPreview = $ev.bodyPreview.Substring(0,[Math]::Min(1200,$ev.bodyPreview.Length))
    } else { Write-Host ("  events: HTTP {0}" -f $ev.status) }
    if ($FollowMin -le 0) { break }
    Start-Sleep -Seconds 10
  }

  if ($Cleanup -and $sessionId) {
    Write-Section '清理会话(DELETE)'
    $del = Invoke-Probe -Url ($script:AgonBase + "/api/sessions/$sessionId") -Method 'DELETE' -Headers $auth -TimeoutSec $TimeoutSec
    Write-Host ("HTTP {0}" -f $del.status)
    $report.cleanup = $del.status
  }

  Write-Host ''
  Write-Host ("完成。会话 {0} 可在 {1}/chat/{0} 查看(若路由开放)。" -f $sessionId, $BaseUrl) -ForegroundColor Cyan
  return $report
}

# ================= 主流程 =================
switch ($Mode) {
  'infra' { $r = Invoke-Infra; Save-JsonLine $r $OutFile }
  'api'   { $r = Invoke-Api;   Save-JsonLine $r $OutFile }
  'run'   { $r = Invoke-Run;   Save-JsonLine $r $OutFile }
  'auto'  { $r = Invoke-Auto;  Save-JsonLine $r $OutFile }
  'watch' {
    Write-Host ("每 {0}s 探测一次 {1},Ctrl+C 停止。" -f $WatchSeconds, $BaseUrl) -ForegroundColor Cyan
    while ($true) {
      $one = Invoke-Probe -Url $BaseUrl -TimeoutSec $TimeoutSec
      $line = [ordered]@{
        at = (Get-Date).ToUniversalTime().ToString('o')
        status = $one.status; elapsedMs = $one.elapsedMs
        server = $one.server; xVercelId = [string]$one.headers['x-vercel-id']
        error = $one.error
      }
      Write-Host ("{0}  HTTP {1}  {2}ms  {3}" -f $line.at, $line.status, $line.elapsedMs, $line.error)
      Save-JsonLine $line $OutFile
      Start-Sleep -Seconds $WatchSeconds
    }
  }
}
