// Broad route sweep for usage/cost surfaces + deep-scan history payload.
const sid = location.pathname.split('/').pop();
const out = { sweep: [], historyScan: null };
const ROUTES = [
  ['GET','/api/usage'],['GET','/api/me/usage'],['GET','/api/me/cost'],['GET','/api/me/credits'],
  ['GET','/api/me/spend'],['GET','/api/me/spending'],['GET','/api/me/activity'],['GET','/api/me/tokens'],
  ['GET','/api/credits'],['GET','/api/cost'],['GET','/api/spend'],['GET','/api/credits/balance'],
  ['GET','/api/chat/'+sid+'/usage'],['GET','/api/chat/'+sid+'/tokens'],['GET','/api/chat/'+sid+'/stats'],
  ['GET','/api/chat/'+sid+'/metrics'],['GET','/api/chat/'+sid+'/events'],['GET','/api/chat/'+sid+'/messages'],
  ['GET','/api/agent-logs/usage'],['GET','/api/agent-logs/me'],
  ['GET','/api/sessions/'+sid+'/usage'],['GET','/api/conversations/'+sid+'/usage'],
  ['GET','/api/evaluations/'+sid+'/usage'],['GET','/api/evaluation/'+sid+'/usage'],
  ['GET','/api/telemetry'],['GET','/api/analytics/me'],['GET','/api/activity'],
];
for (const [m, p] of ROUTES) {
  try {
    const resp = await fetch(p, { method: m, credentials: 'include' });
    const t = await resp.text();
    const rec = { p, s: resp.status };
    // only keep body if NOT the standard 403 route-block and not empty
    if (resp.status !== 403 && resp.status !== 404 && t) rec.b = t.slice(0, 220);
    out.sweep.push(rec);
  } catch (e) { out.sweep.push({ p, err: String(e).slice(0, 60) }); }
}
// deep-scan history for per-session usage/cost fields
try {
  const h = await fetch('/api/history/unified?limit=20&includeArchived=false', { credentials: 'include' }).then(r => r.json());
  const found = {};
  const walk = (v, path, depth) => {
    if (depth > 5 || !v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      const p = path ? path + '.' + k : k;
      if (/usage|tokens?|cost|usd|credit|price|spend|bill/i.test(k)) found[p] = typeof val === 'object' ? JSON.stringify(val).slice(0, 150) : String(val);
      if (val && typeof val === 'object') walk(val, p, depth + 1);
    }
  };
  walk(h, '', 0);
  out.historyScan = { keys: Object.keys(found).slice(0, 40), sample: Object.entries(found).slice(0, 12) };
} catch (e) { out.historyScan = { err: String(e) }; }
return out;
