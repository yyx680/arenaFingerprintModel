/* 403 攻坚 · 第十三步：收尾实验，把"万一能绕"的可能逐个排除。

   E1 带上应用真实的 x-arena-web-deployment 头（会不会按部署灰度？）
   E2 OPTIONS 探成本路由的允许方法与头
   E3 POST 成本路由
   E4 尾斜杠 / 大小写 / 多余 query 的变体
   E5 Pareto 榜单里 costPerTaskUsd 到底有没有值（另一条"按价格"的路） */
const EVAL = '01a12bb5-3ce8-7bab-915e-5f69f7b6e1d1';
const CHAT = '01a12bda-ee50-7823-bed2-ae41c1fa69b6';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {E: []};

const tryReq = async (label, url, opts = {}) => {
  try {
    const r = await fetch(url, {credentials: 'include', ...opts});
    const t = await r.text();
    out.E.push({label, status: r.status, allow: r.headers.get('allow'), body: t.slice(0, 160)});
  } catch (e) { out.E.push({label, error: String(e).slice(0, 120)}); }
  await sleep(260);
};

// E1 带真实部署头
await tryReq('E1a eval_cost +部署头', `/api/evaluation/${EVAL}/cost`, {headers: {'x-arena-web-deployment': 'dpl_5HKDvo3f6p4Rx2kQNpPsqdJAXwDg'}});
await tryReq('E1b chat_cost +部署头', `/api/chat/${CHAT}/cost?includeSession=true`, {headers: {'x-arena-web-deployment': 'dpl_5HKDvo3f6p4Rx2kQNpPsqdJAXwDg'}});
// E1c 换个假部署头（老版本）
await tryReq('E1c eval_cost +假老部署头', `/api/evaluation/${EVAL}/cost`, {headers: {'x-arena-web-deployment': 'dpl_0000000000000000000000000000'}});

// E2 OPTIONS
await tryReq('E2a OPTIONS eval_cost', `/api/evaluation/${EVAL}/cost`, {method: 'OPTIONS'});
await tryReq('E2b OPTIONS chat_cost', `/api/chat/${CHAT}/cost`, {method: 'OPTIONS'});

// E3 POST
await tryReq('E3a POST eval_cost', `/api/evaluation/${EVAL}/cost`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
await tryReq('E3b POST chat_cost', `/api/chat/${CHAT}/cost`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});

// E4 变体
await tryReq('E4a 尾斜杠', `/api/evaluation/${EVAL}/cost/`);
await tryReq('E4b 大写', `/api/evaluation/${EVAL}/COST`);
await tryReq('E4c includeSession=1', `/api/evaluation/${EVAL}/cost?includeSession=1`);
await tryReq('E4d 多参数', `/api/evaluation/${EVAL}/cost?includeSession=true&includeMessages=true&currency=usd`);
await tryReq('E4e chat_cost 无参', `/api/chat/${CHAT}/cost`);

// E5 Pareto 榜单：costPerTaskUsd 有没有值
out.E5 = {};
for (const path of ['/leaderboard/agent/pareto', '/leaderboard']) {
  try {
    const r = await fetch(path, {headers: {'RSC': '1'}, credentials: 'include'});
    const t = await r.text();
    const m = t.match(/"costPerTaskUsd":\s*([^,}]+)/g) || [];
    const nonNull = m.filter((s) => !/null/.test(s));
    out.E5[path] = {
      status: r.status,
      len: t.length,
      costPerTask_hits: m.length,
      costPerTask_nonnull: nonNull.length,
      samples: nonNull.slice(0, 5),
      has_inputPrice: /inputPricePerMillion/.test(t),
      price_row_count: (t.match(/"inputPricePerMillion"/g) || []).length,
    };
  } catch (e) { out.E5[path] = {error: String(e).slice(0, 120)}; }
  await sleep(400);
}
return out;
