// Probe the live paginated messages route: /api/chat/<sid>/messages?cursor=...
const sid = location.pathname.split('/').pop();
const out = { attempts: [] };
for (const cur of ['', '0', 'null', 'start', 'undefined', 'eyJpZCI6bnVsbH0=']) {
  try {
    const resp = await fetch('/api/chat/' + sid + '/messages?cursor=' + encodeURIComponent(cur), { credentials: 'include' });
    const t = await resp.text();
    const rec = { cursor: cur, status: resp.status };
    if (resp.ok) {
      let parsed = null; try { parsed = JSON.parse(t); } catch {}
      rec.topKeys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : null;
      const found = [];
      const walk = (v, path, depth) => {
        if (depth > 6 || !v || typeof v !== 'object') return;
        for (const [k, val] of Object.entries(v)) {
          const p = path ? path + '.' + k : k;
          if (/usage|tokens?|cost|usd|credit|price|spend|model/i.test(k)) {
            found.push(p + '=' + (typeof val === 'object' ? JSON.stringify(val).slice(0, 120) : String(val).slice(0, 60)));
          }
          if (val && typeof val === 'object') walk(val, p, depth + 1);
        }
      };
      walk(parsed, '', 0);
      rec.hits = found.slice(0, 40);
      rec.count = Array.isArray(parsed && parsed.messages) ? parsed.messages.length : (Array.isArray(parsed) ? parsed.length : null);
      if (parsed && parsed.messages && parsed.messages[0]) {
        rec.msg0keys = Object.keys(parsed.messages[0]);
        rec.msg0meta = parsed.messages[0].metadata ? Object.keys(parsed.messages[0].metadata) : null;
      }
    } else {
      rec.body = t.slice(0, 200);
    }
    out.attempts.push(rec);
    if (resp.ok) break;
  } catch (e) { out.attempts.push({ cursor: cur, err: String(e) }); }
}
return out;
