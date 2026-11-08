// Canary: test the cost gate on canary backend for our agent sessions.
const out = {};
for (const sid of ['01a12c3d-4498-7388-ae9c-17071b92e823', '01a12c2a-f113-73b4-ad1b-a9d6c8a3f01b']) {
  for (const q of ['?includeSession=true', '?includeSession=false']) {
    try {
      const resp = await fetch('/api/chat/' + sid + '/cost' + q, { credentials: 'include' });
      const t = await resp.text();
      out[sid.slice(0, 8) + q] = { s: resp.status, b: t.slice(0, 600) };
    } catch (e) { out[sid.slice(0, 8) + q] = String(e); }
  }
}
return out;
