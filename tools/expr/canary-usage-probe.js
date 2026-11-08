// Canary/Agent 会话：每消息 token 用量的只读侦察（不发消息、不改页面状态）。
const sid = location.pathname.split('/').pop();
const USAGE_RE = /(usag|token|cost|credit|price|spend|meter|consum|billed)/i;
const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '...' : s) : JSON.stringify(s)?.slice(0, n));
const walk = (v, path, sink, depth = 0) => {
  if (depth > 9 || v == null || sink.length > 120) return;
  if (Array.isArray(v)) { v.slice(0, 100).forEach((it, i) => walk(it, path + '[' + i + ']', sink, depth + 1)); return; }
  if (typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (USAGE_RE.test(k)) sink.push(path + '.' + k + ' = ' + clip(val, 240));
      walk(val, path + '.' + k, sink, depth + 1);
      if (sink.length > 120) return;
    }
  }
};
const out = {sid, href: location.href, chat: null, flight: null, html: null, gated: []};

// 1) 会话 JSON（页面自身也在用这条公开路由）
try {
  const r = await fetch('/api/chat/' + sid, {credentials: 'include'});
  const j = await r.json().catch(() => null);
  const hits = []; walk(j, '$', hits);
  const msgs = (j && (j.messages || (j.data && j.data.messages))) || [];
  out.chat = {
    status: r.status,
    topKeys: j && typeof j === 'object' ? Object.keys(j).slice(0, 50) : null,
    msgCount: Array.isArray(msgs) ? msgs.length : null,
    msgKeys: Array.isArray(msgs) && msgs[0] && typeof msgs[0] === 'object' ? Object.keys(msgs[0]).slice(0, 50) : null,
    msg0Role: Array.isArray(msgs) && msgs[0] ? msgs[0].role : null,
    firstMsgMeta: Array.isArray(msgs) && msgs[0] && msgs[0].metadata ? clip(msgs[0].metadata, 700) : null,
    usageHits: hits.slice(0, 120),
  };
} catch (e) { out.chat = {err: String(e)}; }

// 2) 页面内 Next.js flight 数据（客户端已渲染的消息常带 metadata）
try {
  const chunks = [];
  for (const arr of (self.__next_f || [])) { if (Array.isArray(arr) && typeof arr[1] === 'string') chunks.push(arr[1]); }
  const blob = chunks.join('\n');
  const found = {}; let m;
  const re = /"(usage|inputTokens|outputTokens|totalTokens|cacheReadTokens|cacheWriteTokens|reasoningTokens|cost[A-Za-z]*|credits?[A-Za-z]*)"\s*:/gi;
  while ((m = re.exec(blob))) { const k = m[1]; found[k] = (found[k] || 0) + 1; }
  const i1 = blob.search(/"usage"|inputTokens|cacheWriteTokens/);
  out.flight = {bytes: blob.length, hits: found, context: i1 >= 0 ? blob.slice(Math.max(0, i1 - 300), i1 + 500) : null};
} catch (e) { out.flight = {err: String(e)}; }

// 3) 服务器渲染 HTML / RSC 载荷
try {
  const r = await fetch(location.href, {credentials: 'include', headers: {'RSC': '1'}});
  const t = await r.text();
  const found = {}; let m;
  const re2 = /(inputTokens|outputTokens|totalTokens|cacheReadTokens|cacheWriteTokens|reasoningTokens|usage)/g;
  while ((m = re2.exec(t))) found[m[1]] = (found[m[1]] || 0) + 1;
  const i2 = t.search(/inputTokens|cacheWriteTokens|"usage"/);
  out.html = {status: r.status, bytes: t.length, hits: found, context: i2 >= 0 ? t.slice(Math.max(0, i2 - 300), i2 + 500) : null};
} catch (e) { out.html = {err: String(e)}; }

// 4) 被门控的用量/成本路由：当前状态快照（只读探测）
for (const [p, method] of [['/api/chat/' + sid + '/cost?includeSession=true', 'GET'], ['/api/agent-logs/' + sid + '/usage', 'POST']]) {
  try {
    const r = await fetch(p, {method, credentials: 'include', headers: method === 'POST' ? {'Content-Type': 'application/json'} : {}, body: method === 'POST' ? '{}' : undefined});
    const t = await r.text();
    out.gated.push({path: p.replace(sid, '<sid>'), status: r.status, body: t.slice(0, 200)});
  } catch (e) { out.gated.push({path: p.replace(sid, '<sid>'), err: String(e)}); }
}
return out;
