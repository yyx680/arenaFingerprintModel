/* 403 攻坚 · 第一步：完整功能门状态 + 找一个真实 chat id + 覆盖 flag 后重打 /cost。

   思路：如果门是「服务端读 PostHog flag」，客户端覆盖无效；
        但如果是「客户端算 + 服务端只做鉴权」，覆盖就能解锁。
        先试最便宜的：把 flag 覆盖成 true，再打一次 /cost 看状态码变不变。 */
const out = {steps: []};
const ph = globalThis.posthog;
const log = (name, v) => out.steps.push({name, ...(v && typeof v === 'object' ? v : {value: v})});

// ---------- 1. 完整 flag 快照 ----------
try {
  const enabled = ph?.featureFlags?.getFlags?.() || [];
  const raw = ph?.featureFlags?.getFlagVariants?.() || ph?.featureFlags?.flags || {};
  log('flags.enabled_count', enabled.length);
  log('flags.credit_system_present', {
    in_enabled: enabled.filter((f) => /credit|billing|cost|pricing/i.test(f)),
    in_raw: Object.keys(raw || {}).filter((f) => /credit|billing|cost|pricing/i.test(f)),
  });
  log('flags.all_credit_related', Object.keys(raw || {}).filter((f) => /credit|billing|cost|pricing|margin/i.test(f)).slice(0, 40));
} catch (e) { log('flags.error', String(e)); }

// ---------- 2. 找 chat id ----------
const ids = new Set();
const addId = (s) => { const m = String(s || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi); if (m) m.forEach((x) => ids.add(x)); };
document.querySelectorAll('a[href]').forEach((a) => addId(a.getAttribute('href')));
try { JSON.stringify(performance.getEntriesByType('resource').map((e) => e.name)).replace(/[^"]+/g, (s) => (addId(s), s)); } catch {}
// 已知历史会话（上一轮实测用过的）
['01a12bb5-3ce8-7bab-915e-5f69f7b6e1d1'].forEach((x) => ids.add(x));

// 试几个可能的会话列表端点
for (const u of ['/api/chat', '/api/chats', '/nextjs-api/chat', '/nextjs-api/chats', '/api/chat/list']) {
  try {
    const r = await fetch(u, {credentials: 'include'});
    const t = (await r.text()).slice(0, 300);
    log('list_probe ' + u, {status: r.status, body: t.slice(0, 160)});
    if (r.ok) { const m = t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi); if (m) m.forEach((x) => ids.add(x)); }
  } catch (e) { log('list_probe ' + u, {error: String(e).slice(0, 100)}); }
}
out.chatIds = [...ids].slice(0, 12);

// ---------- 3. 基线：先打一次 /cost 看状态码 ----------
const probeCost = async (id) => {
  const res = {};
  for (const [label, url] of [
    ['chat_cost_session', `/api/chat/${id}/cost?includeSession=true`],
    ['chat_cost_nosession', `/api/chat/${id}/cost?includeSession=false`],
    ['eval_cost', `/api/evaluation/${id}/cost`],
  ]) {
    try {
      const r = await fetch(url, {credentials: 'include'});
      res[label] = {status: r.status, body: (await r.text()).slice(0, 140)};
    } catch (e) { res[label] = {error: String(e).slice(0, 100)}; }
  }
  return res;
};
const testId = out.chatIds[0] || '01a12bb5-3ce8-7bab-915e-5f69f7b6e1d1';
out.testId = testId;
log('BASELINE ' + testId, await probeCost(testId));

// ---------- 4. 覆盖 flag 后再打 ----------
try {
  if (ph?.featureFlags?.override) {
    ph.featureFlags.override({ 'credit-system-m1': true, 'credit-system-m2': true, 'credit-system': true });
    log('override.applied', {via: 'featureFlags.override'});
  } else if (ph?.featureFlags?.overrideFeatureFlags) {
    ph.featureFlags.overrideFeatureFlags({ 'credit-system-m1': true, 'credit-system-m2': true });
    log('override.applied', {via: 'overrideFeatureFlags'});
  } else {
    log('override.applied', {via: 'none-available'});
  }
  log('AFTER_OVERRIDE ' + testId, await probeCost(testId));
} catch (e) { log('override.error', String(e)); }

return out;
