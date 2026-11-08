(async () => {
  const out = {};
  const h = await (await fetch('/api/history/unified?limit=4&includeArchived=false', {credentials:'include'})).json();
  const sid = (h.entries || [])[0].id;
  out.sid = sid;
  const g = async (u, headers) => {
    try { const r = await fetch(u, {credentials:'include', headers: headers || {}}); const t = await r.text(); return {s: r.status, len: t.length, head: t.slice(0, 200)}; }
    catch (e) { return {err: String(e).slice(0, 80)}; }
  };
  out.eval = await g('/api/evaluation/' + sid);
  out.evalRSC = await g('/api/evaluation/' + sid, {RSC: '1'});
  out.evalCost = await g('/api/evaluation/' + sid + '/cost');
  out.evalCostMsgs = await g('/api/evaluation/' + sid + '/cost?includeSession=true');
  out.chat = await g('/api/chat/' + sid);
  try {
    const j = JSON.parse((await (await fetch('/api/evaluation/' + sid, {credentials:'include'})).text()));
    const msgs = j.messages || [];
    out.msgRoles = msgs.map((m) => m.role + ':' + String(m.id).slice(0, 8) + ':' + String(m.modelId || 'null').slice(0, 30));
    const a = msgs.find((m) => m.role === 'assistant');
    if (a) { out.asstMeta = a.metadata; out.asstContentHead = String(a.content || '').slice(0, 300); }
    out.revealed = j.revealedModels;
    out.mode = j.mode;
  } catch (e) { out.parseErr = String(e).slice(0, 100); }
  return out;
})()
