// Parse the SSE record bodies from /out: full key inventory + event types.
const sid = location.pathname.split('/').pop();
const sess = await fetch('/api/chat/' + sid, { credentials: 'include' }).then(r => r.json()).catch(() => null);
const token = sess && sess.publicAccessToken;
const out = { sid };
if (!token) return { err: 'no token' };
const ctrl = new AbortController();
const resp = await fetch('/ai-proxy/realtime/v1/sessions/' + sid + '/out', { headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal });
const reader = resp.body.getReader();
const dec = new TextDecoder();
let buf = '';
const t0 = Date.now();
while (Date.now() - t0 < 20000 && buf.length < 900000) {
  const p = reader.read();
  const to = new Promise(res => setTimeout(() => res({ done: 1 }), 20000));
  const r = await Promise.race([p, to]);
  if (r.done) break;
  if (r.value) buf += dec.decode(r.value, { stream: true });
}
ctrl.abort();
out.bytes = buf.length;
const types = new Map(); // envelope type -> count
const keys = new Map();
const walk = (v, depth) => {
  if (depth > 8 || !v || typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const item of v.slice(0, 30)) walk(item, depth + 1); return; }
  for (const [k, val] of Object.entries(v)) {
    keys.set(k, (keys.get(k) || 0) + 1);
    if (val && typeof val === 'object') walk(val, depth + 1);
    else if (typeof val === 'string' && val.startsWith('{') && val.length < 5000) { try { walk(JSON.parse(val), depth + 1); } catch {} }
  }
};
let parsed = 0, failed = 0;
const blocks = buf.split('\n\n');
for (const block of blocks) {
  for (const line of block.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d.startsWith('{')) continue;
    try {
      const env = JSON.parse(d);
      for (const rec of (env.records || [])) {
        let body = rec.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { failed++; continue; } }
        const inner = body && body.data ? body.data : body;
        const type = inner && inner.type;
        if (type) types.set(type, (types.get(type) || 0) + 1);
        walk(inner, 0);
        parsed++;
      }
    } catch {}
  }
}
out.recordsParsed = parsed;
out.parseFailed = failed;
out.eventTypes = [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
out.allKeys = [...keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([k, c]) => k + ':' + c);
out.suspicious = [...keys.keys()].filter(k => /usag|token|cost|credit|price|spend|bill|meter|unit|consum|amount|input|output|cache|reason|tokens/i.test(k));
return out;
