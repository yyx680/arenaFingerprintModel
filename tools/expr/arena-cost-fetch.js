// 挖出「取成本」的完整代码（URL / headers / 客户端基址），并用多种形态重试 /cost
const out = {at: new Date().toISOString(), code: [], base: [], retry: []};

const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)))];

for (const u of urls.slice(0, 130)) {
  let t;
  try { t = await (await fetch(u, {credentials: 'omit'})).text(); } catch { continue; }
  const file = u.split('/').pop().split('?')[0];

  for (const needle of ['Failed to fetch agent session cost', 'Failed to fetch evaluation session cost', 'cost.$get']) {
    let i = t.indexOf(needle);
    if (i < 0) continue;
    out.code.push({file, needle, ctx: t.slice(Math.max(0, i - 1600), i + 1200).replace(/\s+/g, ' ')});
  }
  // Hono RPC 客户端基址
  let i = t.indexOf('hono');
  if (i >= 0 && /baseUrl|api\s*[:=]/.test(t.slice(Math.max(0, i - 300), i + 300))) {
    out.base.push({file, ctx: t.slice(Math.max(0, i - 500), i + 800).replace(/\s+/g, ' ')});
  }
}

// 去重
const seen = new Set();
out.code = out.code.filter((x) => { const k = x.file + x.needle + x.ctx.slice(0, 100); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
const seenB = new Set();
out.base = out.base.filter((x) => { const k = x.file + x.ctx.slice(0, 100); if (seenB.has(k)) return false; seenB.add(k); return true; }).slice(0, 6);

// 重试 /cost：多个 sid × 多个前缀 × 多个 header
const sids = [...new Set(Object.keys(localStorage).map((k) => (k.match(/ampApiStash:([0-9a-f-]{20,})/i) || [])[1]).filter(Boolean))];
out.sids = sids;
const candidates = [];
for (const sid of sids.slice(0, 2)) {
  for (const p of [
    `/api/evaluation/${sid}/cost`,
    `/nextjs-api/evaluation/${sid}/cost`,
    `/api/evaluation/${sid}/cost?include=messages`,
    `/api/v1/evaluation/${sid}/cost`,
  ]) candidates.push(p);
}
const headerSets = [
  ['json', {accept: 'application/json'}],
  ['json+referer', {accept: 'application/json', 'x-arena-client': 'web'}],
  ['rsc', {accept: 'text/x-component', RSC: '1'}],
];
for (const p of candidates) {
  for (const [label, h] of headerSets) {
    try {
      const r = await fetch(p, {headers: h, credentials: 'include'});
      const body = (await r.text()).slice(0, 220);
      out.retry.push({p, label, status: r.status, ct: r.headers.get('content-type'), body});
      if (r.status === 200) break;
    } catch (e) { out.retry.push({p, label, err: e.message}); }
  }
}

return out;
