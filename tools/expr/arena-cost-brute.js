// 拿一批候选会话 id 批量撞成本接口，看有没有任何一个能过（区分 UI 建的局 vs 接口建的局）
const IDS = (window.__AMP_IDS || []);

const out = {at: new Date().toISOString(), total: IDS.length, results: {}, ok: [], evalOk: [], chatOk: []};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64decode(value) {
  const clean = String(value).replace(/^base64-/, '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
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
function cookieOf(name) {
  const prefix = name + '=';
  const part = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : null;
}
const raw = cookieOf('arena-auth-prod-v1.0');
const token = raw ? (b64decode(raw).match(/"access_token"\s*:\s*"([A-Za-z0-9._-]{40,})"/) || [])[1] : null;
out.hasToken = !!token;
const auth = token ? {authorization: 'Bearer ' + token} : {};

// 先确认会话是否存在 + 是不是我们的（/api/evaluation/:id 免费可读）
for (const id of IDS.slice(0, 40)) {
  let meta = null;
  try {
    const r = await fetch('/api/evaluation/' + id, {headers: {accept: 'application/json'}, credentials: 'include'});
    if (r.ok) {
      const j = await r.json();
      const roles = (j.messages || []).map((m) => m.role + ':' + (m.status || ''));
      const withUsage = (j.messages || []).filter((m) => m.metadata && m.metadata.usage).length;
      const withCost = (j.messages || []).filter((m) => m.metadata && m.metadata.cost).length;
      meta = {mode: j.mode, msgs: (j.messages || []).length, withUsage, withCost, created: j.createdAt, revealed: (j.revealedModels || []).length, title: (j.title || '').slice(0, 30)};
    } else { meta = {status: r.status}; }
  } catch (e) { meta = {err: e.message}; }

  const probes = {};
  for (const [label, url] of [['eval', `/api/evaluation/${id}/cost`], ['chat', `/api/chat/${id}/cost?includeSession=true`]]) {
    try {
      const r = await fetch(url, {headers: {accept: 'application/json', ...auth}, credentials: 'include'});
      const body = await r.text();
      probes[label] = {status: r.status, len: body.length, body: body.slice(0, 600)};
      if (r.status === 200) (label === 'eval' ? out.evalOk : out.chatOk).push({id, body: body.slice(0, 1500)});
    } catch (e) { probes[label] = {err: e.message}; }
  }
  out.results[id.slice(0, 13)] = {meta, probes};
}

// 汇总
const tally = {};
for (const r of Object.values(out.results)) {
  for (const [k, v] of Object.entries(r.probes)) {
    const key = `${k}:${v.status || 'ERR'}`;
    tally[key] = (tally[key] || 0) + 1;
  }
}
out.tally = tally;
out.withCostField = Object.entries(out.results).filter(([, r]) => r.meta && r.meta.withCost > 0).map(([id]) => id);
out.modes = [...new Set(Object.values(out.results).map((r) => r.meta && r.meta.mode).filter(Boolean))];
return out;
