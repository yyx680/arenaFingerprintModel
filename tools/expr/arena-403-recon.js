/* 侦察第一步：拿一个真实会话 id，并读出当前登录态与 PostHog 功能门状态。

   返回：{me, sessions, flags, chatIds} */
const out = {url: location.href, me: null, sessions: [], flags: null, posthog: null};

try {
  const r = await fetch('/api/me', {credentials: 'include'});
  out.me = {status: r.status, body: (await r.text()).slice(0, 400)};
} catch (e) { out.me = {error: String(e)}; }

// 侧栏会话链接
const hrefs = [...document.querySelectorAll('a[href]')]
  .map((a) => a.getAttribute('href'))
  .filter((h) => h && /^\/(agent|work|chat)\//.test(h));
out.sessions = [...new Set(hrefs)].slice(0, 40);

// PostHog
const ph = globalThis.posthog;
out.posthog = ph ? {present: true, keys: Object.keys(ph).slice(0, 30)} : {present: false};
if (ph && typeof ph.getFeatureFlag === 'function') {
  const names = ['credit-system-m1', 'credit-system-m2', 'credit-system', 'billing', 'cost-system'];
  out.flags = {};
  for (const n of names) {
    try { out.flags[n] = ph.getFeatureFlag(n); } catch (e) { out.flags[n] = 'ERR ' + String(e); }
  }
  try { out.flags_all = ph.featureFlags?.getFlags?.() ?? null; } catch (e) { out.flags_all = 'ERR ' + String(e); }
}
// localStorage 里的 flag 缓存
try {
  out.ph_ls = Object.keys(localStorage).filter((k) => /ph_|posthog|feature/i.test(k)).slice(0, 20)
    .map((k) => ({k, v: String(localStorage.getItem(k)).slice(0, 300)}));
} catch (e) { out.ph_ls = String(e); }
try {
  out.cookies = document.cookie.split(';').map((s) => s.trim().split('=')[0]).filter(Boolean);
} catch (e) { out.cookies = String(e); }

return out;
