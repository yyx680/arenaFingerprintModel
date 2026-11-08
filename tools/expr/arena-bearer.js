// 解开 arena-auth-prod-v1.0（base64-{access_token,...}），拿 access_token 当 Bearer 再撞成本接口
const out = {at: new Date().toISOString()};

function cookieOf(name) {
  const prefix = name + '=';
  const part = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : null;
}
out.decodeDebug = [];
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// 手写解码器：不用 atob，绝不抛错（atob 对长度/填充/非字母字符极其挑剔）
function b64decode(value) {
  const original = String(value).replace(/^base64-/, '');
  const clean = original.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  out.decodeDebug.push({rawLen: original.length, cleanLen: clean.length, head: original.slice(0, 24)});
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const idx = B64.indexOf(ch);
    if (idx < 0) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xff); }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

const sessions = [];
for (const name of ['arena-auth-prod-v1.0', 'arena-auth-prod-v1.1']) {
  const raw = cookieOf(name);
  if (!raw) continue;
  const entry = {name, rawLen: raw.length, parsed: false};
  const text = b64decode(raw);
  entry.head = text.slice(0, 60);
  // 不用 JSON.parse（实测在 2379 位挂），直接正则抠 access_token
  const m = text.match(/"access_token"\s*:\s*"([A-Za-z0-9._-]{40,})"/);
  const token = m ? m[1] : null;
  entry.hasAccessToken = !!token;
  entry.accessTokenLen = token ? token.length : 0;
  if (token) {
    try {
      const payload = JSON.parse(b64decode(token.split('.')[1]));
      entry.jwt = {role: payload.role, aud: payload.aud, iss: payload.iss, exp: payload.exp, sub: payload.sub};
      entry.jwtExpIso = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
    } catch (e) { entry.jwtErr = e.message; }
  }
  const rt = text.match(/"refresh_token"\s*:\s*"([^"]{10,})"/);
  entry.hasRefreshToken = !!rt;
  sessions.push({entry, token});
}
out.sessions = sessions.map((s) => s.entry);

// PostHog flags 全量搜
try {
  const phKey = Object.keys(localStorage).find((k) => k.includes('posthog'));
  const raw = phKey ? localStorage.getItem(phKey) || '' : '';
  out.phCredit = (raw.match(/credit[^"]*"?\s*:\s*[^,}]{0,20}/gi) || []).slice(0, 12);
  const m = raw.match(/"\$active_feature_flags":\[[^\]]*\]/);
  out.phActive = m ? m[0].slice(0, 600) : null;
} catch (e) { out.phErr = e.message; }

// 用 access_token 撞接口
const sid = (Object.keys(localStorage).map((k) => (k.match(/ampApiStash:([0-9a-f-]{20,})/i) || [])[1]).filter(Boolean))[0] || '01a1166f-9c00-71c2-849d-6d5a6d9f612d';
out.sid = sid;
out.tried = [];
for (const {entry, token} of sessions) {
  if (!token) continue;
  for (const [label, url] of [
    ['eval-cost', `/api/evaluation/${sid}/cost`],
    ['chat-cost', `/api/chat/${sid}/cost?includeSession=true`],
    ['me', '/api/me'],
  ]) {
    try {
      const r = await fetch(url, {headers: {accept: 'application/json', authorization: 'Bearer ' + token}, credentials: 'include'});
      const body = await r.text();
      out.tried.push({from: entry.name, label, status: r.status, len: body.length, body: body.slice(0, 700)});
    } catch (e) { out.tried.push({from: entry.name, label, err: e.message}); }
  }
}

return out;
