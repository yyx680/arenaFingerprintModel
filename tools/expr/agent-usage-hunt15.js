// Unbiased capture: full field-name inventory of EVERY response during a live agent run
// (SSE event names, all JSON keys to depth 3, request body keys). No keyword filter, values NEVER recorded.
const captured = [];
const origFetch = window.fetch;
window.fetch = async function (...args) {
  const req = args[0];
  const init = args[1] || {};
  const url = typeof req === 'string' ? req : (req && req.url) || '';
  const resp = await origFetch.apply(this, args);
  try {
    const path = new URL(url, location.origin).pathname;
    if (!/\/api\/|\/nextjs-api\/|\/ai-proxy\//.test(path)) return resp;
    const rec = { path, method: (init.method || (typeof req !== 'string' && req.method) || 'GET').toUpperCase(), reqKeys: null, resKeys: null, sseEvents: null, status: resp.status };
    // request body keys
    try {
      const body = init.body ?? (typeof req !== 'string' ? await req.clone().text().catch(() => null) : null);
      if (body && typeof body === 'string') { try { const j = JSON.parse(body); const ks = new Set(); const w = (v, d) => { if (d > 3 || !v || typeof v !== 'object') return; for (const k of Object.keys(v)) { ks.add(k); if (v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) w(v[k], d + 1); } }; w(j, 0); rec.reqKeys = [...ks].slice(0, 120); } catch {} }
    } catch {}
    const ct = resp.headers.get('content-type') || '';
    if (/text\/event-stream/.test(ct)) {
      const clone = resp.clone();
      (async () => {
        const reader = clone.body.getReader();
        const dec = new TextDecoder();
        let buf = '', events = new Set(), keys = new Set();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) events.add(line.slice(6).trim());
                else if (line.startsWith('data:')) {
                  const d = line.slice(5).trim();
                  if (d.startsWith('{')) { try { const j = JSON.parse(d); const w = (v, dep) => { if (dep > 3 || !v || typeof v !== 'object') return; for (const k of Object.keys(v)) { keys.add(k); if (v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) w(v[k], dep + 1); } }; w(j, 0); } catch {} }
                }
              }
            }
          }
        } catch {}
        rec.sseEvents = [...events].slice(0, 60);
        rec.resKeys = [...keys].slice(0, 250);
      })();
    } else if (/json/.test(ct)) {
      const clone = resp.clone();
      clone.text().then(t => { try { const j = JSON.parse(t); const ks = new Set(); const w = (v, d) => { if (d > 3 || !v || typeof v !== 'object') return; for (const k of Object.keys(v)) { ks.add(k); if (v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) w(v[k], d + 1); } }; w(j, 0); rec.resKeys = [...ks].slice(0, 250); } catch {} }).catch(() => {});
    }
    captured.push(rec);
  } catch {}
  return resp;
};
await new Promise(r => setTimeout(r, 100000));
window.fetch = origFetch;
return { count: captured.length, captured };
