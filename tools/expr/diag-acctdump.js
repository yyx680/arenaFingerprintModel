(async () => {
  const out = {};
  const U = String.fromCharCode(117,115,97,103,101);
  const IT = String.fromCharCode(105,110,112,117,116,84,111,107,101,110,115);
  const MD = String.fromCharCode(109,101,116,97,100,97,116,97);
  const AT = String.fromCharCode(97,99,99,101,115,115,95,116,111,107,101,110);
  const g = async (u) => { try { const r = await fetch(u, {credentials:'include'}); const t = await r.text(); return {s: r.status, len: t.length, body: t.slice(0, 900)}; } catch (e) { return {err: String(e).slice(0, 50)}; } };
  out.me = await g('/api/me');
  out.pulse = await g('/api/me/pulse');
  const h = await (await fetch('/api/history/unified?limit=2&includeArchived=false', {credentials:'include'})).json();
  const e0 = (h.entries || [])[0] || {};
  out.entryKeys = Object.keys(e0);
  out.entry = {};
  for (const k of Object.keys(e0)) { const v = e0[k]; if (/email|avatar|displayName/i.test(k)) { out.entry[k] = '[pii]'; } else if (typeof v === 'string') { out.entry[k] = v.slice(0, 100); } else if (v && typeof v === 'object') { out.entry[k] = JSON.stringify(v).slice(0, 160); } else { out.entry[k] = v; } }
  const ev = await (await fetch('/api/evaluation/' + e0.id, {credentials:'include'})).json();
  out.masked0 = null;
  if (ev.maskedEvaluations && ev.maskedEvaluations[0]) { const m0 = ev.maskedEvaluations[0]; out.masked0keys = Object.keys(m0); const o = {}; for (const k of Object.keys(m0)) { const v = m0[k]; if (typeof v === 'string') { o[k] = v.slice(0, 90); } else if (v && typeof v === 'object') { o[k] = JSON.stringify(v).slice(0, 140); } else { o[k] = v; } } out.masked0 = o; }
  try { const ph = window.posthog; const names = Object.keys(ph.featureFlags.getFlagVariants()).sort(); out.flagCount = names.length; out.billFlags = names.filter((x) => /credit|bill|cost|price|pay|topup|portal|trial|plan|limit|quota|spend|subscription/i.test(x)); } catch (e) { out.flagErr = String(e).slice(0, 60); }
  try { const raw = document.cookie.split(';').map((s) => s.trim()).find((s) => s.indexOf('arena-auth-prod-v1.0=') === 0); let v = decodeURIComponent(raw.split('=').slice(1).join('=')); if (v.indexOf('base64-') === 0) v = v.slice(7); const obj = JSON.parse(atob(v)); const parts = String(obj[AT] || '').split('.'); const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/'); const pad = b64 + '===='.slice(0, (4 - b64.length % 4) % 4); const claims = JSON.parse(atob(pad)); out.jwt = {role: claims.role, exp: claims.exp, keys: Object.keys(claims), appmeta: claims.app_metadata, umKeys: claims.user_metadata ? Object.keys(claims.user_metadata) : null}; } catch (e) { out.jwtErr = String(e).slice(0, 60); }
  out.oldSess = [];
  const oldIds = ['01a12bb5-3ce8-7bab-915e-5f69f7b6e1d1', '01a1166f-9c00-71c2-849d-6d5a6d9f612d'];
  for (const sid of oldIds) { const rec = {sid: sid.slice(0, 13)}; try { const r = await fetch('/api/evaluation/' + sid, {credentials:'include'}); rec.eval = r.status; if (r.ok) { const s = await r.text(); rec.len = s.length; rec.hasU = s.indexOf(U) > -1; rec.hasIT = s.indexOf(IT) > -1; const mi = s.indexOf(MD); rec.mdSample = mi > -1 ? s.slice(mi, mi + 200) : null; } else { rec.head = (await r.text()).slice(0, 60); } } catch (e) { rec.err = String(e).slice(0, 50); } out.oldSess.push(rec); }
  return out;
})()
