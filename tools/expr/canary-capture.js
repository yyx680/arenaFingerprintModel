// Canary full capture: every /api,/nextjs-api,/ai-proxy response — JSON keys (incl. arrays & nested JSON strings),
// SSE event names + record body inventories, request body keys. Field NAMES only. 110s window.
const captured = [];
const origFetch = window.fetch;
const keysOf = (root, max = 250) => {
  const keys = new Map();
  const walk = (v, depth) => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const item of v.slice(0, 30)) walk(item, depth + 1); return; }
    for (const [k, val] of Object.entries(v)) {
      keys.set(k, (keys.get(k) || 0) + 1);
      if (val && typeof val === 'object') walk(val, depth + 1);
      else if (typeof val === 'string' && val.startsWith('{') && val.length < 8000) { try { walk(JSON.parse(val), depth + 1); } catch {} }
    }
  };
  walk(root, 0);
  return [...keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k, c]) => k + ':' + c);
};
window.fetch = async function (...args) {
  const req = args[0];
  const init = args[1] || {};
  const url = typeof req === 'string' ? req : (req && req.url) || '';
  const resp = await origFetch.apply(this, args);
  try {
    const path = new URL(url, location.origin).pathname;
    if (!/\/api\/|\/nextjs-api\/|\/ai-proxy\//.test(path)) return resp;
    const rec = { path: path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<sid>'), method: (init.method || (typeof req !== 'string' && req.method) || 'GET').toUpperCase(), status: resp.status };
    try {
      const body = init.body;
      if (typeof body === 'string') { try { rec.reqKeys = keysOf(JSON.parse(body), 80); } catch {} }
    } catch {}
    const ct = resp.headers.get('content-type') || '';
    if (/text\/event-stream/.test(ct)) {
      const clone = resp.clone();
      (async () => {
        try {
          const reader = clone.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          const events = new Map(); const keys = new Map();
          const t0 = Date.now();
          while (Date.now() - t0 < 120000) {
            const p = reader.read();
            const to = new Promise(res => setTimeout(() => res({ done: 1 }), 5000));
            const r = await Promise.race([p, to]);
            if (r.done === 1) { if (Date.now() - t0 > 120000) break; if (r.done) break; continue; }
            if (r.done) break;
            if (r.value) buf += dec.decode(r.value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) { const e = line.slice(6).trim(); events.set(e, (events.get(e) || 0) + 1); }
                else if (line.startsWith('data:')) {
                  const d = line.slice(5).trim();
                  if (!d.startsWith('{')) continue;
                  try {
                    const env = JSON.parse(d);
                    const recs = Array.isArray(env.records) ? env.records : [env];
                    for (const item of recs) {
                      let b = item.body !== undefined ? item.body : item;
                      if (typeof b === 'string') { try { b = JSON.parse(b); } catch { continue; } }
                      const inner = b && b.data ? b.data : b;
                      if (inner && inner.type && item.body !== undefined) events.set('body:' + inner.type, (events.get('body:' + inner.type) || 0) + 1);
                      const ks = new Map();
                      const walk = (v, depth) => {
                        if (depth > 8 || !v || typeof v !== 'object') return;
                        if (Array.isArray(v)) { for (const it of v.slice(0, 30)) walk(it, depth + 1); return; }
                        for (const [k, val] of Object.entries(v)) {
                          ks.set(k, (ks.get(k) || 0) + 1);
                          if (val && typeof val === 'object') walk(val, depth + 1);
                          else if (typeof val === 'string' && val.startsWith('{') && val.length < 8000) { try { walk(JSON.parse(val), depth + 1); } catch {} }
                        }
                      };
                      walk(inner, 0);
                      for (const [k, c] of ks) keys.set(k, (keys.get(k) || 0) + c);
                    }
                  } catch {}
                }
              }
            }
          }
          rec.sseEvents = [...events.entries()].slice(0, 60);
          rec.sseKeys = [...keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 250).map(([k, c]) => k + ':' + c);
          rec.suspicious = [...keys.keys()].filter(k => /usag|tokens?|cost|credit|price|spend|bill|meter|consum|input_tokens|output_tokens|cache/i.test(k));
        } catch (e) { rec.sseErr = String(e); }
      })();
    } else if (/json/.test(ct)) {
      const clone = resp.clone();
      clone.text().then(t => { try { rec.resKeys = keysOf(JSON.parse(t)); } catch {} }).catch(() => {});
    }
    captured.push(rec);
  } catch {}
  return resp;
};
await new Promise(r => setTimeout(r, 108000));
window.fetch = origFetch;
// after capture: also actively test the cost route on any new session
const sids = [...new Set(captured.map(c => c.path).filter(p => p.includes('<sid>')).map(p => /sessions\/<sid>|chat\/<sid>/.exec(p) && p))];
return { count: captured.length, captured };
