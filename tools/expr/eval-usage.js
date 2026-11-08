(async () => {
  const out = {};
  const h = await (await fetch('/api/history/unified?limit=8&includeArchived=false', {credentials: 'include'})).json();
  const ids = (h.entries || []).map((e) => e.id).slice(0, 4);
  out.ids = ids;
  out.results = [];
  for (const id of ids) {
    const r = await fetch(`/api/evaluation/${id}`, {credentials: 'include'});
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    const rec = {id, s: r.status, len: t.length};
    if (j) {
      rec.topKeys = Object.keys(j).slice(0, 20);
      const s = JSON.stringify(j);
      rec.hasUsage = /"usage"/.test(s);
      rec.usageCount = (s.match(/"inputTokens"/g) || []).length;
      const m = /"usage":\{[^}]{0,300}\}/.exec(s);
      rec.sample = m ? m[0] : null;
      rec.msgs = Array.isArray(j.messages) ? j.messages.length : null;
    } else rec.head = t.slice(0, 160);
    out.results.push(rec);
  }
  return out;
})()
