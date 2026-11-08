// 用侧栏里真实存在的会话 id 去撞 /api/chat/:id/cost 与 /api/evaluation/:id/cost
const out = {at: new Date().toISOString(), href: location.href};

// 1) 收集会话 id：侧栏链接 + RSC + 页面里出现的 uuid
const ids = new Set();
const add = (v) => { if (v && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) ids.add(v); };
for (const a of document.querySelectorAll('a[href]')) {
  const href = a.getAttribute('href') || '';
  const m = href.match(/\/(?:c|agent|chat)\/([0-9a-f-]{20,})/i);
  if (m) add(m[1]);
}
for (const k of Object.keys(localStorage)) add((k.match(/ampApiStash:([0-9a-f-]{20,})/i) || [])[1]);
out.sidebarLinks = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => h && /\/(c|agent|chat)\//.test(h)).slice(0, 12);
out.idsFromDom = [...ids];

// 2) 从首页 RSC 里再捞一批 id
try {
  const r = await fetch('/', {headers: {RSC: '1', accept: 'text/x-component'}, credentials: 'include'});
  const t = await r.text();
  const found = t.match(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
  out.idsFromRsc = [...new Set(found)].slice(0, 12);
  for (const v of found) add(v);
} catch (e) { out.rscErr = e.message; }

const list = [...ids].slice(0, 14);
out.tested = [];

// 3) 逐个撞两个成本接口
for (const id of list) {
  const attempts = [
    ['chat-cost', `/api/chat/${id}/cost?includeSession=true`],
    ['eval-cost', `/api/evaluation/${id}/cost`],
  ];
  for (const [label, url] of attempts) {
    try {
      const r = await fetch(url, {headers: {accept: 'application/json'}, credentials: 'include'});
      const body = await r.text();
      out.tested.push({id: id.slice(0, 13), label, status: r.status, len: body.length, body: body.slice(0, 500)});
    } catch (e) { out.tested.push({id: id.slice(0, 13), label, err: e.message}); }
  }
}

// 4) 汇总：任何 200
out.hits = out.tested.filter((x) => x.status === 200);
out.statusSummary = out.tested.reduce((acc, x) => { const k = `${x.label}:${x.status || 'ERR'}`; acc[k] = (acc[k] || 0) + 1; return acc; }, {});

return out;
