// Retest cost routes on both recent agent sessions + locate the $0.206319 text on the page.
const sids = ['01a12c2a-f113-73b4-ad1b-a9d6c8a3f01b', '01a12c23-f4ca-7434-bad3-fe34779ba2f9', '01a12c04-016e-7107-87d6-5c734fe7b334'];
const out = { cost: {}, pulse: null, domHits: [] };
for (const sid of sids) {
  for (const q of ['?includeSession=true', '?includeSession=false']) {
    try {
      const resp = await fetch('/api/chat/' + sid + '/cost' + q, { credentials: 'include' });
      const t = await resp.text();
      out.cost[sid.slice(0, 8) + q] = { status: resp.status, body: t.slice(0, 500) };
      if (resp.ok) break;
    } catch (e) { out.cost[sid.slice(0, 8) + q] = String(e); }
  }
}
try {
  const p = await fetch('/api/me/pulse', { credentials: 'include' }).then(r => r.text());
  out.pulse = p.slice(0, 400);
} catch (e) { out.pulse = String(e); }
// find the displayed number on page
const needle = '0.206319';
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
let n;
while ((n = walker.nextNode())) {
  if (n.nodeValue && n.nodeValue.includes(needle)) {
    const el = n.parentElement;
    out.domHits.push({ tag: el && el.tagName, cls: el && String(el.className).slice(0, 80), text: n.nodeValue.slice(0, 100), nearest: el && el.closest('[class]') && String(el.closest('[class]').className).slice(0, 80) });
    if (out.domHits.length > 6) break;
  }
}
// also scan for the Chinese labels user quoted
for (const kw of ['账本', '回代', '合计']) {
  const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while ((n = w2.nextNode())) {
    if (n.nodeValue && n.nodeValue.includes(kw)) { out.domHits.push({ kw, text: n.nodeValue.slice(0, 100) }); break; }
  }
}
return out;
