// 从公开榜单 RSC 里抽「每模型 token 单价」表（inputPricePerMillion 等）——这是「按价格反推模型」的原料
const out = {at: new Date().toISOString(), pages: {}};

function extractRows(text) {
  const rows = [];
  const seen = new Set();
  const RE = /"inputPricePerMillion"\s*:\s*(-?[\d.]+|null)/g;
  let m;
  while ((m = RE.exec(text))) {
    const window = text.slice(Math.max(0, m.index - 1500), m.index + 900);
    const name = (window.match(/"modelDisplayName"\s*:\s*"([^"]{1,80})"/g) || []).pop();
    const key = (window.match(/"modelKey"\s*:\s*"([^"]{1,120})"/g) || []).pop();
    const out0 = (window.match(/"outputPricePerMillion"\s*:\s*(-?[\d.]+|null)/g) || []).pop();
    const cpt = (window.match(/"costPerTaskUsd"\s*:\s*(-?[\d.]+|null)/g) || []).pop();
    const crr = (window.match(/"cacheReadPricePerMillion"\s*:\s*(-?[\d.]+|null)/g) || []).pop();
    const cwr = (window.match(/"cacheWritePricePerMillion"\s*:\s*(-?[\d.]+|null)/g) || []).pop();
    const pick = (s) => (s ? s.split(':').slice(1).join(':').trim().replace(/"/g, '') : null);
    const row = {
      model: pick(name),
      key: pick(key),
      input: Number(pick(m[0])) || pick(m[0]),
      output: pick(out0),
      cacheRead: pick(crr),
      cacheWrite: pick(cwr),
      costPerTask: pick(cpt),
    };
    const id = `${row.key}|${row.input}|${row.output}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push(row);
  }
  return rows;
}

for (const path of ['/leaderboard', '/leaderboard/agent']) {
  try {
    const r = await fetch(path, {headers: {RSC: '1', accept: 'text/x-component'}, credentials: 'include'});
    const t = await r.text();
    const rows = extractRows(t);
    out.pages[path] = {
      status: r.status,
      len: t.length,
      rowCount: rows.length,
      hasInputPrice: /"inputPricePerMillion"/.test(t),
      hasPricingKey: /inputPricePerMillion/.test(t),
      rows: rows.slice(0, 40),
    };
  } catch (e) { out.pages[path] = {err: e.message}; }
}

// 顺带看看 PRICING_FIELD_MAX_VALUES 里的单位与量级（从 chunk 里确认一次）
out.note = 'PRICING_FIELD_MAX_VALUES 上限：input≤100, output≤200, cacheRead≤100, cacheWrite≤100（单位：美元/百万 token）';

return out;
