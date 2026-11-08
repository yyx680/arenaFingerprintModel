// 定位 useCostContext 的 Provider 与其数据来源；列出全部 API 路由与 credits/pulse 相关代码
const out = {at: new Date().toISOString(), provider: [], usageSites: [], routes: [], creditsCtx: []};

const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)))];
const ROUTE_RE = /["'`](\/(?:api|nextjs-api|trpc)\/[A-Za-z0-9_\-/[\].:$%{}()]*)/g;
const routeSet = new Map();

for (const u of urls.slice(0, 130)) {
  let t;
  try { t = await (await fetch(u, {credentials: 'omit'})).text(); } catch { continue; }
  const file = u.split('/').pop().split('?')[0];

  // 全部路由
  ROUTE_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_RE.exec(t))) routeSet.set(m[1], (routeSet.get(m[1]) || 0) + 1);

  // Provider：找 useCostContext 的定义点（同段出现 createContext / Provider / useContext）
  let i = t.indexOf('useCostContext');
  let n = 0;
  while (i >= 0 && n < 4) {
    const ctx = t.slice(Math.max(0, i - 900), i + 900);
    if (/createContext|Provider|useContext|CostContext/.test(ctx)) out.provider.push({file, ctx: ctx.replace(/\s+/g, ' ')});
    i = t.indexOf('useCostContext', i + 1);
    n++;
  }

  // MessageCostSchema 的使用点（消息 schema 里 cost 字段叫什么）
  i = t.indexOf('MessageCostSchema');
  n = 0;
  while (i >= 0 && n < 3) {
    out.usageSites.push({file, ctx: t.slice(Math.max(0, i - 700), i + 400).replace(/\s+/g, ' ')});
    i = t.indexOf('MessageCostSchema', i + 1);
    n++;
  }

  // credits / pulse 相关
  i = t.search(/credit/i);
  n = 0;
  while (i >= 0 && n < 2) {
    const ctx = t.slice(Math.max(0, i - 400), i + 400);
    if (/api|fetch|pulse|balance|daily/i.test(ctx)) out.creditsCtx.push({file, ctx: ctx.replace(/\s+/g, ' ')});
    i = t.search(/credit/i) >= 0 ? t.indexOf('credit', i + 1) : -1;
    if (i < 0) break;
    n++;
  }
}

out.routes = [...routeSet.keys()].sort();
const dedupe = (arr, keyLen = 120) => {
  const seen = new Set();
  return arr.filter((x) => { const k = x.file + '|' + x.ctx.slice(0, keyLen); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 18);
};
out.provider = dedupe(out.provider);
out.usageSites = dedupe(out.usageSites);
out.creditsCtx = dedupe(out.creditsCtx, 80);

return out;
