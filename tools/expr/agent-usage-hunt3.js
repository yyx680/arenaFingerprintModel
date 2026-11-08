/* Agent 用量猎取·第三步：用 publicAccessToken 的 sub（cuid 形运行 id）打 Trigger.dev 轨迹。 */
const SID = location.pathname.split('/').filter(Boolean).pop();
const INTEREST = /usage|tokens?|cost|usd|credit|price|spend/i;
const out = {steps: []};
function scan(value, path, hits, depth) {
  if (depth > 12 || hits.length > 160 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) { if (value.length) scan(value[0], path + '[0]', hits, depth + 1); return; }
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if (INTEREST.test(k)) {
      const hit = {path: p.slice(-150), type: Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v};
      if (typeof v === 'number') hit.value = v;
      hits.push(hit);
    }
    if (v && typeof v === 'object') scan(v, p, hits, depth + 1);
  }
}
const sess = await fetch(`/api/chat/${SID}`, {credentials: 'include'}).then(r => r.json()).catch(() => null);
const token = sess?.publicAccessToken || null;
if (!token) return {error: 'no token'};
let claims = {};
try { claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch {}
const runId = String(claims.sub || '');
out.run_id = runId;
for (const path of [`/api/v1/runs/${runId}/trace`, `/api/v3/runs/${runId}`, `/api/v1/runs/${runId}/events`, `/api/v2/runs/${runId}`]) {
  try {
    const r = await fetch(`https://api.trigger.dev${path}`, {headers: {authorization: `Bearer ${token}`}});
    const text = await r.text();
    const entry = {path, status: r.status, bytes: text.length};
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (j && typeof j === 'object') {
      const hits = [];
      scan(j, '', hits, 0);
      entry.usage_hits = hits.slice(0, 140);
      entry.top_keys = Object.keys(j).slice(0, 30);
    } else entry.body_head = text.slice(0, 120);
    out.steps.push(entry);
  } catch (e) { out.steps.push({path, error: String(e).slice(0, 120)}); }
}
return out;
