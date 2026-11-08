// 找客户端内置的「模型价格表」与成本计算函数（成本 = 用量 × 单价，若价格表在客户端，就能反推）
const out = {at: new Date().toISOString(), getMessageCost: [], priceTable: [], compute: []};

const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)))];

const PRICE_RE = /(usdPerMillion|usd_per_million|perMillion|per_million|usdPerMtok|inputPrice|outputPrice|pricePerMillion|ratePerMillion|costPerMillion|pricingTable|modelPrices|PRICE_TABLE|pricing\b)/i;
const PUSH = (bucket, file, ctx) => bucket.push({file, ctx: ctx.replace(/\s+/g, ' ')});

for (const u of urls.slice(0, 130)) {
  let t;
  try { t = await (await fetch(u, {credentials: 'omit'})).text(); } catch { continue; }
  const file = u.split('/').pop().split('?')[0];

  // 1) getMessageCost / 成本 map 的消费点
  let i = t.indexOf('getMessageCost');
  let n = 0;
  while (i >= 0 && n < 2) {
    PUSH(out.getMessageCost, file, t.slice(Math.max(0, i - 1200), i + 600));
    i = t.indexOf('getMessageCost', i + 1);
    n++;
  }

  // 2) 价格表线索
  const pm = t.match(PRICE_RE);
  if (pm) {
    const at = t.search(PRICE_RE);
    PUSH(out.priceTable, file, t.slice(Math.max(0, at - 700), at + 900));
  }

  // 3) 成本计算函数：marginMultiplier / costMultiplier 的算法
  i = t.indexOf('readCostMultiplier');
  if (i >= 0) PUSH(out.compute, file, t.slice(Math.max(0, i - 200), i + 900));
  i = t.indexOf('marginMultiplier');
  if (i >= 0) PUSH(out.compute, file, t.slice(Math.max(0, i - 900), i + 600));
}

const dedupe = (arr, n = 8, len = 120) => {
  const seen = new Set();
  return arr.filter((x) => { const k = x.file + '|' + x.ctx.slice(0, len); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, n);
};
out.getMessageCost = dedupe(out.getMessageCost, 6, 200);
out.priceTable = dedupe(out.priceTable, 10, 150);
out.compute = dedupe(out.compute, 6, 200);

return out;
