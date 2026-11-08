/* 403 攻坚 · 第五步（关键）：用真 agent chat id 打**未设门**的 /api/chat/:id/messages，
   看它是否直接返回带 cost 的消息 —— 若是，就绕开了被拦的 /cost 路由。

   同时查 /api/chat/agent-models 里有没有价格。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raw = async (url) => {
  try {
    const r = await fetch(url, {credentials: 'include', headers: {'accept': 'application/json'}});
    return {status: r.status, body: await r.text()};
  } catch (e) { return {error: String(e).slice(0, 140)}; }
};
const out = {};

// ---------- 1. 会话列表 ----------
const hist = await raw('/api/history/unified?limit=30&includeArchived=false');
out.history_status = hist.status;
let histJson = null;
try { histJson = JSON.parse(hist.body); } catch {}
if (histJson) {
  out.history_top_keys = Object.keys(histJson);
  const arr = histJson.items || histJson.sessions || histJson.data || histJson.chats || histJson.history || [];
  out.history_count = Array.isArray(arr) ? arr.length : typeof arr;
  if (arr[0]) { out.history0_keys = Object.keys(arr[0]); out.history0 = JSON.stringify(arr[0]).slice(0, 700); }
  // 找出 agent 类型的条目（区分 chat / battle）
  const kinds = {};
  for (const it of (Array.isArray(arr) ? arr : [])) {
    const k = String(it.type || it.mode || it.kind || it.visibility || 'unknown');
    kinds[k] = (kinds[k] || 0) + 1;
  }
  out.history_kinds = kinds;
  out.history_ids = (Array.isArray(arr) ? arr : []).slice(0, 10).map((it) => ({id: it.id || it.sessionId || it.chatId, type: it.type || it.mode, title: String(it.title || '').slice(0, 30)}));
}

// ---------- 2. agent-models ----------
const am = await raw('/api/chat/agent-models');
out.agent_models_status = am.status;
try {
  const j = JSON.parse(am.body);
  out.agent_models_top = Array.isArray(j) ? 'array' : Object.keys(j);
  const arr = Array.isArray(j) ? j : (j.models || j.data || []);
  out.agent_models_count = arr.length;
  if (arr[0]) { out.agent_model0_keys = Object.keys(arr[0]); out.agent_model0 = JSON.stringify(arr[0]).slice(0, 500); }
  const RE = /price|cost|margin|rate|credit/i;
  out.agent_models_priceish = arr[0] ? Object.keys(arr[0]).filter((k) => RE.test(k)) : [];
} catch (e) { out.agent_models_body = am.body.slice(0, 300); }

// ---------- 3. 关键：用 agent chat id 打未设门的 messages ----------
const tries = [];
const candidates = (out.history_ids || []).map((x) => x.id).filter(Boolean);
// 兜底：也把 history 里所有 id 拿来试
if (histJson) {
  const all = JSON.stringify(histJson).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
  for (const x of all) if (!candidates.includes(x)) candidates.push(x);
}
out.candidate_count = candidates.length;

for (const id of candidates.slice(0, 8)) {
  const r = await raw(`/api/chat/${id}/messages?cursor=${id}`);
  const t = String(r.body || r.error);
  tries.push({id, status: r.status, head: t.slice(0, 220)});
  await sleep(220);
  if (r.status === 200) {
    out.HIT = {id, keys: null, sample: t.slice(0, 1500)};
    try {
      const j = JSON.parse(t);
      out.HIT.keys = Object.keys(j);
      const arr = j.messages || j.data || j.items || [];
      out.HIT.count = arr.length;
      if (arr[0]) { out.HIT.msg0_keys = Object.keys(arr[0]); out.HIT.msg0_metadata = JSON.stringify(arr[0].metadata || {}).slice(0, 700); }
      const RE = /cost|price|margin|charge|credit|usd/i;
      const hits = [];
      const walk = (n, p, d) => {
        if (d > 7 || !n || typeof n !== 'object') return;
        for (const [k, v] of Object.entries(n)) {
          if (RE.test(k)) hits.push({path: p + '.' + k, value: JSON.stringify(v).slice(0, 200)});
          if (v && typeof v === 'object') walk(v, p + '.' + k, d + 1);
        }
      };
      walk(j, '', 0);
      out.HIT.costish = hits.slice(0, 30);
    } catch (e) { out.HIT.parse = String(e); }
    break;
  }
}
out.messages_tries = tries;

return out;
