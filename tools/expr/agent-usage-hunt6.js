// Final attempt: supabase session JWT as bearer + path variants for agent-logs/usage
const sid = location.pathname.split('/').pop();
const out = { attempts: [], tokenSources: [] };
// find supabase token
for (let i = 0; i < localStorage.length; i++) {
  const k = localStorage.key(i);
  if (/sb-|supabase|amplify|authenticator/i.test(k)) {
    out.tokenSources.push(k);
  }
}
let sbToken = null;
for (const k of out.tokenSources) {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    const t = v && (v.access_token || (v.value && v.value.access_token) || (v.session && v.session.access_token));
    if (t) { sbToken = t; break; }
  } catch {}
}
out.haveSbToken = !!sbToken;
const tryCall = async (method, path, body, auth) => {
  const rec = { method, path, auth };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (auth === 'sb') headers['Authorization'] = 'Bearer ' + sbToken;
    if (auth === 'apikey') headers['apikey'] = sbToken || '';
    const resp = await fetch(path, { method, headers, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body) });
    rec.status = resp.status;
    const t = await resp.text();
    rec.body = t.slice(0, 500);
  } catch (e) { rec.err = String(e); }
  out.attempts.push(rec);
};
await tryCall('POST', '/api/agent-logs/' + sid + '/usage', {}, 'sb');
await tryCall('GET', '/api/agent-logs/' + sid + '/usage', undefined, 'sb');
await tryCall('POST', '/nextjs-api/agent-logs/' + sid + '/usage', {}, 'cookie');
await tryCall('GET', '/api/agent-logs/' + sid + '/usage', undefined, 'apikey');
// also: does any bundle JS reference agent-logs? (route name confirms feature exists in client)
return out;
