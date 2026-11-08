#!/usr/bin/env node
/**
 * tools/arena-net-capture.mjs — 用 CDP Network 域抓「应用自己发的请求」。
 *
 * 为什么需要它：
 *   · 想知道应用有哪些接口（比如 agent chat 列表），靠猜名字很慢 —— 直接看它自己调了什么。
 *   · 想知道应用给请求加了哪些**自定义头**（很多服务端的门就是按某个头判断的）——
 *     自己手写 fetch 不会带这些头，所以之前复现出来的 403 可能不是「同一个请求」。
 *
 * 用法：
 *   node tools/arena-net-capture.mjs <port> <url> [waitMs]
 *   node tools/arena-net-capture.mjs 9222 https://arena.ai/agent 9000
 */
import {listTargets, pickTarget, openTarget} from './cdp.mjs';

const port = Number(process.argv[2] || 9222);
const url = process.argv[3] || 'https://arena.ai/agent';
const waitMs = Number(process.argv[4] || 9000);

class Conn {
  constructor(wsUrl, reqTimeoutMs = 60000) {
    this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.events = []; this.reqTimeout = reqTimeoutMs;
  }
  async open(timeoutMs = 10000) {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws open timeout')), timeoutMs);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error('ws error')); };
    });
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const {res, rej} = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) this.events.push(m);
    };
    ws.onclose = () => { for (const {rej} of this.pending.values()) rej(new Error('ws closed')); this.pending.clear(); };
    return this;
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, {res, rej});
      this.ws.send(JSON.stringify({id, method, params}));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`timeout: ${method}`)); } }, this.reqTimeout);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

// 找一个可用的 arena 页面；没有就新建
let targets = await listTargets(port);
let t = targets.find((x) => x.type === 'page' && /arena\.ai/.test(x.url || ''));
if (!t) { t = await openTarget(port, url); await new Promise((r) => setTimeout(r, 1500)); }

const c = await new Conn(t.webSocketDebuggerUrl, 90000).open();
const reqs = [];
try {
  await c.send('Network.enable');
  await c.send('Page.enable');
  // 同 URL 的 Page.navigate 是空操作（SPA 不重新拉数据）→ 走硬刷新
  if ((t.url || '').split('#')[0] === url.split('#')[0]) {
    await c.send('Page.reload', {ignoreCache: true});
  } else {
    await c.send('Page.navigate', {url});
  }
  await new Promise((r) => setTimeout(r, waitMs));
} finally {
  for (const e of c.events) {
    if (e.method === 'Network.requestWillBeSent') {
      const r = e.params.request;
      if (/\/api\/|\/nextjs-api\/|\/trpc\//.test(r.url)) {
        reqs.push({method: r.method, url: r.url, headers: r.headers, postData: r.postData ? String(r.postData).slice(0, 300) : undefined});
      }
    }
  }
  c.close();
}

// 自定义头 = 去掉浏览器自动加的、以及体积大的
const AUTO = new Set(['accept', 'accept-encoding', 'accept-language', 'cookie', 'referer', 'origin', 'user-agent',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-fetch-user', 'upgrade-insecure-requests', 'connection', 'content-length', 'priority', 'dnt',
  'sec-gpc', 'cache-control', 'pragma', 'content-type', 'rsc', 'next-router-prefetch',
  'next-router-state-tree', 'next-url', 'purpose', 'x-middleware-prefetch']);

console.log(`# 抓到 ${reqs.length} 条 /api|/nextjs-api 请求（页面 ${url}）\n`);
console.log('## 全部请求');
const seen = new Set();
for (const r of reqs) {
  const key = r.method + ' ' + r.url.replace(/[0-9a-f-]{20,}/gi, ':id');
  const tag = seen.has(key) ? ' (重复)' : '';
  seen.add(key);
  console.log(`${r.method.padEnd(5)} ${r.url.slice(0, 150)}${tag}`);
}

console.log('\n## 自定义请求头（非浏览器自动）');
const custom = new Map();
for (const r of reqs) {
  for (const [k, v] of Object.entries(r.headers || {})) {
    if (AUTO.has(k.toLowerCase())) continue;
    const prev = custom.get(k);
    if (!prev) custom.set(k, v);
  }
}
if (!custom.size) console.log('（无：应用没有加任何自定义头）');
for (const [k, v] of custom) console.log(`${k}: ${String(v).slice(0, 160)}`);

console.log('\n## 含 id 的路径（可提取 chat id）');
const ids = new Set();
for (const r of reqs) for (const m of r.url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []) ids.add(m);
console.log([...ids].slice(0, 20).join('\n') || '（无）');
