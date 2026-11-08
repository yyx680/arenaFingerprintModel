// /out with bearer token, read ONLY the first snapshot chunk incrementally (stream stays open — don't await full body).
const sid = location.pathname.split('/').pop();
const sess = await fetch('/api/chat/' + sid, { credentials: 'include' }).then(r => r.json()).catch(() => null);
const token = sess && sess.publicAccessToken;
const out = { sid, hasToken: !!token };
if (!token) return out;
const ctrl = new AbortController();
const resp = await fetch('/ai-proxy/realtime/v1/sessions/' + sid + '/out', { headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal });
out.status = resp.status;
out.ct = resp.headers.get('content-type');
const reader = resp.body.getReader();
const dec = new TextDecoder();
let buf = '';
const t0 = Date.now();
while (Date.now() - t0 < 12000 && buf.length < 400000) {
  const p = reader.read();
  const to = new Promise(res => setTimeout(() => res({ done: 'timeout' }), 12000));
  const r = await Promise.race([p, to]);
  if (r.done) break;
  if (r.value) buf += dec.decode(r.value, { stream: true });
  // snapshot JSON ends before SSE begins; if we see event: lines we already have the snapshot
  if (buf.includes('\nevent:') || buf.includes('\r\n\r\nevent:')) break;
}
ctrl.abort();
out.len = buf.length;
// The snapshot should be the first JSON object up to SSE start
let jsonText = buf;
const evIdx = buf.indexOf('\nevent:');
if (evIdx !== -1) jsonText = buf.slice(0, evIdx);
let j = null; try { j = JSON.parse(jsonText); } catch { try { j = JSON.parse(buf); } catch {} }
if (j) {
  out.topKeys = Object.keys(j);
  out.recordCount = Array.isArray(j.records) ? j.records.length : null;
  const keys = new Map();
  const walk = (v, depth) => {
    if (depth > 7 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const item of v.slice(0, 40)) walk(item, depth + 1); return; }
    for (const [k, val] of Object.entries(v)) {
      keys.set(k, (keys.get(k) || 0) + 1);
      if (val && typeof val === 'object') walk(val, depth + 1);
    }
  };
  if (Array.isArray(j.records)) for (const r of j.records.slice(0, 150)) walk(r, 0);
  out.recordTypes = Array.isArray(j.records) ? [...new Set(j.records.map(r => r && (r.type || r.event || r.kind || 'unknown')))].slice(0, 30) : null;
  out.allKeys = [...keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 150).map(([k, c]) => k + ':' + c);
  out.suspicious = [...keys.keys()].filter(k => /usag|token|cost|credit|price|spend|bill|meter|unit|consum|amount|input|output|cache|reason/i.test(k));
} else {
  out.head = buf.slice(0, 500);
}
return out;
