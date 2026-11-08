// stable arena.ai 的 agent 会话：结构对照
const sid = location.pathname.split('/').pop();
const out = {sid, href: location.href};
const r = await fetch('/api/chat/' + sid, {credentials: 'include'});
const j = await r.json().catch(() => null);
const msgs = (j && j.messages) || [];
out.chat = {
  status: r.status,
  topKeys: j ? Object.keys(j) : null,
  taskId: j && j.taskId, triggerAddress: j && j.triggerAddress,
  token: j && j.publicAccessToken,
  msgCount: msgs.length,
  msgRoles: msgs.map((m) => m.role),
  metaKeys: msgs.map((m) => (m.metadata ? Object.keys(m.metadata) : null)),
  metaSample: msgs.length ? JSON.stringify(msgs[msgs.length - 1].metadata).slice(0, 800) : null,
};
return out;
