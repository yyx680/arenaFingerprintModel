// 拆解 /api/evaluation/<sid> 的完整 JSON，定位成本/用量字段
const out = { at: new Date().toISOString() };

const sid = (Object.keys(localStorage).map((k) => (k.match(/ampApiStash:([0-9a-f-]{20,})/i) || [])[1]).filter(Boolean))[0]
  || '01a1166f-9c00-71c2-849d-6d5a6d9f612d';
out.sid = sid;

const r = await fetch('/api/evaluation/' + sid, { headers: { accept: 'application/json' }, credentials: 'include' });
out.status = r.status;
const j = await r.json();
out.topKeys = Object.keys(j);

const msgs = j.messages || j.evaluation?.messages || [];
out.msgCount = msgs.length;
if (msgs[0]) out.msgKeys = Object.keys(msgs[0]);
if (msgs[1]) out.msgKeys2 = Object.keys(msgs[1]);

const s = JSON.stringify(j);
out.size = s.length;
out.costTokens = [...new Set(s.match(/"[A-Za-z_]*[Cc]ost[A-Za-z_]*"\s*:/g) || [])];
out.usageTokens = [...new Set(s.match(/"[A-Za-z_]*[Uu]sage[A-Za-z_]*"\s*:/g) || [])];
out.tokenTokens = [...new Set(s.match(/"[A-Za-z_]*(?:[Tt]okens|[Cc]redits|[Pp]rice|[Ss]pend)[A-Za-z_]*"\s*:/g) || [])];

const i = s.search(/cost|usage|credits/i);
out.firstHit = i >= 0 ? s.slice(Math.max(0, i - 300), i + 500) : null;

// 单条 assistant 消息结构（截断展示）
const asst = msgs.find((m) => m.role === 'assistant') || msgs[0];
if (asst) out.sampleMsg = JSON.stringify(asst).slice(0, 1500);

// /cost 子路由的不同请求形态
out.costRoute = [];
for (const [method, hdrs] of [['GET', { accept: 'application/json' }], ['GET', { accept: 'text/x-component', RSC: '1' }], ['POST', { 'content-type': 'application/json' }]]) {
  try {
    const rr = await fetch('/api/evaluation/' + sid + '/cost', { method, headers: hdrs, credentials: 'include', body: method === 'POST' ? '{}' : undefined });
    out.costRoute.push({ method, accept: hdrs.accept, status: rr.status, body: (await rr.text()).slice(0, 300) });
  } catch (e) { out.costRoute.push({ method, err: e.message }); }
}

return out;
