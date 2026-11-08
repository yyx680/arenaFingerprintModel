// Billing discovery: fetch /api/me and related routes, report any billing/tier fields + settings page DOM hints.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { routes: {}, domHints: [] };
const ROUTES = ['/api/me', '/api/me/plan', '/api/me/billing', '/api/me/quota', '/api/me/pulse', '/api/me/subscription'];
for (const r of ROUTES) {
  try {
    const resp = await fetch(r, { credentials: 'include' });
    const t = await resp.text();
    if (resp.ok) {
      let parsed = null; try { parsed = JSON.parse(t); } catch {}
      const walk = (v, path, depth) => {
        if (depth > 4 || !v || typeof v !== 'object') return;
        for (const [k, val] of Object.entries(v)) {
          const p = path ? path + '.' + k : k;
          if (/billing|bill|plan|tier|credit|quota|subscription|paid|free|pro\b|usage|limit|spend|upgrade|feature|flag/i.test(k)) {
            out.routes[r] = out.routes[r] || {};
            out.routes[r][p] = typeof val === 'object' ? JSON.stringify(val).slice(0, 200) : String(val);
          }
          if (val && typeof val === 'object') walk(val, p, depth + 1);
        }
      };
      if (parsed) walk(parsed, '', 0);
      if (!out.routes[r]) out.routes[r] = { __noInterestingKeys: true, __topKeys: Object.keys(parsed || {}).slice(0, 30) };
    } else {
      out.routes[r] = { status: resp.status, body: t.slice(0, 120) };
    }
  } catch (e) { out.routes[r] = { err: String(e) }; }
}
// DOM hints on current page: look for settings/billing/pricing links
const links = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => h && /billing|plan|pricing|subscription|upgrade|settings/i.test(h));
out.domHints = [...new Set(links)].slice(0, 20);
return out;
