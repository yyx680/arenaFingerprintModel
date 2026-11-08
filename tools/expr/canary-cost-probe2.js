(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const gf = async (p) => { try { const x = await fetch(p, {credentials: 'include'}); const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch {} return {s: x.status, j, head: t.slice(0, 300)}; } catch (e) { return {err: String(e)}; } };
  const out = {};
  const h = await gf('/api/history/unified?limit=6&includeArchived=false');
  const entries = (h.j && (h.j.entries || h.j.items || h.j.sessions)) || [];
  out.entryCount = entries.length;
  out.types = [...new Set(entries.map((e) => e.type))];
  const ids = entries.map((e) => e.id).filter(Boolean).slice(0, 3);
  out.ids = ids;
  out.cost = [];
  for (const id of ids) {
    out.cost.push(Object.assign({id}, await gf(`/api/chat/${id}/cost?includeSession=true`)));
  }
  out.evalCost = [];
  for (const id of ids) out.evalCost.push(Object.assign({id}, await gf(`/api/evaluation/${id}/cost`)));
  const c0 = await gf(`/api/chat/${ids[0]}`);
  out.chatTopKeys = c0.j ? Object.keys(c0.j) : {s: c0.s, head: c0.head};
  const ph = window.posthog;
  if (ph && ph.reloadFeatureFlags) { ph.reloadFeatureFlags(); for (let i = 0; i < 24; i++) { await wait(300); if (ph.getFeatureFlag('credit-system-m1') !== undefined) break; } out.m1 = ph.getFeatureFlag('credit-system-m1'); out.m2 = ph.getFeatureFlag('credit-system-m2'); }
  return out;
})()
