// 在 arena.ai 页面上下文执行：只读侦察登录态 + 探测可能下发成本/用量的端点
const out = {
  at: new Date().toISOString(),
  href: location.href,
  title: document.title,
  ua: navigator.userAgent,
  cookieNames: document.cookie.split(';').map((s) => s.trim().split('=')[0]).filter(Boolean),
  ls: Object.keys(localStorage).slice(0, 60),
  ss: Object.keys(sessionStorage).slice(0, 60),
};

// 抓页面里可能存在的 Next.js 数据
try {
  const nd = document.getElementById('__NEXT_DATA__');
  out.hasNextData = !!nd;
} catch {}

const endpoints = [
  '/api/me',
  '/api/me/pulse',
  '/api/user',
  '/api/account',
  '/api/credits',
  '/api/usage',
  '/api/billing',
  '/api/me/usage',
  '/api/me/credits',
  '/api/leaderboard',
  '/api/leaderboard/agent',
  '/api/evaluations',
  '/nextjs-api/me',
];

out.probe = {};
for (const ep of endpoints) {
  try {
    const r = await fetch(ep, { headers: { accept: 'application/json, text/plain, */*' }, credentials: 'include' });
    const txt = await r.text();
    let costHit = null;
    try {
      const j = JSON.parse(txt);
      const s = JSON.stringify(j);
      const m = s.match(/"(cost|totalCost|total_cost|costUsd|cost_usd|priceUsd|spend|creditsUsed|total_tokens|prompt_tokens|completion_tokens|usage)"\s*:/gi);
      if (m) costHit = [...new Set(m)];
    } catch {}
    out.probe[ep] = { status: r.status, ct: r.headers.get('content-type'), len: txt.length, costHit, head: txt.slice(0, 240) };
  } catch (e) {
    out.probe[ep] = 'ERR ' + e.message;
  }
}

// 常见的内嵌配置/账单挂点
out.globals = {};
for (const k of ['__NEXT_DATA__', '__ARENA__', 'arena', 'stripe', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY']) {
  try {
    const v = window[k];
    if (v !== undefined) out.globals[k] = typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : String(v).slice(0, 200);
  } catch {}
}

return out;
