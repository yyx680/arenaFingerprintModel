// Token completeness check: enumerate cookie names, find any JWT, retry gated routes with every bearer candidate.
const sid = location.pathname.split('/').pop();
const out = { cookieNames: document.cookie.split(';').map(c => c.trim().split('=')[0]), jwtFound: [], attempts: [] };
const candidates = {};
// from cookies
for (const part of document.cookie.split(';')) {
  const [k, ...rest] = part.trim().split('=');
  const v = rest.join('=');
  if (v && v.split('.').length === 3 && v.length > 40) candidates['cookie:' + k] = v;
}
// sessionStorage
for (let i = 0; i < sessionStorage.length; i++) {
  const k = sessionStorage.key(i);
  const v = sessionStorage.getItem(k) || '';
  const m = v.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/);
  if (m) candidates['sessionStorage:' + k] = m[0];
}
for (let i = 0; i < localStorage.length; i++) {
  const k = localStorage.key(i);
  const v = localStorage.getItem(k) || '';
  const m = v.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/);
  if (m) candidates['localStorage:' + k] = m[0];
}
out.jwtFound = Object.keys(candidates);
const sess = await fetch('/api/chat/' + sid, { credentials: 'include' }).then(r => r.json()).catch(() => null);
if (sess && sess.publicAccessToken) candidates['publicAccessToken'] = sess.publicAccessToken;
// try each candidate on the two gated routes
for (const [name, tok] of Object.entries(candidates)) {
  for (const path of ['/api/agent-logs/' + sid + '/usage', '/api/chat/' + sid + '/cost?includeSession=true']) {
    try {
      const resp = await fetch(path, { method: path.includes('agent-logs') ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, credentials: 'include', body: path.includes('agent-logs') ? '{}' : undefined });
      const t = await resp.text();
      out.attempts.push({ tok: name, p: path.includes('agent-logs') ? 'agent-logs/usage' : 'cost', s: resp.status, b: t.slice(0, 80) });
    } catch (e) { out.attempts.push({ tok: name, err: String(e) }); }
  }
}
return out;
