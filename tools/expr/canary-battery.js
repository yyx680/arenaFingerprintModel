(async () => {
  const g = async (p) => { try { const x = await fetch(p, {credentials: 'include'}); const t = await x.text(); return {s: x.status, b: t.slice(0, 220)}; } catch (e) { return {err: String(e)}; } };
  const out = {};
  for (const p of ['/api/me/usage', '/api/me/plan', '/api/me/billing', '/api/me/quota', '/api/me/subscription', '/api/coding-agent/sessions', '/api/me/pulse', '/api/me/credits', '/api/credits', '/api/me/balance']) {
    out[p] = await g(p);
  }
  // rpc flags with SDK-like body
  try {
    const body = { token: 'phc_LG7IJbVJqBsk584rbcKca0D5lV2vHguiijDrVji7yDM', distinct_id: '01a11013-2197-7719-8299-a796215a6fae',
      groups: {}, person_properties: { env: 'canary', email: 'yangyaxin0604@gmail.com' } };
    const r = await fetch('/rpc/flags/?v=2', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
    const j = await r.json(); const f = j.flags || j.featureFlags || {};
    out.rpcFlags = { s: r.status, count: Object.keys(f).length, credit: Object.fromEntries(Object.entries(f).filter(([k]) => /credit|cost|billing|portal|topup/i.test(k))) };
  } catch (e) { out.rpcFlags = String(e); }
  return out;
})()
