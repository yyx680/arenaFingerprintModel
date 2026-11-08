// Probe the coding-agent session family + model catalog on canary.
const out = {};
const scan = (root) => {
  const keys = new Map();
  const walk = (v, depth) => {
    if (depth > 7 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const item of v.slice(0, 30)) walk(item, depth + 1); return; }
    for (const [k, val] of Object.entries(v)) {
      keys.set(k, (keys.get(k) || 0) + 1);
      if (val && typeof val === 'object') walk(val, depth + 1);
    }
  };
  walk(root, 0);
  return keys;
};
// 1) list coding-agent sessions
try {
  const resp = await fetch('/api/coding-agent/sessions', { credentials: 'include' });
  const t = await resp.text();
  out.list = { s: resp.status };
  if (resp.ok) {
    let j = null; try { j = JSON.parse(t); } catch {}
    if (j) {
      const ks = scan(j);
      out.list.keys = [...ks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([k, c]) => k + ':' + c);
      out.list.suspicious = [...ks.keys()].filter(k => /usag|tokens?|cost|credit|price|spend|bill|meter|consum/i.test(k));
      const arr = Array.isArray(j) ? j : (j.sessions || j.entries || j.items || []);
      out.list.count = arr.length;
      if (arr[0]) { out.list.item0 = Object.keys(arr[0]); out.list.item0id = arr[0].id || arr[0].sessionId || null; }
    }
  } else out.list.b = t.slice(0, 150);
} catch (e) { out.list = { err: String(e) }; }
// 2) model catalog
try {
  const resp = await fetch('/nextjs-api/model-catalog', { credentials: 'include' });
  const t = await resp.text();
  out.catalog = { s: resp.status };
  if (resp.ok) {
    let j = null; try { j = JSON.parse(t); } catch {}
    if (j) {
      const ks = scan(j);
      out.catalog.keys = [...ks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([k, c]) => k + ':' + c);
      out.catalog.suspicious = [...ks.keys()].filter(k => /usag|tokens?|cost|credit|price|spend|bill|meter|consum/i.test(k));
    }
  } else out.catalog.b = t.slice(0, 150);
} catch (e) { out.catalog = { err: String(e) }; }
return out;
