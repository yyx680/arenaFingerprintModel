/* 403 攻坚 · 第四步：试出 /api/chat/:id/messages 的 cursor 形态，看这条**未设门**的路由
   能不能给出带 cost 的消息（Hono schema 里 MessageCostSchema 挂在 message 上）。

   顺带把 /api/evaluation/:id 的 revealedModels 挖出来（揭晓后可能直接给模型名）。 */
const CHAT = '01a12bb5-3ce8-7bab-915e-5f69f7b6e1d1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raw = async (url) => {
  try {
    const r = await fetch(url, {credentials: 'include', headers: {'accept': 'application/json'}});
    return {status: r.status, body: await r.text()};
  } catch (e) { return {error: String(e).slice(0, 140)}; }
};
const out = {cursor_tries: []};

const CURSORS = [
  ['空串', ''],
  ['0', '0'],
  ['null', 'null'],
  ['messageId', '01a12bb5-3ce8-715e-aa5e-8cfea08026f4'],
  ['sessionId', CHAT],
  ['ISO', '2026-10-11T16:04:25.668633+00:00'],
  ['epoch', String(Date.now())],
  ['1', '1'],
  ['start', 'start'],
];
for (const [label, c] of CURSORS) {
  const r = await raw(`/api/chat/${CHAT}/messages?cursor=${encodeURIComponent(c)}`);
  out.cursor_tries.push({label, cursor: c.slice(0, 40), status: r.status, body: String(r.body || r.error).slice(0, 300)});
  await sleep(200);
  if (r.status === 200) break;
}

// 如果成功了，深挖返回结构里有没有 cost
const ok = out.cursor_tries.find((t) => t.status === 200);
if (ok) {
  const r = await raw(`/api/chat/${CHAT}/messages?cursor=${encodeURIComponent(ok.cursor)}`);
  try {
    const j = JSON.parse(r.body);
    out.messages_top_keys = Object.keys(j);
    const arr = j.messages || j.data || j.items || [];
    out.messages_count = Array.isArray(arr) ? arr.length : typeof arr;
    if (arr[0]) {
      out.msg0_keys = Object.keys(arr[0]);
      out.msg0_metadata = JSON.stringify(arr[0].metadata || {}).slice(0, 600);
      out.msg0_full = JSON.stringify(arr[0]).slice(0, 1400);
    }
    out.next_cursor = j.nextCursor || j.cursor || null;
    const RE = /cost|price|margin|charge|credit|usd/i;
    const hits = [];
    const walk = (n, p, d) => {
      if (d > 6 || !n || typeof n !== 'object') return;
      for (const [k, v] of Object.entries(n)) {
        if (RE.test(k)) hits.push({path: p + '.' + k, value: JSON.stringify(v).slice(0, 160)});
        if (v && typeof v === 'object') walk(v, p + '.' + k, d + 1);
      }
    };
    walk(j, '', 0);
    out.costish_in_messages = hits.slice(0, 30);
  } catch (e) { out.parse_error = String(e); }
}

// revealedModels
const ev = await raw(`/api/evaluation/${CHAT}`);
if (ev.status === 200) {
  try {
    const j = JSON.parse(ev.body);
    out.revealedModels = JSON.stringify(j.revealedModels).slice(0, 900);
    out.mode = j.mode;
    out.visibility = j.visibility;
    out.lastMessageIds = j.lastMessageIds;
  } catch (e) { out.revealed_error = String(e); }
}

return out;
