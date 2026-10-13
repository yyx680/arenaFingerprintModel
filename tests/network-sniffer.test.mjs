/* network-sniffer.js 集成测试（v2.13.2）。
 *
 * 嗅探器是 MAIN world 的经典脚本（IIFE，不能 import），所以这里用 vm 沙箱把它跑起来，
 * 给它一套最小的浏览器 shim（window / fetch / XMLHttpRequest / location / performance），
 * 然后驱动 window.fetch 走真实代码路径，断言它通过 window.postMessage 吐出的证据。
 *
 * 重点覆盖两件容易回归的事：
 *   1. 结构化解析的**触发判据** —— fetch 响应的 where 是 'fetch.body' / 'fetch.stream'，
 *      旧写法 `/response|eventsource/` 永远不匹配，导致 scanCostRoute / scanMessageUsage 从不触发。
 *   2. 逐条用量抽取 —— GET /api/evaluation/<sid> 的 messages[].metadata.usage → kind:'message-usage'。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import vm from 'node:vm';

const SNIFFER = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../network-sniffer.js'), 'utf8');

/** 起一个沙箱，把 network-sniffer.js 装进去，返回可控的 window 与捕获到的 postMessage 负载。 */
function bootSniffer({responseText = '', status = 200, contentType = 'application/json'} = {}) {
  const posted = [];
  const timers = [];
  const window = {
    fetch: null, // 下面赋一个 native stub，脚本会包成 patchedFetch
    addEventListener() {},
    removeEventListener() {},
    postMessage(payload) { posted.push(payload); },
    location: {origin: 'https://arena.ai', href: 'https://arena.ai/'},
  };
  const sandbox = {
    window,
    location: window.location,
    performance: {now: () => 0},
    // 定时器改为手动 flush —— schedule() 用 setTimeout(…, 1500) 才 post()，测试里不想真等。
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    URLSearchParams,
    URL,
    TextDecoder,
    // 注入外层 Promise：native fetch stub 返回的是**外层 realm** 的 Promise，
    // 若沙箱里用的是 vm 自己的 Promise，`result instanceof Promise` 会因跨 realm 判假，
    // patchedFetch 会直接 return result、跳过整段响应处理（克隆/扫描/403 门）。
    Promise,
    XMLHttpRequest: function XMLHttpRequest() {},
  };
  sandbox.XMLHttpRequest.prototype.open = function open() {};
  sandbox.XMLHttpRequest.prototype.send = function send() {};
  sandbox.XMLHttpRequest.prototype.addEventListener = function addEventListener() {};
  sandbox.globalThis = sandbox;
  // native fetch：脚本会 `const nativeFetch = window.fetch` 再包装；返回一个可控 Response 仿件。
  window.fetch = async () => ({
    status,
    headers: {get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null)},
    clone: () => ({text: async () => responseText, body: null}),
  });
  vm.runInNewContext(SNIFFER, sandbox, {filename: 'network-sniffer.js'});
  const flush = () => { for (const fn of timers.splice(0, timers.length)) fn(); };
  return {window, posted, flush};
}

const usageBody = JSON.stringify({
  messages: [
    {id: '01a1b2c3d4e5f6', role: 'assistant', participantPosition: 'a', modelId: 'gpt-6-astra',
      metadata: {usage: {inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800, cacheWriteTokens: 100}}},
    {id: '01a1b2c3d4e5f7', role: 'assistant', participantPosition: 'b', modelId: 'claude-sonnet-5',
      metadata: {usage: {inputTokens: 900, outputTokens: 120}}},
  ],
});

const messageUsageOf = (posted) => posted
  .flatMap((payload) => payload.evidence || [])
  .filter((item) => item.kind === 'message-usage');

test('fetch 响应体（where=fetch.body）会触发逐条用量抽取', async () => {
  const {window, posted, flush} = bootSniffer({responseText: usageBody});
  await window.fetch('https://arena.ai/api/evaluation/abc123');
  flush();
  const rows = messageUsageOf(posted);
  assert.equal(rows.length, 2, '两条 assistant 消息都应抽出用量');
  assert.equal(rows[0].message_id, '01a1b2c3d4e5f6');
  assert.equal(rows[0].model_id, 'gpt-6-astra');
  assert.equal(rows[0].position, 'a');
  assert.equal(rows[0].usage.inputTokens, 1200);
  assert.equal(rows[0].usage.outputTokens, 340);
  assert.equal(rows[0].usage.cacheReadTokens, 800);
});

test('fetch 请求体（where=fetch.request）不会触发结构化用量抽取', async () => {
  // 响应体留空，只让请求体带 messages —— 若触发判据写错（依赖 where 含 response），这里会误触发。
  const {window, posted, flush} = bootSniffer({responseText: ''});
  await window.fetch('https://arena.ai/api/evaluation/abc123', {body: usageBody});
  flush();
  assert.equal(messageUsageOf(posted).length, 0, '请求方向不应产生 message-usage 证据');
});

test('/cost 路由 403 会上报一次灰度门（cost-gate）', async () => {
  const {window, posted, flush} = bootSniffer({responseText: '', status: 403});
  await window.fetch('https://arena.ai/api/chat/xyz789/cost');
  flush();
  const gates = posted.flatMap((payload) => payload.evidence || []).filter((item) => item.kind === 'cost-gate');
  assert.equal(gates.length, 1);
  assert.equal(gates[0].status, 403);
});

test('同一份用量重复到达只记一次（messageUsageSeen 去重）', async () => {
  const {window, posted, flush} = bootSniffer({responseText: usageBody});
  await window.fetch('https://arena.ai/api/evaluation/abc123');
  await window.fetch('https://arena.ai/api/evaluation/abc123');
  flush();
  assert.equal(messageUsageOf(posted).length, 2, '重复轮询同一会话不应重复计数');
});
