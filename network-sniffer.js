/* v2.9.0 网络层只读嗅探（MAIN world，document_start）。
   目的：arena.ai 页面自己的请求/响应里就带着模型线索，不用发任何探测消息。
     · 请求体里的 modelAId / model / modelBId 等字段（页面发送时带）
     · 响应头 public-access-token（一次运行一个公开 JWT，可换 Trigger.dev 运行轨迹）
     · 流式响应的分片到达时间与字节数（节奏通道的原始信号，见 rhythm-channel.js）
   铁律：只读。绝不改写请求、响应、headers 或 body；hook 只是包一层再原样调用。
   采集到的东西通过 window.postMessage 交给隔离世界的 content.js，再转 background.js。
   隐私：public JWT 会经 window.postMessage 临时桥接（同页脚本也可能看到）；扩展不把 token 写磁盘；流内容不落地，只留模型字段/分片时间和字节。 */
(() => {
  if (globalThis.__ampSnifferInstalled) return;
  globalThis.__ampSnifferInstalled = true;

  const SOURCE = 'amp-network-sniffer';
  const MODEL_KEYS = /^(model|modelaid|modelbid|model_a|model_b|modelid|model_id|modelname|model_name|llm|llmmodel|providermodel)$/i;
  const TOKEN_HEADER = 'public-access-token';
  /* v2.10.0 价格通道 + v2.11.0 用量通道：
     · 价格：Arena 只在榜单页公开「每模型任务成本」，会话响应里不下发美元成本；
       但一旦响应里出现 cost/price/spend/credits 字段，立刻只读抓取（字段名+数值）。
     · 用量：**实测已下发** —— GET /api/evaluation/<sid> 的 messages[].metadata.usage 带
       inputTokens / outputTokens / totalTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens
       （2026-10-11 CDP 实测，见 Arena成本接口实测.md）。整个 usage 对象只读抽出交给 background。
     两条通道都不落地正文、不改请求。 */
  /* v2.13.1 修正：旧字段表**漏掉了 Arena `/cost` 会话级聚合的真实字段名** ——
     `actualTotalUsd` / `chargedTotalUsd` / `costMultiplier` / `marginMultiplier` /
     `totalChargedCredits` / 9 个分项 `*CostUsd`（字段名抄自 bundle 的 zod schema，见 Arena成本接口实测.md §7）。
     影响：结构化解析（scanCostRoute）本来能从 `session.actualTotalUsd` 拿到 base，但它**硬依赖 JSON.parse**；
     响应被流式切碎/被包装导致解析失败时只剩正则兜底 —— 而旧表在那条路径上只能靠 `basePriceUsd` / `totalCostUsd`
     勉强兜到 base，**实扣价与加价倍率永远拿不到**（截图里的 `charged` 与 ×2 就是这么漏的）。
     字段表必须与 pricing-channel.js 的 COST_FIELD_RE 保持一致。 */
  const COST_FIELD_RE = /"(actualtotalusd|chargedtotalusd|totalcostusd|totalchargedusd|basepriceusd|totalcost|costusd|priceusd|spend|totalcharged|costpertaskusd|priceperimage|inputtokenscostusd|outputtokenscostusd|cachewritetokenscostusd|cachereadtokenscostusd|textoutputtokenscostusd|imageinputtokenscostusd|imageoutputtokenscostusd|imagegenerationcostusd|videogenerationcostusd|actual_total_usd|charged_total_usd|total_cost_usd|total_charged_usd|base_price_usd|cost_usd|price_usd|total_charged|totalchargedcredits|total_charged_credits|creditsused|credits_used|costmultiplier|marginmultiplier|discountpercent|discount_percent|cost|total_tokens|prompt_tokens|completion_tokens|input_tokens|output_tokens|cache_read_tokens|cache_write_tokens|reasoning_tokens|inputtokens|outputtokens)"\s*:\s*"?(-?[0-9]+(?:\.[0-9]+)?)"?/gi;
  const COST_MARKER_RE = /cost|usd|spend|credits|charge|price|multiplier|_tokens|Tokens|usage/i;
  /* 单位归类。顺序要紧：先判倍率/积分，再判美元，最后才是 token ——
     否则 `inputTokensCostUsd` 会因含 "tokens" 被误判成 token 数。
     必须与 pricing-channel.js 的 unitOfCostField 保持一致。 */
  function unitOfCostField(field) {
    const key = String(field || '').toLowerCase();
    if (/multiplier|discount/.test(key)) return 'multiplier';
    if (/credits/.test(key)) return 'credits';
    if (/usd$|cost|price|spend|charge/.test(key)) return 'usd';
    if (/tokens/.test(key)) return 'tokens';
    return 'other';
  }
  const MAX_COST = 24;
  /* 用量字段：camelCase 是 Arena 实测口径，snake_case 作兼容兜底。 */
  const USAGE_FIELDS = {inputTokens: 1, outputTokens: 1, totalTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 1};
  const USAGE_FIELD_RE = /"(inputTokens|outputTokens|totalTokens|cacheReadTokens|cacheWriteTokens|reasoningTokens|input_tokens|output_tokens|total_tokens|cache_read_tokens|cache_write_tokens|reasoning_tokens)"\s*:\s*(\d{1,12})/g;
  const USAGE_SNAKE = {input_tokens: 'inputTokens', output_tokens: 'outputTokens', total_tokens: 'totalTokens', cache_read_tokens: 'cacheReadTokens', cache_write_tokens: 'cacheWriteTokens', reasoning_tokens: 'reasoningTokens'};
  const USAGE_MARKER_RE = /"usage"\s*:\s*\{|inputTokens|input_tokens/;
  /* v2.13.0 真实按次成本路由：GET /api/chat/:id/cost（Agent）与 /api/evaluation/:id/cost（Battle）。
     v2.13.x 实测按账号灰度、一律 403；**v2.16.0 已查明门禁机制**：服务端读 PostHog flag override
     cookie `ph-toolbar-overrides`，临时写 {"credit-system-m1":"cost-shown"} 即放行（CDP 实测 200）。
     主动取数（带 cookie）在 content.js 的 probeCostRoute/fetchCostPath；这里只保留**被动**观察：
     页面自己请求 /cost 且回 200 时（例如用户先在网站上开了费用显示），结构化解析每条消息的成本。 */
  const COST_ROUTE_RE = /\/api\/(chat|evaluation)\/[^\/?#]+\/cost(\?|$)/;
  const costRouteSeen = new Set();
  let costGateReported = false;
  const MAX_USAGE = 12;
  const MAX_TEXT = 240;
  const MAX_EVIDENCE = 400;
  const MAX_MODELS = 40;
  const FLUSH_MS = 1500;

  const evidence = [];
  const models = [];
  const modelSeen = new Set();
  const tokenSeen = new Set();
  const costSeen = new Set();
  const usageSeen = new Set();
  let aliveReported = false;
  const scanStats = {req: 0, body: 0, chunks: 0, urls: []};
  function rememberUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ''), location.origin);
      const entry = `${parsed.host}${parsed.pathname.slice(0, 48)}`;
      if (scanStats.urls[0] !== entry) {
        scanStats.urls.unshift(entry);
        scanStats.urls = scanStats.urls.slice(0, 6);
      }
    } catch { /* ignore */ }
  }
  /* 心跳：只要拦到第一条页面请求就上报一次，让浮层能区分「嗅探器没注入」和「注入了但没扫到东西」。 */
  function reportAlive() {
    if (aliveReported) return;
    aliveReported = true;
    evidence.push({kind: 'alive', at: Date.now()});
    schedule();
  }
  /* 让浮层能看到扫描量：请求几条、正文几条、流片几片（只计数，不含内容）。 */
  function reportStats() {
    evidence.push({kind: 'stats', req: scanStats.req, body: scanStats.body, chunks: scanStats.chunks, urls: scanStats.urls.slice(0, 6), at: Date.now()});
    schedule();
  }
  let timer = null;

  const now = () => Math.round(performance.now());

  function post() {
    if (!evidence.length && !models.length) return;
    const payload = { source: SOURCE, evidence: evidence.splice(0, evidence.length), models: models.splice(0, models.length), at: Date.now() };
    try { window.postMessage(payload, '*'); } catch { /* 页面可能已销毁 */ }
  }

  function schedule() {
    if (timer === null) timer = setTimeout(() => { timer = null; post(); }, FLUSH_MS);
  }

  function pushModel(name, where, url) {
    const value = String(name || '').slice(0, 120);
    if (!value) return;
    const requestUrl = String(url || '').slice(0, 200);
    const key = value + '|' + where + '|' + requestUrl;
    if (modelSeen.has(key)) return;
    modelSeen.add(key);
    models.push({ name: value, where, url: requestUrl });
    schedule();
  }

  function pushToken(token, url, extra) {
    const value = String(token || '');
    if (value.length < 20) return;
    const key = value.slice(0, 40);
    if (tokenSeen.has(key)) return;
    tokenSeen.add(key);
    evidence.push({ kind: 'token', token: value, url: String(url || '').slice(0, 200), at: Date.now(), ...extra });
    schedule();
  }

  /* v2.9.3：Arena 可能把运行 token 从响应头挪进了响应体/SSE。扫 JWT 形状的串，
     且解码后的 payload 含 run/trace/trigger/public/otel 才收，避免把页面登录态误当运行 token。 */
  function looksLikePublicRunToken(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), character => character.charCodeAt(0))));
      return /run|trace|trigger|public|otel/i.test(JSON.stringify(payload));
    } catch { return false; }
  }

  /* v2.10.0 价格通道：从响应文本里只读抽出成本/用量字段（字段名 + 数值，最多 24 条）。 */
  function scanCost(text, where, url) {
    const source = String(text || '');
    if (!source || source.length > 400000 || !COST_MARKER_RE.test(source)) return;
    let match;
    let guard = 0;
    COST_FIELD_RE.lastIndex = 0;
    while ((match = COST_FIELD_RE.exec(source)) && guard < MAX_COST) {
      guard += 1;
      const field = match[1].toLowerCase();
      const value = Number(match[2]);
      if (!Number.isFinite(value) || value < 0 || value > 1e7) continue;
      const key = field + '=' + value;
      if (costSeen.has(key)) continue;
      costSeen.add(key);
      /* v2.13.1：单位交给 unitOfCostField 判（旧代码用 `/cost|price|spend|credit|charge/` 二分，
         把 `creditsUsed` 误判成美元、把倍率类字段误判成 token 数）。 */
      evidence.push({kind: 'cost', field, value, unit: unitOfCostField(field), where: String(where).slice(0, 60), url: String(url).slice(0, 200), at: Date.now()});
      schedule();
    }
    if (evidence.length > MAX_EVIDENCE) evidence.splice(0, evidence.length - MAX_EVIDENCE);
  }

  /* v2.13.0 结构化解析 /cost 路由的 200 响应：
     {session:{actualTotalUsd,chargedTotalUsd,basePriceUsd,costMultiplier,marginMultiplier,messageCount,...},
      messages:{[messageId]:{actual:{totalCostUsd,basePriceUsd,...},...}}}
     只收 messageId + USD 数字，不碰任何消息正文。
     v2.13.1：session 层补收 basePriceUsd / costMultiplier / marginMultiplier ——
     实测 base 才是与「Σ token × 公开单价」同口径的那一半（见 Arena成本接口实测.md §7）。 */
  function scanCostRoute(text, url) {
    const source = String(text || '');
    if (!source) return;
    let parsed = null;
    try { parsed = JSON.parse(source); } catch { return; }
    if (!parsed || typeof parsed !== 'object') return;
    const pickUsd = (obj) => {
      const value = Number(obj?.totalCostUsd ?? obj?.actualTotalUsd);
      return Number.isFinite(value) && value >= 0 && value <= 1e7 ? value : null;
    };
    const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
    const session = parsed.session && typeof parsed.session === 'object' ? {
      actualTotalUsd: num(parsed.session.actualTotalUsd),
      chargedTotalUsd: num(parsed.session.chargedTotalUsd),
      basePriceUsd: num(parsed.session.basePriceUsd),
      costMultiplier: num(parsed.session.costMultiplier),
      marginMultiplier: num(parsed.session.marginMultiplier),
      messageCount: Number(parsed.session.messageCount) || null,
    } : null;
    const messages = [];
    if (parsed.messages && typeof parsed.messages === 'object') {
      for (const [messageId, entry] of Object.entries(parsed.messages)) {
        if (messages.length >= 50) break;
        const actual = entry && typeof entry === 'object' && entry.actual && typeof entry.actual === 'object' ? entry.actual : null;
        const actualUsd = pickUsd(actual);
        if (actualUsd === null) continue;
        messages.push({message_id: String(messageId).slice(0, 64), actual_usd: actualUsd});
      }
    }
    if (!session && !messages.length) return;
    const signature = JSON.stringify([session, messages]);
    if (costRouteSeen.has(signature)) return;
    costRouteSeen.add(signature);
    evidence.push({kind: 'cost-route', route: 'cost-api', session, messages, url: String(url).slice(0, 200), at: Date.now()});
    schedule();
    if (evidence.length > MAX_EVIDENCE) evidence.splice(0, evidence.length - MAX_EVIDENCE);
  }

  /* v2.13.2 花费账本：结构化抽 `/api/evaluation/<sid>` 的**逐条**用量（带消息身份）。
     与 scanUsage 的区别：那个只扫 `"usage":{...}` 字段、不带消息 id，摊不成「逐条明细」；
     这里解析整个 JSON，把 id / role / participantPosition / modelId 一起带出来。
     实测消息形状：{id, role, participantPosition, modelId, metadata:{usage:{…}}}。 */
  const SESSION_ROUTE_RE = /\/api\/(?:evaluation|chat)\/[^\/?#]+(?:$|\?|\/)/;
  const messageUsageSeen = new Set();
  /* v2.14.0 Agent 转录估算：/api/chat/<sid> 的会话包**没有** usage 字段（实测），
     于是把 assistant 的 parts（正文 text + 思考 reasoning）按字数折成 token 估算上报。
     只报数字与字符计数、不带任何正文。 */
  const transcriptSeen = new Set();
  const isCjkCp = (cp) => (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f200 && cp <= 0x1f2ff)
    || (cp >= 0x20000 && cp <= 0x2ffff);
  function charBuckets(text) {
    const out = {chars: 0, cjk: 0, other: 0};
    for (const ch of String(text || '')) {
      if (isCjkCp(ch.codePointAt(0))) out.cjk += 1; else out.other += 1;
      out.chars += 1;
    }
    return out;
  }
  function scanTranscriptEstimate(messages, url) {
    let count = 0;
    /* v2.15.0：把用户消息的正文统计留住，配给紧随其后的 assistant 回复，作为**输入下界**
       （只含用户文字，不含历史上下文与系统提示）。一条 user 可对应多步 assistant，所以不重置。 */
    let lastUser = null;
    for (const message of messages) {
      if (count >= 60) break;
      if (!message || typeof message !== 'object') continue;
      const parts = Array.isArray(message.parts) ? message.parts : [];
      if (message.role === 'user') {
        const bucket = {chars: 0, cjk: 0, other: 0};
        for (const part of parts) {
          if (!part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') continue;
          const counted = charBuckets(part.text);
          bucket.chars += counted.chars; bucket.cjk += counted.cjk; bucket.other += counted.other;
        }
        lastUser = {message_id: typeof message.id === 'string' ? message.id.slice(0, 64) : null, chars: bucket};
        continue;
      }
      if (message.role !== 'assistant') continue;
      const text = {chars: 0, cjk: 0, other: 0};
      const reasoning = {chars: 0, cjk: 0, other: 0};
      for (const part of parts) {
        if (!part || typeof part !== 'object' || typeof part.text !== 'string') continue;
        const bucket = part.type === 'text' ? text : (part.type === 'reasoning' ? reasoning : null);
        if (!bucket) continue;
        const counted = charBuckets(part.text);
        bucket.chars += counted.chars; bucket.cjk += counted.cjk; bucket.other += counted.other;
      }
      if (!text.chars && !reasoning.chars) continue;
      const messageId = typeof message.id === 'string' ? message.id.slice(0, 64) : null;
      const key = `${messageId || ''}|${text.chars},${text.cjk},${text.other}|${reasoning.chars},${reasoning.cjk},${reasoning.other}`;
      /* 认领输入下界：**在 dedup 之前**认领，保证同一条消息每次遍历结果一致
         （否则重复抓取时同一条回复会一次带输入、一次不带）。 */
      const inputChars = lastUser ? lastUser.chars : null;
      const inputMessageId = lastUser ? lastUser.message_id : null;
      lastUser = null;
      if (transcriptSeen.has(key)) continue;
      transcriptSeen.add(key);
      count += 1;
      evidence.push({
        kind: 'transcript-estimate',
        message_id: messageId,
        role: 'assistant',
        model_id: typeof message.modelId === 'string' ? message.modelId.slice(0, 120) : null,
        chars: {text, reasoning},
        input_chars: inputChars,
        input_message_id: inputMessageId,
        url: String(url).slice(0, 200),
        at: Date.now(),
      });
      schedule();
    }
    if (evidence.length > MAX_EVIDENCE) evidence.splice(0, evidence.length - MAX_EVIDENCE);
  }
  function scanMessageUsage(text, url) {
    const source = String(text || '');
    if (!source || source.length > 400000) return;
    let parsed = null;
    try { parsed = JSON.parse(source); } catch { return; }
    const messages = parsed && Array.isArray(parsed.messages) ? parsed.messages : null;
    if (!messages) return;
    /* 没有 usage（Agent 常态）→ 走转录字数估算。
       v2.15.0 修正判据：看**实际消息**有没有 metadata.usage，而不是整串里有没有 "usage" 字样 ——
       会话包里别的字段偶尔带 usage 一词时，旧写法会走 usage 路径然后一条都产不出来（静默空转）。 */
    const hasUsage = messages.some((message) => message && message.metadata && message.metadata.usage);
    if (!hasUsage) { scanTranscriptEstimate(messages, url); return; }
    let count = 0;
    for (const message of messages) {
      if (count >= 60) break;
      if (!message || typeof message !== 'object') continue;
      const usage = normalizeUsage(message.metadata && message.metadata.usage);
      if (!usage) continue;
      const messageId = typeof message.id === 'string' ? message.id.slice(0, 64) : null;
      const key = `${messageId}|${usage.inputTokens || 0},${usage.outputTokens || 0},${usage.cacheReadTokens || 0},${usage.cacheWriteTokens || 0},${usage.reasoningTokens || 0}`;
      if (messageUsageSeen.has(key)) continue;
      messageUsageSeen.add(key);
      count += 1;
      evidence.push({
        kind: 'message-usage',
        message_id: messageId,
        role: typeof message.role === 'string' ? message.role.slice(0, 20) : null,
        position: typeof message.participantPosition === 'string' ? message.participantPosition.slice(0, 4) : null,
        model_id: typeof message.modelId === 'string' ? message.modelId.slice(0, 120) : null,
        usage,
        url: String(url).slice(0, 200),
        at: Date.now(),
      });
      schedule();
    }
    if (evidence.length > MAX_EVIDENCE) evidence.splice(0, evidence.length - MAX_EVIDENCE);
  }

  /* v2.11.0 用量通道：花括号配对切出 "usage":{...}（含字符串/转义处理），归一化成 token 计数。 */
  function sliceObject(text, start, maxLen) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    const end = Math.min(text.length, start + maxLen);
    for (let i = start; i < end; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }

  function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const usage = {type: typeof raw.type === 'string' ? raw.type.slice(0, 40) : null};
    let has = false;
    for (const key of Object.keys(USAGE_FIELDS)) {
      const value = raw[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9) continue;
      usage[key] = Math.round(value);
      has = true;
    }
    if (!has) return null;
    if (!(usage.totalTokens > 0)) usage.totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
    if (!(usage.totalTokens > 0)) return null;
    return usage;
  }

  const usageSignature = (usage) => `${(usage.cacheWriteTokens || 0) > 0 ? 'cw' : '--'}${(usage.cacheReadTokens || 0) > 0 ? 'cr' : '--'}${(usage.reasoningTokens || 0) > 0 ? 'rz' : '--'}`;
  const usageKey = (usage) => Object.keys(USAGE_FIELDS).map((field) => usage[field] || 0).join(',');

  function pushUsage(usage, where, url) {
    const key = usageKey(usage);
    if (usageSeen.has(key)) return;
    usageSeen.add(key);
    evidence.push({kind: 'usage', usage, signature: usageSignature(usage), where: String(where).slice(0, 60), url: String(url).slice(0, 200), at: Date.now()});
    schedule();
    if (evidence.length > MAX_EVIDENCE) evidence.splice(0, evidence.length - MAX_EVIDENCE);
  }

  function scanUsage(text, where, url) {
    const source = String(text || '');
    if (!source || source.length > 400000 || !USAGE_MARKER_RE.test(source)) return;
    let idx = 0;
    let guard = 0;
    while (guard < MAX_USAGE) {
      const at = source.indexOf('"usage"', idx);
      if (at < 0) break;
      guard += 1;
      const brace = source.indexOf('{', at);
      idx = at + 7;
      if (brace < 0 || brace - at > 40) continue;
      const slice = sliceObject(source, brace, 2000);
      if (!slice) continue;
      let parsed = null;
      try { parsed = JSON.parse(slice); } catch {
        try { parsed = JSON.parse(slice.replace(/\\"/g, '"')); } catch { parsed = null; }
      }
      const usage = normalizeUsage(parsed);
      if (usage) pushUsage(usage, where, url);
    }
    // 兜底：对象被流式截断时按字段正则凑一条。
    if (!guard) {
      USAGE_FIELD_RE.lastIndex = 0;
      const loose = {};
      let match;
      let n = 0;
      while ((match = USAGE_FIELD_RE.exec(source)) && n < 12) {
        n += 1;
        const field = USAGE_SNAKE[match[1]] || match[1];
        const value = Number(match[2]);
        if (Number.isFinite(value) && value >= 0 && value <= 1e9) loose[field] = value;
      }
      const usage = normalizeUsage(loose);
      if (usage) pushUsage(usage, where, url);
    }
  }

  /* 从文本里挖 "model*": "value" 形式的字段；只取短值，避免把正文当模型名。 */
  function scanText(text, where, url) {
    const source = String(text || '');
    if (!source) return;
    const urlText = String(url || '');
    const whereText = String(where || '');
    // 页面性能：正文里不含任何可能命中的线索（model 字段 / JWT 前缀 / run_ id）时直接返回，跳过大请求体上的三次正则扫描。
    /* v2.13.0 / v2.13.2：路由响应体走结构化解析。
       判据用「where 里不含 request」而**不是**「where 含 response」——
       fetch 的响应 where 是 'fetch.body' / 'fetch.stream'，字面上不含 "response"，
       旧写法（`/response|eventsource/`）会让 /cost 与 /api/evaluation 的结构化解析**永远不触发**。
       /cost 优先于 /api/chat/<id>（前者 URL 也匹配后者的形状）。 */
    if (!/request/i.test(whereText)) {
      if (COST_ROUTE_RE.test(urlText)) scanCostRoute(source, url);
      else if (SESSION_ROUTE_RE.test(urlText)) scanMessageUsage(source, url);
    }
    if (COST_MARKER_RE.test(source)) { scanCost(source, where, url); scanUsage(source, where, url); }
    if (source.indexOf('model') < 0 && source.indexOf('eyJ') < 0 && source.indexOf('run_') < 0) return;
    const jwt = source.match(/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/);
    if (jwt && looksLikePublicRunToken(jwt[0])) pushToken(jwt[0], url, {via: where + ':jwt-body'});
    const re = /"(model[A-Za-z_]{0,12})"\s*:\s*"([^"]{1,80})"/g;
    let match;
    let guard = 0;
    while ((match = re.exec(source)) && guard < 40) {
      guard += 1;
      if (MODEL_KEYS.test(match[1]) || /^model/i.test(match[1])) pushModel(match[2], where + ':' + match[1], url);
    }
    const runId = source.match(/\brun_[A-Za-z0-9]{6,60}\b/);
    if (runId) pushModel(runId[0], where + ':runId', url);
    if (url) {
      const inUrl = String(url).match(/\brun_[A-Za-z0-9]{6,60}\b/);
      if (inUrl) pushModel(inUrl[0], 'url:runId', url);
    }
  }

  function scanHeaders(headers, url) {
    const get = typeof headers?.get === 'function' ? (name) => headers.get(name) : (name) => headers?.[name] ?? headers?.[String(name).toLowerCase()];
    const token = get(TOKEN_HEADER) || get('x-public-access-token') || get('public_access_token');
    if (token) pushToken(token, url, { via: 'header' });
  }

  function streamStats(runId, url) {
    return { kind: 'stream', runId, url: String(url || '').slice(0, 200), t0: now(), chunks: 0, bytes: 0, gaps: [], last: 0 };
  }

  function recordChunk(stream, size) {
    const at = now();
    if (stream.last) {
      const gap = at - stream.last;
      if (stream.gaps.length < 4000) stream.gaps.push(gap);
    }
    stream.last = at;
    stream.chunks += 1;
    stream.bytes += Number(size) || 0;
  }

  function finishStream(stream) {
    if (!stream.chunks) return;
    evidence.push({
      kind: 'stream',
      runId: stream.runId,
      url: stream.url,
      chunks: stream.chunks,
      bytes: stream.bytes,
      duration_ms: now() - stream.t0,
      gaps: stream.gaps.slice(0, 2000),
      at: Date.now(),
    });
    if (evidence.length > MAX_EVIDENCE) evidence.splice(0, evidence.length - MAX_EVIDENCE);
    schedule();
    /* v2.15.0：一次流结束往往意味着新回复已落库 —— 顺势补取一次转录（见文末主动取转录）。 */
    if (activeTarget()) scheduleActiveFetch(2000);
  }

  const runIdOf = (url) => (String(url || '').match(/\brun_[A-Za-z0-9]{6,60}\b/) || [null])[0];

  /* ---------- fetch ---------- */
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      reportAlive();
      scanStats.req += 1;
      let url = '';
      let bodyText = '';
      let requestBody = null;
      try {
        url = typeof input === 'string' ? input : (input?.url || '');
        const raw = init?.body;
        if (typeof raw === 'string') bodyText = raw;
        else if (raw instanceof URLSearchParams) bodyText = raw.toString();
        else if (typeof FormData === 'function' && raw instanceof FormData) {
          try { requestBody = new Response(raw).text().catch(() => ''); } catch { /* ignore */ }
        }
        else if (raw == null && typeof Request === 'function' && input instanceof Request && input.body) {
          // clone() gives us a second reader without locking or changing the page's original Request.
          requestBody = input.clone().text().catch(() => '');
        }
      } catch { /* 读不到就算了 */ }
      rememberUrl(url);
      if (bodyText) { scanStats.body += 1; scanText(bodyText.slice(0, 200000), 'fetch.request', url); }
      else if (requestBody) void requestBody.then((text) => { if (text) { scanStats.body += 1; scanText(text.slice(0, 200000), 'fetch.request', url); } }).catch(() => {});
      reportStats();
      const result = nativeFetch.apply(this, arguments);
      if (!(result instanceof Promise)) return result;
      return result.then((response) => {
        try {
          scanHeaders(response.headers, url);
          /* v2.13.0：/cost 路由 403 = 账号灰度门（路由存在但未开放），上报一次供浮层解释「为什么没有真实成本」。 */
          if (COST_ROUTE_RE.test(String(url || '')) && response.status === 403 && !costGateReported) {
            costGateReported = true;
            evidence.push({kind: 'cost-gate', status: 403, url: String(url).slice(0, 200), at: Date.now()});
            schedule();
          }
          const type = String(response.headers?.get?.('content-type') || '');
          if (/event-stream|json|text/i.test(type) && typeof response.clone === 'function') {
            const stream = streamStats(runIdOf(url), url);
            const clone = response.clone();
            /* v2.11.0 修正：只有 SSE 才走「逐片扫描」。JSON（如 /api/evaluation/<sid> 的 262 KB 会话包）
               若走流式路径，每片只扫前 MAX_TEXT*40=9600 字符，usage 全在后面 → 永远抓不到。
               实测就是栽在这里：响应 200、含 usage，但嗅探器 0 命中。 */
            const isSse = /event-stream/i.test(type);
            if (isSse && clone?.body && typeof clone.body.getReader === 'function') {
              const reader = clone.body.getReader();
              const pump = () => reader.read().then((chunk) => {
                if (chunk?.value) {
                  recordChunk(stream, chunk.value.byteLength || chunk.value.length || 0);
                  scanStats.chunks += 1;
                  /* fetch 流的分片是 Uint8Array，必须先解码再扫 —— 旧代码只扫 string 分片，等于从没扫过流。 */
                  const text = typeof chunk.value === 'string'
                    ? chunk.value
                    : (() => { try { return new TextDecoder('utf-8').decode(chunk.value); } catch { return ''; } })();
                  if (text) scanText(text.slice(0, MAX_TEXT * 40), 'fetch.stream', url);
                  return pump();
                }
                finishStream(stream);
                return undefined;
              }).catch(() => finishStream(stream));
              void pump();
            } else {
              void clone.text().then((text) => {
                recordChunk(stream, text.length);
                scanText(text.slice(0, 200000), 'fetch.body', url);
                finishStream(stream);
              }).catch(() => {});
            }
          }
        } catch { /* 只读观测失败不影响页面 */ }
        return response;
      });
    };
  }

  /* ---------- XMLHttpRequest ---------- */
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    try { this.__ampUrl = String(url || ''); } catch { /* ignore */ }
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function patchedSend(body) {
    try {
      reportAlive();
      scanStats.req += 1;
      rememberUrl(this.__ampUrl);
      if (typeof body === 'string') { scanStats.body += 1; scanText(body.slice(0, 200000), 'xhr.request', this.__ampUrl); }
      reportStats();
      this.addEventListener('load', () => {
        try {
          const token = this.getResponseHeader?.(TOKEN_HEADER) || this.getResponseHeader?.('x-public-access-token');
          if (token) pushToken(token, this.__ampUrl, { via: 'xhr-header' });
          const type = String(this.getResponseHeader?.('content-type') || '');
          if (/json|text/i.test(type) && typeof this.responseText === 'string') scanText(this.responseText.slice(0, 200000), 'xhr.response', this.__ampUrl);
        } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
    return nativeSend.apply(this, arguments);
  };

  /* ---------- EventSource ---------- */
  const NativeEventSource = window.EventSource;
  if (typeof NativeEventSource === 'function') {
    const patchedEventSource = function PatchedEventSource(url, config) {
      const source = config === undefined ? new NativeEventSource(url) : new NativeEventSource(url, config);
      try {
        const stream = streamStats(runIdOf(url), url);
        rememberUrl(url);
        source.addEventListener('message', (event) => {
          recordChunk(stream, String(event?.data || '').length);
          scanStats.chunks += 1;
          scanText(String(event?.data || '').slice(0, MAX_TEXT * 40), 'eventsource', url);
        });
        source.addEventListener('error', () => finishStream(stream));
        window.addEventListener('pagehide', () => finishStream(stream), { once: true });
      } catch { /* ignore */ }
      return source;
    };
    patchedEventSource.prototype = NativeEventSource.prototype;
    try {
      Object.defineProperty(patchedEventSource, 'name', { value: 'EventSource', configurable: true });
      for (const key of Object.getOwnPropertyNames(NativeEventSource)) {
        if (!(key in patchedEventSource)) {
          try { patchedEventSource[key] = NativeEventSource[key]; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    window.EventSource = patchedEventSource;
  }

  /* ---------- Worker 搭车扫描 ---------- */
  /* v2.9.3：已确认 Arena 的聊天请求（/api/chat/*）从 Web Worker 发出，页面主线程钩子看不到。
     这里包一层 Worker/SharedWorker 构造器：额外挂一个只读 message 监听扫往返数据，
     outgoing postMessage 只扫不改 —— 不触碰页面自己的回调，不改变任何数据。 */
  /* v2.9.24：主线程降耗 —— 高频 Worker/WS 消息不再整包 JSON.stringify：字符串直扫；
     对象只收短字段（<=2KB 字符串、小嵌套对象、标量），大字符串与二进制直接跳过（顺带更贴合「流内容不落地」）。 */
  function scanableText(data) {
    if (typeof data === 'string') return data;
    if (!data || typeof data !== 'object') return '';
    if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer || (typeof Blob !== 'undefined' && data instanceof Blob)) return '';
    try {
      const parts = []; let size = 0;
      for (const key of Object.keys(data)) {
        const value = data[key];
        if (typeof value === 'string') { if (value.length <= 2048) { parts.push(value); size += value.length; } }
        else if (typeof value === 'number' || typeof value === 'boolean') { parts.push(String(value)); size += 4; }
        else if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(typeof Blob !== 'undefined' && value instanceof Blob)) {
          try { const s = JSON.stringify(value); if (s && s.length <= 2048) { parts.push(s); size += s.length; } } catch { /* ignore */ }
        }
        if (size > 8192) break;
      }
      return parts.join(' ');
    } catch { return ''; }
  }
  function tapPort(port, label) {
    try {
      port.addEventListener('message', (event) => {
        scanStats.chunks += 1;
        const text = scanableText(event?.data);
        if (text) scanText(text.slice(0, MAX_TEXT * 40), label + ':in', '');
      });
    } catch { /* ignore */ }
  }
  const NativeWorker = window.Worker;
  if (typeof NativeWorker === 'function') {
    function PatchedWorker(url, options) {
      const worker = new NativeWorker(url, options);
      try {
        tapPort(worker, 'worker');
        const nativePost = worker.postMessage.bind(worker);
        worker.postMessage = function patchedWorkerPost() {
          try {
            scanStats.body += 1;
            const text = scanableText(arguments[0]);
            if (text) scanText(text.slice(0, 200000), 'worker:out', String(url || '').slice(0, 120));
          } catch { /* ignore */ }
          return nativePost.apply(null, arguments);
        };
      } catch { /* ignore */ }
      return worker;
    }
    PatchedWorker.prototype = NativeWorker.prototype;
    window.Worker = PatchedWorker;
  }
  const NativeSharedWorker = window.SharedWorker;
  if (typeof NativeSharedWorker === 'function') {
    function PatchedSharedWorker(url, options) {
      const shared = new NativeSharedWorker(url, options);
      try { tapPort(shared.port, 'shared-worker'); } catch { /* ignore */ }
      return shared;
    }
    PatchedSharedWorker.prototype = NativeSharedWorker.prototype;
    window.SharedWorker = PatchedSharedWorker;
  }

  /* ---------- WebSocket ---------- */
  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    const patchedWebSocket = function PatchedWebSocket(url, protocols) {
      const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      try {
        const stream = streamStats(runIdOf(url), url);
        socket.addEventListener('message', (event) => {
          const data = event?.data;
          const size = typeof data === 'string' ? data.length : (data?.byteLength || data?.size || 0);
          recordChunk(stream, size);
          if (typeof data === 'string') scanText(data.slice(0, MAX_TEXT * 40), 'websocket', url);
        });
        socket.addEventListener('close', () => finishStream(stream));
      } catch { /* ignore */ }
      return socket;
    };
    patchedWebSocket.prototype = NativeWebSocket.prototype;
    try {
      Object.defineProperty(patchedWebSocket, 'name', { value: 'WebSocket', configurable: true });
      for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) patchedWebSocket[key] = NativeWebSocket[key];
    } catch { /* ignore */ }
    window.WebSocket = patchedWebSocket;
  }

  /* ---------- v2.15.0 主动取转录 ----------
     v2.14.0 实测：Agent 页自身的会话包请求走 **Worker / RSC**，主线程的 fetch/XHR 钩子看不到，
     于是转录估算通道在真实页面上一条证据都产不出来（CDP 实测 transcriptEstimates: []）。
     但同一份数据**同源 GET 就能拿到**（实测 200 / 15 KB / messages[].parts 带正文与 thinking）。
     所以这里在页面上下文主动取一次 —— 页面自己就是这么取的，同源、只读、不改任何东西，
     取回后交给与被动路径**完全相同**的 scanText 解析：有 usage 用 usage，没有就按字数估 token。
     触发点：初始加载、SPA 路由变化、实时流结束（新回复落库后）。节流 2.5 s、每页上限 60 次。 */
  const ACTIVE_ROUTE_RE = /^\/(agent|battle)\/([0-9a-fA-F][0-9a-fA-F-]{7,})/;
  const ACTIVE_MIN_GAP_MS = 2500;
  const ACTIVE_MAX_PER_PAGE = 60;
  const activeState = {sid: '', at: 0, count: 0, timer: null};
  function activeTarget() {
    const match = ACTIVE_ROUTE_RE.exec(location.pathname || '');
    if (!match) return null;
    const prefix = match[1] === 'agent' ? 'chat' : 'evaluation';
    return {sid: match[2], url: `/api/${prefix}/${match[2]}`};
  }
  function activeFetchTranscript() {
    const target = activeTarget();
    if (!target) return;
    const nowMs = Date.now();
    if (target.sid === activeState.sid && nowMs - activeState.at < ACTIVE_MIN_GAP_MS) return;
    if (activeState.count >= ACTIVE_MAX_PER_PAGE) return;
    activeState.sid = target.sid;
    activeState.at = nowMs;
    activeState.count += 1;
    try {
      /* 用原生 fetch（绕过本文件的钩子，避免自噬），同源带 cookie。 */
      const request = nativeFetch.call(window, target.url, {credentials: 'same-origin', headers: {accept: 'application/json'}});
      if (!request || typeof request.then !== 'function') return;
      request
        .then((response) => (response && response.ok ? response.text() : ''))
        .then((text) => {
          if (!text) return;
          scanStats.body += 1;
          scanText(text.slice(0, 200000), 'active.body', target.url);
          reportStats();
        })
        .catch(() => { /* 取不到就算了，被动通道不受影响 */ });
    } catch { /* ignore */ }
  }
  function scheduleActiveFetch(delay) {
    if (activeState.timer !== null) clearTimeout(activeState.timer);
    activeState.timer = setTimeout(() => { activeState.timer = null; activeFetchTranscript(); }, Number(delay) || 0);
  }
  function watchRoute() {
    if (activeTarget()) scheduleActiveFetch(1500);
  }
  try {
    for (const method of ['pushState', 'replaceState']) {
      const nativeHistory = history[method];
      if (typeof nativeHistory !== 'function') continue;
      history[method] = function patchedHistory() {
        const result = nativeHistory.apply(this, arguments);
        watchRoute();
        return result;
      };
    }
    window.addEventListener('popstate', watchRoute);
  } catch { /* ignore */ }
  window.addEventListener('load', watchRoute, {once: true});
  setTimeout(watchRoute, 2500);

  window.addEventListener('pagehide', () => { if (timer !== null) { clearTimeout(timer); timer = null; } post(); });
})();
