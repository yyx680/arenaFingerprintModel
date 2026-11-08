// Agent 会话：消息级 metadata/parts 全量 + trigger 信息（只读）。
const sid = location.pathname.split('/').pop();
const r = await fetch('/api/chat/' + sid, {credentials: 'include'});
const j = await r.json();
const clip = (s, n) => { try { const t = JSON.stringify(s); return t && t.length > n ? t.slice(0, n) + '...(cut)' : t; } catch { return String(s); } };
const msgs = (j.messages || []).map((m) => ({
  id: m.id, role: m.role,
  metaKeys: m.metadata ? Object.keys(m.metadata) : null,
  meta: clip(m.metadata, 1200),
  partTypes: Array.isArray(m.parts) ? m.parts.map((p) => p && p.type) : null,
  partsSample: Array.isArray(m.parts) ? clip(m.parts.slice(-2), 1500) : null,
}));
return {
  taskId: j.taskId, triggerAddress: j.triggerAddress, lastEventId: j.lastEventId,
  pagination: j.pagination, productMode: j.productMode, pinnedModel: j.pinnedModel,
  token: j.publicAccessToken,
  msgCount: msgs.length, msgs,
};
