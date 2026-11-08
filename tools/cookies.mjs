/* 只读：把浏览器里 arena 相关 cookie 写到 _ck.json（本机自用，用于对照 /cost）。
   用法: node tools/cookies.mjs [9222] [urlSub] */
import {writeFileSync} from 'node:fs';
const PORT = Number(process.argv[2] || 9222);
const SUB = process.argv[3] || 'canary.arena.ai/agent';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = list.find((t) => t.type === 'page' && String(t.url || '').includes(SUB));
if (!tab) { console.error('no matching tab'); process.exit(1); }
const pending = new Map();
let id = 0;
const ws = new WebSocket(tab.webSocketDebuggerUrl);
const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, {res, rej}); ws.send(JSON.stringify({id: n, method, params})); });
ws.onmessage = (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send('Network.enable');
const got = await send('Network.getCookies', {urls: ['https://canary.arena.ai/', 'https://canaryarena.ai/', 'https://arena.ai/']});
const cookies = (got.cookies || []).map((c) => ({name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure}));
const byDomain = {};
for (const c of cookies) {
  const key = String(c.domain);
  (byDomain[key] = byDomain[key] || []).push({name: c.name, len: String(c.value || '').length, httpOnly: c.httpOnly});
}
writeFileSync('_ck.json', JSON.stringify({tab: tab.url, cookies}, null, 1), 'utf8');
console.log(JSON.stringify({count: cookies.length, byDomain}, null, 2));
ws.close();
process.exit(0);
