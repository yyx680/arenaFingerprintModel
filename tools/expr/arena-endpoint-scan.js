// 从已加载的 JS chunk 中提取 API 路由清单，并定位「成本上下文」相关代码
const out = { at: new Date().toISOString(), routes: {}, costSnippets: [], routeCtx: [] };

const urls = [...new Set(
  performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n))
)];

const ROUTE_RE = /["'`](\/(?:nextjs-api|api|trpc)\/[A-Za-z0-9_\-/[\].:$%{}()]*)/g;

for (const u of urls.slice(0, 80)) {
  let t;
  try { t = await (await fetch(u, { credentials: 'omit' })).text(); } catch { continue; }
  const file = u.split('/').pop().split('?')[0];

  // 1) 路由清单
  ROUTE_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_RE.exec(t))) {
    const r = m[1];
    out.routes[r] = (out.routes[r] || 0) + 1;
  }

  // 2) 成本相关代码片段
  if (/totalChargedUsd|useCostContext|totalCostUsd/.test(t)) {
    for (const key of ['totalChargedUsd', 'useCostContext', 'totalCostUsd']) {
      let i = t.indexOf(key);
      let n = 0;
      while (i >= 0 && n < 3) {
        out.costSnippets.push({ file, key, ctx: t.slice(Math.max(0, i - 300), i + 400).replace(/\s+/g, ' ') });
        i = t.indexOf(key, i + 1);
        n++;
      }
    }
  }

  // 3) 含 cost 的路由上下文
  const ci = t.search(/cost/i);
  if (ci >= 0) {
    const seg = t.slice(Math.max(0, ci - 250), ci + 350).replace(/\s+/g, ' ');
    if (/\/(api|nextjs-api)\//.test(seg)) out.routeCtx.push({ file, seg });
  }
}

out.routeList = Object.keys(out.routes).sort();
return out;
