// 抠出每条消息 metadata 里的 usage / cost 结构，并尝试带 Bearer 访问 /cost 路由
const out = { at: new Date().toISOString(), msgs: [], bearer: [] };

const sid = (Object.keys(localStorage).map((k) => (k.match(/ampApiStash:([0-9a-f-]{20,})/i) || [])[1]).filter(Boolean))[0]
  || '01a1166f-9c00-71c2-849d-6d5a6d9f612d';
out.sid = sid;

const r = await fetch('/api/evaluation/' + sid, { headers: { accept: 'application/json' }, credentials: 'include' });
const j = await r.json();

for (const m of (j.messages || [])) {
  const md = m.metadata || {};
  out.msgs.push({
    id: (m.id || '').slice(0, 12),
    role: m.role,
    pos: m.participantPosition,
    status: m.status,
    modelId: m.modelId,
    metaKeys: Object.keys(md),
    usage: md.usage ?? null,
    usageSource: md.usageSource ?? null,
    cost: md.cost ?? null,
    // 任何名字里含 cost/credit/price 的键
    costish: Object.fromEntries(Object.entries(md).filter(([k]) => /cost|credit|price|charge|spend/i.test(k))),
    metaHead: JSON.stringify(md).slice(0, 900),
  });
}

// 尝试 Bearer（arena-auth cookie）
let tok = null;
try { tok = decodeURIComponent((document.cookie.match(/arena-auth-prod-v1\.[01]=([^;]+)/) || [])[1] || ''); } catch {}
out.authCookieLen = tok ? tok.length : 0;
out.authCookieHead = tok ? tok.slice(0, 40) + '...' : null;

for (const [label, headers] of [
  ['cookie-only', { accept: 'application/json' }],
  ['bearer', tok ? { accept: 'application/json', authorization: 'Bearer ' + tok } : null],
  ['rsc-bearer', tok ? { accept: 'text/x-component', RSC: '1', authorization: 'Bearer ' + tok } : null],
].filter((x) => x[1])) {
  try {
    const rr = await fetch('/api/evaluation/' + sid + '/cost', { headers, credentials: 'include' });
    out.bearer.push({ label, status: rr.status, body: (await rr.text()).slice(0, 500) });
  } catch (e) { out.bearer.push({ label, err: e.message }); }
}

// 会话级聚合：page 上是否有 cost 上下文挂点
out.evalKeys = Object.keys(j);
out.revealed = (j.revealedModels || []).slice(0, 3);

return out;
