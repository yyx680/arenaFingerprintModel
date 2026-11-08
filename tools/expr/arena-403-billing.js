/* 收尾：找计费/额度入口（给用户可执行的下一步），并确认客户端成本计算的落点。 */
const out = {};
const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)))];

const RE = /["'`](\/(?:settings|account|billing|credits|pricing|plans|upgrade|portal)[A-Za-z0-9_\-\/]*)["'`]/g;
const paths = new Set();
const billingFlags = new Set();
const portal = [];

for (const u of urls) {
  let t;
  try { t = await (await fetch(u)).text(); } catch { continue; }
  const name = u.split('/').pop().split('?')[0].slice(0, 30);
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(t)) !== null) paths.add(m[1]);
  // 计费相关 flag / 开关
  for (const f of ['portal_enable_billing_topups', 'enable_billing', 'billingEnabled', 'showBilling', 'creditsEnabled', 'costDisplay']) {
    if (t.includes(f)) billingFlags.add(f + '  [' + name + ']');
  }
  // 找 stripe / portal url
  const pm = t.match(/https:\/\/billing\.stripe\.com[^"'`\s]{0,60}|portalUrl|billingPortal[A-Za-z]*/g);
  if (pm) for (const x of pm.slice(0, 3)) portal.push(x + '  [' + name + ']');
}
out.billing_paths = [...paths].slice(0, 30);
out.billing_flags = [...billingFlags];
out.portal_hits = [...new Set(portal)].slice(0, 12);

// 客户端成本计算的落点（CREDITS_PER_USD 等）
const costCode = [];
for (const u of urls) {
  let t;
  try { t = await (await fetch(u)).text(); } catch { continue; }
  const name = u.split('/').pop().split('?')[0].slice(0, 30);
  for (const pat of ['CREDITS_PER_USD', 'readCostMultiplier', 'useCostContext', 'CostBreakdown', 'basePriceUsd', 'costMultiplier']) {
    const i = t.indexOf(pat);
    if (i > -1) costCode.push({pat, chunk: name, snip: t.slice(Math.max(0, i - 200), i + 260).replace(/\s+/g, ' ').slice(0, 400)});
    if (costCode.length > 10) break;
  }
}
out.cost_code = costCode.slice(0, 10);
return out;
