(async () => {
  const h = await (await fetch('/api/history/unified?limit=6&includeArchived=false', {credentials: 'include'})).json();
  const sid = (h.entries || [])[0].id;
  const base = `/api/chat/${sid}`;
  const qs = ['', '?includeUsage=true', '?includeUsage=1', '?include=usage', '?include=usage,cost,metadata', '?includeSessionCost=true', '?usage=true', '?withUsage=true', '?includeCost=true', '?includeUsage=cost', '?expand=usage', '?fields=usage', '?view=full', '?debug=true', '?includeMessageUsage=true', '?includeTokenUsage=true', '?include=all'];
  const out = {sid, variants: []};
  let baseKeys = null, baseMeta = null;
  for (const q of qs) {
    try {
      const r = await fetch(base + q, {credentials: 'include'});
      const j = await r.json().catch(() => null);
      if (!j) { out.variants.push({q, s: r.status, err: 'non-json'}); continue; }
      const keys = Object.keys(j);
      const msgs = j.messages || [];
      const mk = msgs[1] ? Object.keys(msgs[1].metadata || {}) : (msgs[0] ? Object.keys(msgs[0].metadata || {}) : []);
      if (!baseKeys) { baseKeys = keys; baseMeta = mk; }
      const newKeys = keys.filter((k) => !baseKeys.includes(k));
      const newMeta = mk.filter((k) => !baseMeta.includes(k));
      const usageHit = /"usage"|inputTokens|outputTokens|totalCostUsd/.test(JSON.stringify(j));
      out.variants.push({q, s: r.status, newKeys, newMeta, usageHit});
    } catch (e) { out.variants.push({q, err: String(e).slice(0, 60)}); }
  }
  out.baseKeys = baseKeys; out.baseMeta = baseMeta;
  // transcript cursor attempts
  const cj = await (await fetch(base, {credentials: 'include'})).json();
  const msgs = cj.messages || [];
  const cands = ['0', '1', cj.lastEventId, msgs[0] && msgs[0].id, btoa(msgs[0] ? msgs[0].id : ''), msgs[msgs.length-1] && msgs[msgs.length-1].id, String(Date.now())];
  out.cursors = {};
  for (const c of cands) {
    try { const r = await fetch(`${base}/messages?cursor=${encodeURIComponent(c)}`, {credentials: 'include'}); const t = await r.text();
      out.cursors[String(c).slice(0, 40)] = {s: r.status, len: t.length, usage: /usage|Tokens/.test(t), head: t.slice(0, 120)};
    } catch (e) { out.cursors[String(c)] = String(e).slice(0, 40); }
  }
  return out;
})()
