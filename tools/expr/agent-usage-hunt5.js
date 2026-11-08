// Hunt: reproduce POST /api/agent-logs/{agentLogId}/usage seen in third-party capture.
const sid = new URLSearchParams(location.search).get('id') || location.pathname.split('/').pop();
const out = { sid, attempts: [] };
// 1) Get fresh session payload incl. token
const sess = await fetch('/api/chat/' + sid + '?includeStreamToken=false', { credentials: 'include' }).then(r => r.json()).catch(() => null);
const token = sess && sess.publicAccessToken;
if (token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    out.jwt = JSON.parse(atob(b64));
  } catch (e) { out.jwtErr = String(e); }
}
// candidate agentLogIds: session id, run id (jwt sub), chat id variants
const ids = [sid, out.jwt && out.jwt.sub].filter(Boolean);
const tryCall = async (method, path, body, auth) => {
  const rec = { method, path, auth: auth ? 'bearer' : 'cookie' };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers['Authorization'] = 'Bearer ' + token;
    const resp = await fetch(path, { method, headers, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body) });
    rec.status = resp.status;
    const t = await resp.text();
    rec.body = t.slice(0, 900);
    rec.bodyLen = t.length;
  } catch (e) { rec.err = String(e); }
  out.attempts.push(rec);
};
for (const id of ids) {
  await tryCall('POST', '/api/agent-logs/' + id + '/usage', {}, false);
  await tryCall('POST', '/api/agent-logs/' + id + '/usage', {}, true);
  await tryCall('GET', '/api/agent-logs/' + id + '/usage', undefined, false);
  await tryCall('GET', '/api/agent-logs/' + id + '/usage', undefined, true);
  await tryCall('GET', '/api/agent-logs/' + id, undefined, false);
}
await tryCall('GET', '/api/agent-logs?limit=5', undefined, false);
await tryCall('GET', '/api/agent-logs?chatId=' + sid, undefined, false);
return out;
