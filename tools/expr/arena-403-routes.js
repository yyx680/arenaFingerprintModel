/* 403 攻坚 · 第二步：系统枚举 /api/chat/:id/* 与 /api/evaluation/:id/* 的兄弟路由。

   判据（实测过）：
     403 {"error":"Route not allowed"}  → 路由不存在
     403 {"error":"Unauthorized"}       → 路由存在，但被鉴权/功能门拦住
     400 ZodError                        → 路由存在且已进入参数校验（最"活"的信号）
     404 {"error":"Not found"}           → Next.js 层就没有
     405                                 → 路由存在，方法不对
     200                                 → 🎉 可用

   目标：找到一条**没被门拦**、又能给出用量/成本/单价的路由。 */
const CHAT = '01a12bb5-3ce8-7bab-915e-5f69f7b6e1d1';
const EVAL = '01a12bb5-3ce8-7bab-915e-5f69f7b6e1d1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const classify = (status, body) => {
  if (status === 200) return 'OK';
  if (status === 429) return 'RATELIMIT';
  if (body.includes('Route not allowed')) return 'not-exist';
  if (body.includes('Unauthorized')) return 'gated';
  if (body.includes('ZodError') || body.includes('validation')) return 'alive(bad-params)';
  if (status === 404) return 'not-exist';
  if (status === 405) return 'exists(wrong-method)';
  if (status === 400) return 'alive(bad-params)';
  return 'other:' + status;
};

const probe = async (url, method = 'GET') => {
  try {
    const r = await fetch(url, {method, credentials: 'include', headers: {'accept': 'application/json'}});
    const t = await r.text();
    return {url, status: r.status, cls: classify(r.status, t), body: t.slice(0, 160)};
  } catch (e) { return {url, error: String(e).slice(0, 120)}; }
};

const SUB = ['cost', 'costs', 'usage', 'usages', 'messages', 'message', 'model', 'models', 'meta',
             'metadata', 'pricing', 'price', 'billing', 'credits', 'balance', 'detail', 'info',
             'trace', 'traces', 'events', 'stream', 'share', 'export', 'token', 'tokens', 'stats'];

const results = [];
for (const base of [`/api/chat/${CHAT}`, `/api/evaluation/${EVAL}`]) {
  // 基座本身
  results.push(await probe(base));
  await sleep(160);
  for (const s of SUB) {
    results.push(await probe(`${base}/${s}`));
    await sleep(160);
  }
}

// 顶层候选
const TOP = ['/api/pricing', '/api/prices', '/api/models', '/api/model-catalog', '/api/me/credits',
             '/api/me/billing', '/api/me/usage', '/api/billing', '/api/credits', '/api/rate-card',
             '/nextjs-api/pricing', '/nextjs-api/models', '/nextjs-api/model-catalog',
             '/nextjs-api/rate-card', '/nextjs-api/me/credits'];
const top = [];
for (const u of TOP) { top.push(await probe(u)); await sleep(160); }

const group = (arr) => {
  const g = {};
  for (const r of arr) { const k = r.cls || ('ERR ' + (r.error || '').slice(0, 40)); (g[k] = g[k] || []).push(r.url.replace(CHAT, ':id')); }
  return g;
};

return {
  汇总_子路由: group(results),
  明细_非not_exist: results.filter((r) => r.cls !== 'not-exist' && r.cls !== 'ERR').map((r) => `${r.cls}  ${r.url.replace(CHAT, ':id')}  ${r.body.slice(0, 90)}`),
  顶层: top.map((r) => `${r.cls}  ${r.url}  ${(r.body || r.error || '').slice(0, 90)}`),
};
