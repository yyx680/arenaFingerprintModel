// 反查「成本从哪来」：① 模型目录是否含单价 ② useCostContext 的数据源 ③ /cost 路由的请求形态
const out = {at: new Date().toISOString()};

// ---------- ① 模型目录 ----------
try {
  const r = await fetch('/nextjs-api/model-catalog', {headers: {accept: 'application/json'}, credentials: 'include'});
  const text = await r.text();
  out.catalog = {status: r.status, len: text.length, head: text.slice(0, 300)};
  try {
    const j = JSON.parse(text);
    out.catalog.topKeys = Array.isArray(j) ? `array(${j.length})` : Object.keys(j);
    const s = JSON.stringify(j);
    out.catalog.costTokens = [...new Set(s.match(/"[A-Za-z_]*(?:cost|price|rate|pricing)[A-Za-z_]*"\s*:/gi) || [])];
    out.catalog.models = Array.isArray(j) ? j.length : (j.models || j.data || []).length;
    const first = Array.isArray(j) ? j[0] : (j.models || j.data || [])[0];
    if (first) out.catalog.sampleKeys = Object.keys(first);
    if (first) out.catalog.sample = JSON.stringify(first).slice(0, 900);
    const i = s.search(/cost|price|rate/i);
    out.catalog.ctx = i >= 0 ? s.slice(Math.max(0, i - 300), i + 500) : null;
  } catch (e) { out.catalog.parseErr = e.message; }
} catch (e) { out.catalog = {err: e.message}; }

// ---------- ② 扫 chunk：useCostContext 的数据源 ----------
const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)))];
out.chunkCount = urls.length;
out.hits = [];
out.routeNearCost = [];
const KEYS = ['useCostContext', 'CostProvider', 'costContext', 'CREDITS_PER_USD', 'pricingStrategy', 'SessionCostAggregate', 'MessageCostSchema', 'totalChargedUsd'];
const ROUTE_RE = /["'`](\/(?:api|nextjs-api)\/[A-Za-z0-9_\-/[\].:$%{}()]*)/g;

for (const u of urls.slice(0, 120)) {
  let t;
  try { t = await (await fetch(u, {credentials: 'omit'})).text(); } catch { continue; }
  const file = u.split('/').pop().split('?')[0];
  for (const key of KEYS) {
    let i = t.indexOf(key);
    if (i < 0) continue;
    let n = 0;
    while (i >= 0 && n < 2) {
      out.hits.push({file, key, ctx: t.slice(Math.max(0, i - 400), i + 500).replace(/\s+/g, ' ')});
      i = t.indexOf(key, i + 1);
      n++;
    }
  }
  // 含 cost 的段落里出现的路由
  ROUTE_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_RE.exec(t))) {
    const route = m[1];
    const seg = t.slice(Math.max(0, m.index - 300), m.index + 300);
    if (/cost|price|pricing|credit|charge/i.test(seg)) out.routeNearCost.push({file, route, seg: seg.replace(/\s+/g, ' ')});
  }
}

// 去重
const seen = new Set();
out.hits = out.hits.filter((h) => { const k = h.file + '|' + h.key + '|' + h.ctx.slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
const seenR = new Set();
out.routeNearCost = out.routeNearCost.filter((h) => { const k = h.route + '|' + h.seg.slice(0, 60); if (seenR.has(k)) return false; seenR.add(k); return true; }).slice(0, 25);

// ---------- ③ /cost 路由的多种请求形态 ----------
const sid = (Object.keys(localStorage).map((k) => (k.match(/ampApiStash:([0-9a-f-]{20,})/i) || [])[1]).filter(Boolean))[0]
  || '01a12bb5-3ce8-7bab-915e-5f69f7b6e1d1';
out.sid = sid;
out.costVariants = [];
const variants = [
  ['plain', '/api/evaluation/' + sid + '/cost', {}],
  ['xrw', '/api/evaluation/' + sid + '/cost', {'x-requested-with': 'XMLHttpRequest'}],
  ['rsc', '/api/evaluation/' + sid + '/cost', {RSC: '1', accept: 'text/x-component'}],
  ['next-action', '/api/evaluation/' + sid + '/cost', {'next-action': 'x', accept: 'text/x-component'}],
  ['costs-plural', '/api/evaluation/' + sid + '/costs', {}],
  ['messages-cost', '/api/evaluation/' + sid + '/messages/cost', {}],
  ['me-cost', '/api/me/cost', {}],
  ['credits', '/api/me/credits', {}],
];
for (const [label, url, extra] of variants) {
  try {
    const r = await fetch(url, {headers: {accept: 'application/json', ...extra}, credentials: 'include'});
    out.costVariants.push({label, url, status: r.status, body: (await r.text()).slice(0, 200)});
  } catch (e) { out.costVariants.push({label, url, err: e.message}); }
}

return out;
