/* 收尾（关键）：枚举全部 chunk URL（含懒加载），找到含成本计算代码的那个 chunk，
   看能不能拿到 Arena 的加价倍率 —— 拿到就能自己算钱，不需要被拦的 /cost 接口。 */
const out = {};

// 1) 从已加载 chunk 里抽 webpack chunk 映射
const loaded = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)))];
out.loaded_chunks = loaded.length;

const chunkNames = new Set();
for (const u of loaded) {
  let t;
  try { t = await (await fetch(u)).text(); } catch { continue; }
  // 形如 static/chunks/xxxx.js 或 "0ao401ibhmepz.js" 的映射
  for (const m of t.matchAll(/static\/chunks\/([A-Za-z0-9_\-.]{3,60}\.js)/g)) chunkNames.add(m[1]);
  for (const m of t.matchAll(/"([0-9a-z_\-]{8,24}\.js)"/g)) chunkNames.add(m[1]);
  if (chunkNames.size > 900) break;
}
out.discovered_names = chunkNames.size;

// 2) 组出候选 URL（从已加载 URL 推 base）
const base = loaded.find((u) => /\/_next\/static\/chunks\//.test(u)) || loaded[0];
const origin = location.origin;
const mBase = base && base.match(/^(.*\/_next\/static\/chunks\/)/);
const prefix = mBase ? mBase[1] : origin + '/_next/static/chunks/';
out.prefix = prefix;

// 3) 直接试已知的那个（上一轮实测 CREDITS_PER_USD 在 0ao401ibhmepz.js）
const candidates = ['0ao401ibhmepz.js', ...[...chunkNames].filter((n) => /^0[a-z0-9]{8,20}\.js$/.test(n))].slice(0, 60);
out.candidates = candidates.length;

const found = [];
for (const n of candidates) {
  let t;
  try {
    const r = await fetch(prefix + n);
    if (!r.ok) continue;
    t = await r.text();
  } catch { continue; }
  if (!/CREDITS_PER_USD|costMultiplier|marginMultiplier|basePriceUsd/.test(t)) continue;
  found.push(n);
  const grab = (pat, span = 320) => {
    const i = t.search(pat);
    return i < 0 ? null : t.slice(Math.max(0, i - 120), i + span).replace(/\s+/g, ' ');
  };
  out.hits = out.hits || [];
  out.hits.push({
    chunk: n,
    len: t.length,
    CREDITS_PER_USD: grab(/CREDITS_PER_USD/),
    costMultiplier: grab(/costMultiplier/),
    marginMultiplier: grab(/marginMultiplier/),
    basePriceUsd: grab(/basePriceUsd/),
    pricingStrategy: grab(/pricingStrategy/),
    readCostMultiplier: grab(/readCostMultiplier/),
  });
  if (out.hits.length >= 4) break;
}
out.found_chunks = found;
return out;
