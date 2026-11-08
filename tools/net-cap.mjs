/* 只读抓包：看页面自身对 /api/ 的请求带了哪些头（用于对照 /cost 的 403）。
   用法: node tools/net-cap.mjs [9222] [urlSub] */
const PORT = Number(process.argv[2] || 9222);
const SUB = process.argv[3] || 'canary.arena.ai/agent';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find((t) => t.type === 'page' && String(t.url || '').includes(SUB));
if (!tab) { console.error('no matching tab'); process.exit(1); }
const pending = new Map();
let id = 0;
const hits = [];
const ws = new WebSocket(tab.webSocketDebuggerUrl);
const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, {res, rej}); ws.send(JSON.stringify({id: n, method, params})); });
ws.onmessage = (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    let u; try { u = new URL(r.url); } catch { u = null; }
    if (u && u.hostname.endsWith('arena.ai') && (/^\/api\//.test(u.pathname) || /^\/nextjs-api\//.test(u.pathname) || u.search.includes('_rsc') || u.pathname.endsWith('/cost'))) {
      hits.push({url: r.url.slice(0, 200), method: r.method, headers: r.headers});
    }
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send('Network.enable');
await send('Page.enable');
await send('Page.reload', {ignoreCache: false});
await new Promise((r) => setTimeout(r, 15000));
const seen = new Set();
const out = [];
for (const h of hits) {
  const key = h.url.replace(/\?.*$/, '') + '|' + h.method;
  if (seen.has(key)) continue;
  seen.add(key);
  out.push(h);
}
console.log(JSON.stringify({tab: tab.url, count: out.length, requests: out.slice(0, 12)}, null, 2));
ws.close();
process.exit(0);
