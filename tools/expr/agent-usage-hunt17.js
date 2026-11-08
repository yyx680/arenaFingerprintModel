// /out needs the session token: fetch it then deep-inventory records.
const sid = location.pathname.split('/').pop();
const sess = await fetch('/api/chat/' + sid, { credentials: 'include' }).then(r => r.json()).catch(() => null);
const token = sess && sess.publicAccessToken;
const out = { sid, hasToken: !!token, tries: [] };
if (!token) return out;
const resp = await fetch('/ai-proxy/realtime/v1/sessions/' + sid + '/out', { headers: { Authorization: 'Bearer ' + token } });
const t = await resp.text();
const rec = { status: resp.status, len: t.length };
out.tries.push(rec);
let j = null; try { j = JSON.parse(t); } catch {}
if (j) {
  rec.topKeys = Object.keys(j);
  rec.recordCount = Array.isArray(j.records) ? j.records.length : null;
  const keys = new Map();
  const walk = (v, depth) => {
    if (depth > 7 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const item of v.slice(0, 40)) walk(item, depth + 1); return; }
    for (const [k, val] of Object.entries(v)) {
      keys.set(k, (keys.get(k) || 0) + 1);
      if (val && typeof val === 'object') walk(val, depth + 1);
    }
  };
  if (Array.isArray(j.records)) for (const r of j.records.slice(0, 120)) walk(r, 0);
  rec.recordTypes = Array.isArray(j.records) ? [...new Set(j.records.map(r => r && (r.type || r.event || r.kind || 'unknown')))].slice(0, 30) : null;
  rec.allKeys = [...keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 150).map(([k, c]) => k + ':' + c);
  rec.suspicious = [...keys.keys()].filter(k => /usag|token|cost|credit|price|spend|bill|meter|unit|consum|amount|input|output|cache|reason/i.test(k));
} else {
  rec.head = t.slice(0, 400);
}
return out;
