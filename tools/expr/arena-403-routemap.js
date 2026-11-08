/* 403 攻坚 · 第十二步：抽出**完整** Hono RPC 路由地图（不只 chat/history），
   找有没有我们还没试过的 credits / billing / pricing / cost 相关路由。 */
const urls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n)))];
const calls = new Map();   // call -> chunk
// 简洁版（上一轮实测能匹配到 16 条）：从 api 开始，链式属性/下标，最后以 .$verb 收尾
const PAT = /api(?:\.[A-Za-z0-9_]+|\[[^\]]{0,30}\])+\.\$(?:get|post|put|patch|delete)/g;

for (const u of urls) {
  let text;
  try { text = await (await fetch(u)).text(); } catch { continue; }
  const name = u.split('/').pop().split('?')[0].slice(0, 30);
  let m;
  PAT.lastIndex = 0;
  while ((m = PAT.exec(text)) !== null) {
    const s = m[0];
    const norm = s.replace(/\[[^\]]{0,30}\]/g, '[:x]');
    if (!calls.has(norm)) calls.set(norm, name);
  }
}

const list = [...calls.entries()].map(([call, chunk]) => ({call, chunk}));
const byNs = {};
for (const {call, chunk} of list) {
  const ns = (call.slice(4).split('.')[0] || '?').replace(/\[.*/, '');
  (byNs[ns] = byNs[ns] || []).push(call + '  [' + chunk + ']');
}

const RE = /cost|credit|billing|price|payment|invoice|subscription|plan|usage|quota|balance|topup|margin/i;
const interesting = list.filter((x) => RE.test(x.call)).map((x) => x.call + '  [' + x.chunk + ']');

return {
  total_routes: list.length,
  namespaces: Object.fromEntries(Object.entries(byNs).map(([k, v]) => [k, v.length])),
  interesting,
  byNs,
};
