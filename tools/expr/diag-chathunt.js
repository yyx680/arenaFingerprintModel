(async () => {
  const out = {};
  const h = await (await fetch('/api/history/unified?limit=8&includeArchived=false', {credentials:'include'})).json();
  const ids = (h.entries || []).map((e) => e.id);
  out.histCount = ids.length;
  out.hist20 = JSON.stringify(h).slice(0, 400);
  let chatIds = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const m = (a.getAttribute('href') || '').match(/^\/(agent|c)\/([0-9a-f-]{20,})/);
    if (m) chatIds.push(m[1] + ':' + m[2]);
  }
  chatIds = [...new Set(chatIds)].slice(0, 10);
  out.sideLinks = chatIds;
  out.chatProbe = [];
  const CORRECT = '{"credit-system-m1":"cost-shown","credit-system-m2":"limits-enabled"}';
  document.cookie = 'ph-toolbar-overrides=' + encodeURIComponent(CORRECT) + '; Path=/; Max-Age=120; SameSite=Lax; Secure';
  for (const c of chatIds.slice(0, 4)) {
    const sid = c.split(':')[1];
    const rec = {sid: sid.slice(0, 13)};
    try {
      const a = await fetch('/api/chat/' + sid, {credentials:'include'});
      rec.chat = a.status;
      if (a.ok) { const j = await a.json(); rec.msgCount = (j.messages || []).length; rec.topKeys = Object.keys(j).slice(0, 12); }
      else rec.chatHead = (await a.text()).slice(0, 80);
    } catch (e) { rec.chatErr = String(e).slice(0, 60); }
    try {
      const b = await fetch('/api/chat/' + sid + '/cost?includeSession=true', {credentials:'include'});
      rec.cost = b.status; rec.costBody = (await b.text()).slice(0, 100);
    } catch (e) { rec.costErr = String(e).slice(0, 60); }
    out.chatProbe.push(rec);
  }
  document.cookie = 'ph-toolbar-overrides=; Path=/; Max-Age=0; SameSite=Lax; Secure';
  return out;
})()
