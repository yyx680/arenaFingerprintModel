// 成本接口要什么凭据：① cookie 形态 ② PostHog feature flags ③ API 客户端的鉴权头
const out = {at: new Date().toISOString()};

// ① cookie
out.cookies = document.cookie.split(';').map((s) => s.trim()).filter(Boolean).map((pair) => {
  const eq = pair.indexOf('=');
  const name = pair.slice(0, eq);
  const raw = pair.slice(eq + 1);
  const val = decodeURIComponent(raw);
  return {
    name,
    rawLen: raw.length,
    valLen: val.length,
    isJwt: /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(val),
    head: val.slice(0, 28),
  };
});

// ② PostHog feature flags
out.flags = {};
try {
  const phKey = Object.keys(localStorage).find((k) => k.includes('posthog'));
  out.flags.phKey = phKey || null;
  if (phKey) {
    const raw = localStorage.getItem(phKey) || '';
    out.flags.rawLen = raw.length;
    out.flags.head = raw.slice(0, 400);
    const hits = raw.match(/credit-system[^"]*"?\s*:\s*(true|false)/gi);
    out.flags.creditSystem = hits || null;
  }
  const phCookie = document.cookie.split(';').map((s) => s.trim()).find((s) => /ph_phc_/.test(s));
  if (phCookie) out.flags.cookie = phCookie.slice(0, 400);
} catch (e) { out.flags.err = e.message; }

// ③ 扫 chunk：API 客户端的鉴权头
const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)))];
out.authCode = [];
for (const u of urls.slice(0, 130)) {
  let t;
  try { t = await (await fetch(u, {credentials: 'omit'})).text(); } catch { continue; }
  const file = u.split('/').pop().split('?')[0];
  const re = /(Authorization|authorization|Bearer |credentials:"include"|credentials:'include')/g;
  let m;
  let n = 0;
  while ((m = re.exec(t)) && n < 3) {
    n++;
    const ctx = t.slice(Math.max(0, m.index - 500), m.index + 400).replace(/\s+/g, ' ');
    if (/api|fetch|header|token|session/i.test(ctx)) out.authCode.push({file, ctx});
  }
}
const seen = new Set();
out.authCode = out.authCode.filter((x) => { const k = x.file + x.ctx.slice(0, 90); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 10);

// ④ 用 cookie 值当 Bearer 再试一次成本接口
const sid = (Object.keys(localStorage).map((k) => (k.match(/ampApiStash:([0-9a-f-]{20,})/i) || [])[1]).filter(Boolean))[0] || '01a1166f-9c00-71c2-849d-6d5a6d9f612d';
out.bearer = [];
const tokens = out.cookies.filter((c) => /arena-auth/.test(c.name)).map((c) => {
  const eq = document.cookie.indexOf(c.name + '=');
  const raw = document.cookie.slice(eq + c.name.length + 1).split(';')[0];
  return {name: c.name, value: decodeURIComponent(raw)};
});
for (const tok of tokens) {
  for (const [label, url] of [['eval-cost', `/api/evaluation/${sid}/cost`], ['chat-cost', `/api/chat/${sid}/cost?includeSession=true`]]) {
    try {
      const r = await fetch(url, {headers: {accept: 'application/json', authorization: 'Bearer ' + tok.value}, credentials: 'include'});
      out.bearer.push({label, from: tok.name, tokenLen: tok.value.length, status: r.status, body: (await r.text()).slice(0, 200)});
    } catch (e) { out.bearer.push({label, from: tok.name, err: e.message}); }
  }
}

return out;
