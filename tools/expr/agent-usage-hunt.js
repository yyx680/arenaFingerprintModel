/* Agent 模式用量猎取（只读）：对当前 /agent/<sid> 会话，打几个候选路由，
   只报告「哪些字段路径上存在 usage/token/cost 类字段」（键名 + 数字值），
   绝不记录消息正文。目的：确认 Agent 模式的用量到底在哪个接口下发。 */
const SID = location.pathname.split('/').filter(Boolean).pop();
const INTEREST = /usage|tokens?|cost|usd|credit|price|spend|billing/i;
const out = {at: new Date().toISOString(), href: location.href, sid: SID, probes: []};

function scan(value, path, hits, depth) {
  if (depth > 9 || hits.length > 120 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.length) scan(value[0], path + '[0]', hits, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if (INTEREST.test(k)) {
      const hit = {path: p, type: Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v};
      if (typeof v === 'number') hit.value = v;
      hits.push(hit);
    }
    if (v && typeof v === 'object') scan(v, p, hits, depth + 1);
  }
}

async function probe(url) {
  try {
    const r = await fetch(url, {credentials: 'include', headers: {accept: 'application/json'}});
    const text = await r.text();
    const entry = {url, status: r.status, bytes: text.length};
    let j = null;
    try { j = JSON.parse(text); } catch { /* 可能是 RSC flight */ }
    if (j && typeof j === 'object') {
      const hits = [];
      scan(j, '', hits, 0);
      entry.hits = hits.slice(0, 100);
      entry.top_keys = Object.keys(j).slice(0, 24);
      if (Array.isArray(j.messages)) {
        entry.messages_count = j.messages.length;
        const m0 = j.messages[0];
        if (m0 && typeof m0 === 'object') entry.message0_keys = Object.keys(m0).slice(0, 30);
        if (m0 && m0.metadata && typeof m0.metadata === 'object') entry.message0_metadata_keys = Object.keys(m0.metadata).slice(0, 30);
      }
    } else {
      const names = [...new Set([...text.matchAll(/"([a-zA-Z_]*(?:[Tt]okens?|[Uu]sage|[Cc]ost|Usd|[Cc]redits?|[Pp]rice)[a-zA-Z_]*)"\s*:/g)].map(m => m[1]))];
      entry.field_names_in_text = names.slice(0, 60);
    }
    return entry;
  } catch (e) { return {url, error: String(e).slice(0, 120)}; }
}

const urls = [
  `/api/chat/${SID}`,
  `/api/evaluation/${SID}`,
  `/api/chat/${SID}/cost?includeSession=true`,
];
for (const u of urls) out.probes.push(await probe(u));

/* 页面自己最近请求过哪些 arena API（补充线索） */
out.recent_api = performance.getEntriesByType('resource')
  .map(e => e.name)
  .filter(n => /arena\.ai\/(api|nextjs-api)\//.test(n))
  .map(n => n.replace('https://arena.ai', '').slice(0, 120))
  .slice(-40);
return out;
