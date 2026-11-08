(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const g = async (p) => { try { const x = await fetch(p, {credentials: 'include'}); const t = await x.text(); return {s: x.status, b: t.slice(0, 700)}; } catch (e) { return {err: String(e)}; } };
  const out = {};
  const h = await g('/api/history/unified?limit=4&includeArchived=false');
  out.histStatus = h.s; out.histHead = (h.b || '').slice(0, 200);
  let ids = [];
  try { const j = JSON.parse(h.b); const items = j.items || j.sessions || j.chats || j.data || []; ids = items.map((x) => x.id || x.sessionId || x.chatId).filter(Boolean).slice(0, 3); } catch (e) { out.parseErr = String(e); }
  out.ids = ids;
  out.cost = []; out.evalCost = []; out.chatTop = [];
  for (const id of ids) {
    out.cost.push(await g(`/api/chat/${id}/cost?includeSession=true`));
    out.evalCost.push(await g(`/api/evaluation/${id}/cost`));
    const c = await g(`/api/chat/${id}`); let keys = null; try { keys = Object.keys(JSON.parse(c.b)); } catch {}
    out.chatTop.push({s: c.s, keys});
  }
  const ph = window.posthog;
  if (ph && ph.reloadFeatureFlags) { ph.reloadFeatureFlags(); for (let i = 0; i < 24; i++) { await wait(300); if (ph.getFeatureFlag('credit-system-m1') !== undefined) break; } }
  out.m1 = ph && ph.getFeatureFlag && ph.getFeatureFlag('credit-system-m1');
  out.m2 = ph && ph.getFeatureFlag && ph.getFeatureFlag('credit-system-m2');
  return out;
})()
