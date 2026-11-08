// 验证「每条消息的成本对象」挂在哪个响应里：会话 RSC /c/<sid> 还是专门接口
const out = { at: new Date().toISOString(), sessions: [], costHits: [], extra: {} };

const RE = /totalCostUsd|totalChargedUsd|totalChargedCredits|basePriceUsd|"cost"\s*:|costDetail|pricingStrategy/i;

// 1) 收集已知会话 id
const ids = new Set();
for (const k of Object.keys(localStorage)) {
  const m = k.match(/ampApiStash:([0-9a-f-]{20,})/i);
  if (m) ids.add(m[1]);
}
try {
  const r = await fetch('/nextjs-api/evaluations', { headers: { accept: 'application/json' }, credentials: 'include' });
  if (r.ok) { const j = await r.json(); out.extra.evaluations = JSON.stringify(j).slice(0, 600); }
  else out.extra.evaluations = r.status + ' ' + (await r.text()).slice(0, 120);
} catch (e) { out.extra.evaluations = 'ERR ' + e.message; }

// 2) 逐个拉 RSC
for (const id of [...ids].slice(0, 4)) {
  try {
    const r = await fetch('/c/' + id, { headers: { RSC: '1', accept: 'text/x-component' }, credentials: 'include' });
    const t = await r.text();
    const i = t.search(RE);
    out.sessions.push({ id, status: r.status, len: t.length, costHit: i >= 0 ? t.slice(i).match(RE)[0] : null });
    if (i >= 0) out.costHits.push({ id, ctx: t.slice(Math.max(0, i - 500), i + 800) });
  } catch (e) {
    out.sessions.push({ id, err: e.message });
  }
}

// 3) 试探专门的成本接口形态
const probes = [];
for (const id of [...ids].slice(0, 2)) {
  for (const p of [`/api/evaluation/${id}/cost`, `/nextjs-api/cost/${id}`, `/api/evaluation/${id}`, `/api/me/cost`]) {
    try {
      const r = await fetch(p, { headers: { accept: 'application/json' }, credentials: 'include' });
      const t = await r.text();
      probes.push({ p, status: r.status, len: t.length, head: t.slice(0, 200) });
    } catch (e) { probes.push({ p, err: e.message }); }
  }
}
out.extra.probes = probes;

// 4) 额度/账单相关
for (const p of ['/api/me/credits', '/api/me/wallet', '/api/me/balance', '/nextjs-api/billing/credits']) {
  try {
    const r = await fetch(p, { headers: { accept: 'application/json' }, credentials: 'include' });
    out.extra[p] = r.status + ' ' + (await r.text()).slice(0, 200);
  } catch (e) { out.extra[p] = 'ERR ' + e.message; }
}

return out;
