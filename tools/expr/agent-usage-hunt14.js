// Try the battle evaluation route against agent session ids.
const sids = ['01a12c2a-f113-73b4-ad1b-a9d6c8a3f01b', '01a12c23-f4ca-7434-bad3-fe34779ba2f9', '01a12c04-016e-7107-87d6-5c734fe7b334'];
const out = [];
for (const sid of sids) {
  for (const path of ['/api/evaluation/' + sid, '/api/evaluation/' + sid + '?includeUsage=true']) {
    try {
      const resp = await fetch(path, { credentials: 'include' });
      const t = await resp.text();
      const rec = { p: path.slice(0, 60), s: resp.status };
      if (resp.ok) {
        let j = null; try { j = JSON.parse(t); } catch {}
        rec.keys = j && typeof j === 'object' ? Object.keys(j).slice(0, 20) : null;
        const hits = [];
        const walk = (v, pth, d) => {
          if (d > 6 || !v || typeof v !== 'object') return;
          for (const [k, val] of Object.entries(v)) {
            const p2 = pth ? pth + '.' + k : k;
            if (/usage|tokens?|cost|usd|credit/i.test(k)) hits.push(p2);
            if (val && typeof val === 'object') walk(val, p2, d + 1);
          }
        };
        walk(j, '', 0);
        rec.usageKeys = [...new Set(hits)].slice(0, 20);
      } else rec.b = t.slice(0, 100);
      out.push(rec);
    } catch (e) { out.push({ p: path.slice(0, 60), err: String(e) }); }
  }
}
return out;
