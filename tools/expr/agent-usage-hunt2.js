/* Agent 用量猎取·第二步（只读）：查 run-status 与 Trigger.dev 运行轨迹。
   OTel span 的 attributes 里常带 gen_ai.usage.*（输入/输出 token）——若在那里，
   「别人能拿到 agent 模式用量」就有了出处。只报字段路径与数字，不取任何正文。 */
const SID = location.pathname.split('/').filter(Boolean).pop();
const INTEREST = /usage|tokens?|cost|usd|credit|price|spend/i;
const out = {at: new Date().toISOString(), sid: SID, steps: []};

function scan(value, path, hits, depth) {
  if (depth > 12 || hits.length > 150 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.length) scan(value[0], path + '[0]', hits, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if (INTEREST.test(k)) {
      const hit = {path: p.slice(-140), type: Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v};
      if (typeof v === 'number') hit.value = v;
      hits.push(hit);
    }
    if (v && typeof v === 'object') scan(v, p, hits, depth + 1);
  }
}

async function probeJson(url, headers, label) {
  try {
    const r = await fetch(url, {headers: headers || {}});
    const text = await r.text();
    const entry = {step: label, url: url.replace(SID, '<sid>').slice(0, 160), status: r.status, bytes: text.length};
    let j = null;
    try { j = JSON.parse(text); } catch { /* ignore */ }
    if (j && typeof j === 'object') {
      const hits = [];
      scan(j, '', hits, 0);
      entry.usage_hits = hits.slice(0, 120);
      entry.top_keys = Object.keys(j).slice(0, 30);
    } else {
      entry.note = 'non-json';
    }
    return entry;
  } catch (e) { return {step: label, error: String(e).slice(0, 140)}; }
}

/* 1) 会话 JSON 拿 publicAccessToken（该 token 是「读这一次运行」的公开凭证） */
let token = null;
try {
  const sess = await fetch(`/api/chat/${SID}`, {credentials: 'include'}).then(r => r.json());
  token = sess?.publicAccessToken || null;
} catch { /* ignore */ }
out.has_token = !!token;

/* 2) run-status（页面自己刚调用过的路由） */
out.steps.push(await probeJson(`/api/chat/${SID}/run-status?inputId=01a12c17-af15-779c-9b0a-139502da8d58`, {credentials0: 0} && undefined, 'run-status'));

/* 3) Trigger.dev 运行轨迹 */
if (token) {
  let claims = {};
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(atob(part));
  } catch { /* ignore */ }
  out.token_claim_keys = Object.keys(claims).slice(0, 30);
  const runId = String(claims.sub || claims.runId || claims.run_id || claims.run || '');
  out.run_id = runId.slice(0, 60);
  if (/^run_/.test(runId)) {
    for (const path of [`/api/v1/runs/${runId}/trace`, `/api/v3/runs/${runId}`, `/api/v1/runs/${runId}/events`]) {
      out.steps.push(await probeJson(`https://api.trigger.dev${path}`, {authorization: `Bearer ${token}`}, `trigger ${path.replace(runId, '<run>')}`));
    }
  }
}
return out;
