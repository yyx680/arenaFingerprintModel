/* 403 攻坚 · 第三步：摸清两条"活着"的路由，并在 /api/evaluation/:id 里找成本字段。

   A) /api/chat/:id/messages  —— 400 参数校验，说明真实存在。用 ZodError 反推它的参数名。
   B) /api/evaluation/:id     —— 200，逐层找 cost/price/margin/pricingStrategy 字段。
   C) /nextjs-api/model-catalog —— 200，找价格字段。 */
const CHAT = '01a12bb5-3ce8-7bab-915e-5f69f7b6e1d1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};

const raw = async (url, opts = {}) => {
  try {
    const r = await fetch(url, {credentials: 'include', headers: {'accept': 'application/json'}, ...opts});
    const t = await r.text();
    return {status: r.status, body: t};
  } catch (e) { return {error: String(e).slice(0, 140)}; }
};

// ---------- A) messages 路由的参数反推 ----------
const a = [];
a.push({q: 'GET 裸', ...(await raw(`/api/chat/${CHAT}/messages`))});
await sleep(200);
a.push({q: 'GET ?limit=5', ...(await raw(`/api/chat/${CHAT}/messages?limit=5`))});
await sleep(200);
a.push({q: 'GET ?messageIds=x', ...(await raw(`/api/chat/${CHAT}/messages?messageIds=x`))});
await sleep(200);
a.push({q: 'GET ?ids=x', ...(await raw(`/api/chat/${CHAT}/messages?ids=x`))});
await sleep(200);
a.push({q: 'GET ?includeCost=true', ...(await raw(`/api/chat/${CHAT}/messages?includeCost=true`))});
await sleep(200);
a.push({q: 'POST {}', ...(await raw(`/api/chat/${CHAT}/messages`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}))});
out.A_messages = a.map((x) => ({q: x.q, status: x.status, body: String(x.body || x.error).slice(0, 420)}));

// ---------- B) evaluation 里的成本字段 ----------
const ev = await raw(`/api/evaluation/${CHAT}`);
out.B_status = ev.status;
if (ev.status === 200) {
  let j = null;
  try { j = JSON.parse(ev.body); } catch (e) { out.B_parse = String(e); }
  if (j) {
    out.B_top_keys = Object.keys(j);
    const RE = /cost|price|pricing|margin|charge|credit|billing|discount|usd/i;
    const hits = [];
    const walk = (node, path, depth) => {
      if (depth > 6 || !node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        const p = path + '.' + k;
        if (RE.test(k)) hits.push({path: p, value: (v && typeof v === 'object') ? JSON.stringify(v).slice(0, 200) : String(v)});
        if (v && typeof v === 'object') walk(v, p, depth + 1);
      }
    };
    walk(j, '', 0);
    out.B_costish_fields = hits.slice(0, 40);
    // 消息层的 metadata 键（看有没有漏掉的字段）
    const msgs = j.messages || j.evaluation?.messages || [];
    out.B_message_count = msgs.length;
    if (msgs[0]) out.B_message0_keys = Object.keys(msgs[0]);
    const mds = [...new Set(msgs.map((m) => JSON.stringify(Object.keys(m.metadata || {}))))];
    out.B_metadata_key_sets = mds.slice(0, 6);
    // 一条完整消息样本（截断）
    out.B_message0 = JSON.stringify(msgs[0]).slice(0, 1200);
  }
}

// ---------- C) model-catalog 的价格字段 ----------
const mc = await raw('/nextjs-api/model-catalog');
out.C_status = mc.status;
if (mc.status === 200) {
  try {
    const j = JSON.parse(mc.body);
    const groups = Array.isArray(j) ? j : (j.models || j.data || []);
    out.C_groups = Array.isArray(groups) ? groups.length : typeof groups;
    const flat = [];
    const collect = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(collect); return; }
      if (n.id && (n.organization || n.displayName)) flat.push(n);
      Object.values(n).forEach(collect);
    };
    collect(j);
    out.C_model_count = flat.length;
    out.C_model0_keys = flat[0] ? Object.keys(flat[0]) : null;
    const RE = /price|cost|margin|rate/i;
    out.C_priceish = flat.length ? Object.keys(flat[0]).filter((k) => RE.test(k)) : [];
    // 任意一个模型里带价格字段的样本
    const withPrice = flat.filter((m) => Object.keys(m).some((k) => RE.test(k)));
    out.C_with_price_count = withPrice.length;
    if (withPrice[0]) out.C_sample = JSON.stringify(withPrice[0]).slice(0, 600);
    out.C_model_names = flat.slice(0, 8).map((m) => m.id || m.displayName);
  } catch (e) { out.C_parse = String(e); }
}

return out;
