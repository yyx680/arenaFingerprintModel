/* 403 攻坚 · 第十一步：完整解析 /api/chat/:id（未设门的 agent chat 详情）。
   重点：messages[].metadata 里有没有 cost；pagination.cursor 长什么样；pinnedModel 是什么。 */
const CHAT = '01a12bda-ee50-7823-bed2-ae41c1fa69b6';
const out = {};

const r = await fetch(`/api/chat/${CHAT}`, {credentials: 'include', headers: {'accept': 'application/json'}});
out.status = r.status;
const j = await r.json();

out.top_keys = Object.keys(j);
out.taskId = j.taskId;
out.productMode = j.productMode;
out.pinnedModel = j.pinnedModel;
out.pagination = j.pagination;
out.lastEventId = j.lastEventId;
out.publicAccessToken_head = String(j.publicAccessToken || '').slice(0, 60);

const msgs = j.messages || [];
out.message_count = msgs.length;
out.message0_keys = msgs[0] ? Object.keys(msgs[0]) : null;
out.message0 = JSON.stringify(msgs[0]).slice(0, 1100);

// 每条消息的 metadata 键集合 + 是否带 cost
out.per_message = msgs.map((m) => ({
  role: m.role,
  position: m.participantPosition,
  modelId: m.modelId,
  status: m.status,
  metaKeys: Object.keys(m.metadata || {}),
  usage: m.metadata?.usage ? JSON.stringify(m.metadata.usage) : null,
  cost: m.metadata?.cost ?? null,
}));

// 全树搜 cost/price
const RE = /cost|price|pricing|margin|charge|credit|usd/i;
const hits = [];
const walk = (n, p, d) => {
  if (d > 8 || !n || typeof n !== 'object') return;
  for (const [k, v] of Object.entries(n)) {
    if (RE.test(k)) hits.push(p + '.' + k + ' = ' + (v && typeof v === 'object' ? JSON.stringify(v).slice(0, 150) : String(v).slice(0, 90)));
    if (v && typeof v === 'object') walk(v, p + '.' + k, d + 1);
  }
};
walk(j, '', 0);
out.costish = hits.slice(0, 30);

// 用 pagination.cursor 打通未设门的 messages 路由
if (j.pagination && j.pagination.cursor) {
  const c = j.pagination.cursor;
  out.cursor_value = String(c).slice(0, 80);
  out.cursor_is_uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(c));
  const r2 = await fetch(`/api/chat/${CHAT}/messages?cursor=${encodeURIComponent(c)}&limit=20`, {credentials: 'include', headers: {'accept': 'application/json'}});
  out.messages_status = r2.status;
  const t2 = await r2.text();
  out.messages_body = t2.slice(0, 900);
  if (r2.status === 200) {
    try {
      const j2 = JSON.parse(t2);
      out.messages_top_keys = Object.keys(j2);
      out.messages_pagination = j2.pagination;
      const m2 = j2.messages || [];
      out.messages_count = m2.length;
      if (m2[0]) { out.messages0_keys = Object.keys(m2[0]); out.messages0 = JSON.stringify(m2[0]).slice(0, 900); }
    } catch (e) { out.messages_parse = String(e); }
  }
} else {
  out.cursor_value = '(pagination.cursor 为空或不存在)';
}

return out;
