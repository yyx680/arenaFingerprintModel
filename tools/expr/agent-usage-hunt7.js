// Re-test agent-logs/usage with the RUN cuid (jwt sub) as agentLogId, and alternate hosts.
const sid = location.pathname.split('/').pop();
const sess = await fetch('/api/chat/' + sid, { credentials: 'include' }).then(r => r.json()).catch(() => null);
const token = sess && sess.publicAccessToken;
let sub = null, scopes = null;
if (token) {
  try { const p = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); sub = p.sub; scopes = p.scopes; } catch {}
}
const out = { sid, sub, scopes, attempts: [] };
const tryCall = async (url, method, auth) => {
  const rec = { method, url, auth };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && token) headers['Authorization'] = 'Bearer ' + token;
    const resp = await fetch(url, { method, headers, credentials: 'include', body: method === 'POST' ? '{}' : undefined });
    rec.status = resp.status;
    const t = await resp.text();
    rec.body = t.slice(0, 400);
  } catch (e) { rec.err = String(e); }
  out.attempts.push(rec);
};
const ids = [...new Set([sub, sid, sub && ('run_' + sub)].filter(Boolean))];
for (const id of ids) {
  await tryCall('/api/agent-logs/' + id + '/usage', 'POST', true);
  await tryCall('/api/agent-logs/' + id + '/usage', 'GET', true);
}
if (sub) {
  await tryCall('/api/agent-logs/' + sub, 'GET', true);
  await tryCall('/api/agent-logs/' + sub + '/trace', 'GET', true);
}
return out;
