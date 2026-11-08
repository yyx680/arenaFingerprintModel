(async () => {
  const g = async (p) => { try { const x = await fetch(p, {credentials: 'include'}); const t = await x.text(); return {s: x.status, b: t.slice(0, 260)}; } catch (e) { return {err: String(e)}; } };
  const out = {host: location.host};
  const h = await fetch('/api/history/unified?limit=6&includeArchived=false', {credentials: 'include'});
  const hj = await h.json();
  const ids = (hj.entries || []).map((e) => e.id).slice(0, 2);
  out.sessions = ids;
  if (!ids.length) return out;
  const sid = ids[0];
  const c = await fetch(`/api/chat/${sid}`, {credentials: 'include'}); const cj = await c.json();
  const msgs = cj.messages || [];
  out.msgCount = msgs.length;
  const mids = msgs.slice(-3).map((m) => m.id).filter(Boolean);
  out.mids = mids;
  out.chat = {s: c.status, top: Object.keys(cj).slice(0, 20)};
  out.tests = {};
  const m1 = mids.join(',');
  out.tests['cost?messageIds'] = await g(`/api/chat/${sid}/cost?messageIds=${m1}`);
  out.tests['cost?includeSession'] = await g(`/api/chat/${sid}/cost?includeSession=true`);
  out.tests['cost?messageIds+includeSession'] = await g(`/api/chat/${sid}/cost?messageIds=${m1}&includeSession=true`);
  out.tests['cost'] = await g(`/api/chat/${sid}/cost`);
  out.tests['messages?cursor'] = await g(`/api/chat/${sid}/messages?cursor=&limit=50`);
  out.tests['messages'] = await g(`/api/chat/${sid}/messages`);
  out.tests['stream?'] = await g(`/api/chat/${sid}?includeUsage=true`);
  return out;
})()
