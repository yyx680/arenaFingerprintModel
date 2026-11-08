(async () => {
  const out = {};
  const h = await (await fetch('/api/history/unified?limit=3&includeArchived=false', {credentials: 'include'})).json();
  out.entry0 = JSON.stringify((h.entries || [])[0]).slice(0, 500);
  const sid = (h.entries || [])[0].id;
  const paths = [`/chat/${sid}`, `/agent/${sid}`, `/text/${sid}`];
  out.pages = {};
  for (const p of paths) {
    const r = await fetch(p, { credentials: 'include', headers: { RSC: '1' } });
    const t = await r.text();
    const hit = {};
    for (const w of ['usage', 'cost', 'token', 'credit', 'settle', 'charged']) hit[w] = (t.match(new RegExp(w, 'gi')) || []).length;
    const m = /.{80}(usage|totalCostUsd|costUsd|tokenCount).{120}/i.exec(t);
    out.pages[p] = { s: r.status, len: t.length, hits: hit, snip: m ? m[0] : null };
  }
  return out;
})()
