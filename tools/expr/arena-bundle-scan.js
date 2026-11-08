// 扫描前端 bundle 与页面 RSC 数据，判断 Arena 是否下发「成本/用量」字段
const RE = /(totalCost|total_cost|costUsd|cost_usd|priceUsd|price_usd|costPerTask|cost_per_task|"cost"|promptTokens|completionTokens|prompt_tokens|completion_tokens|tokenUsage|inputTokens|outputTokens|"usage"\s*:)/;

const out = { at: new Date().toISOString(), bundle: { count: 0, hits: [], errors: 0 }, pages: {} };

// ---- 1) 扫描已加载的 JS 资源 ----
const urls = [...new Set(
  performance.getEntriesByType('resource')
    .map((e) => e.name)
    .filter((n) => /\.js(\?|$)/.test(n))
)];
out.bundle.count = urls.length;

for (const u of urls.slice(0, 70)) {
  try {
    const r = await fetch(u, { credentials: 'omit' });
    const t = await r.text();
    const i = t.search(RE);
    if (i >= 0) {
      const m = t.slice(i).match(RE);
      out.bundle.hits.push({
        file: u.split('/').pop().slice(0, 70),
        token: m ? m[0] : '?',
        ctx: t.slice(Math.max(0, i - 140), i + 200).replace(/\s+/g, ' '),
      });
    }
  } catch { out.bundle.errors++; }
}

// ---- 2) 抓关键页面的 RSC flight 数据 ----
const pages = ['/', '/leaderboard', '/leaderboard/agent', '/agent', '/battle'];
for (const p of pages) {
  try {
    const r = await fetch(p, { headers: { RSC: '1', accept: 'text/x-component' }, credentials: 'include' });
    const t = await r.text();
    const i = t.search(RE);
    out.pages[p] = {
      status: r.status,
      ct: r.headers.get('content-type'),
      len: t.length,
      costHit: i >= 0 ? t.slice(i).match(RE)[0] : null,
      ctx: i >= 0 ? t.slice(Math.max(0, i - 160), i + 240).replace(/\\n/g, ' ') : null,
    };
  } catch (e) {
    out.pages[p] = 'ERR ' + e.message;
  }
}

// ---- 3) 首页 HTML 里的内联 JSON（可能含榜单单据） ----
try {
  const r = await fetch('/', { credentials: 'include' });
  const t = await r.text();
  const i = t.search(RE);
  out.homeHtml = { status: r.status, len: t.length, costHit: i >= 0 ? t.slice(i).match(RE)[0] : null,
    ctx: i >= 0 ? t.slice(Math.max(0, i - 200), i + 300).replace(/\s+/g, ' ') : null };
} catch (e) { out.homeHtml = 'ERR ' + e.message; }

return out;
