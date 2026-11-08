#!/usr/bin/env node
/**
 * tools/sniffer-e2e.mjs — 端到端验证「嗅探器能抓到真实 usage」。
 *
 * 做法：连 CDP → 装一个 postMessage 收集器 → 把 network-sniffer.js 原样注入页面 →
 *       在页面上下文请求一次 /api/evaluation/<sid>（真实响应，带 usage）→
 *       等嗅探器 flush → 读回它捕获到的 kind==='usage' 证据。
 *
 * 用法：node tools/sniffer-e2e.mjs <port> [sid]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate } from './cdp.mjs';

const port = Number(process.argv[2] || 9222);
const sniffer = readFileSync(fileURLToPath(new URL('../network-sniffer.js', import.meta.url)), 'utf8');

const sidExpr = `(() => {
  for (const k of Object.keys(localStorage)) {
    const m = k.match(/ampApiStash:([0-9a-f-]{20,})/i);
    if (m) return m[1];
  }
  return '01a1166f-9c00-71c2-849d-6d5a6d9f612d';
})()`;

const setup = `
window.__ampE2E = [];
window.addEventListener('message', (event) => {
  const data = event && event.data;
  if (data && data.source === 'amp-network-sniffer') window.__ampE2E.push(data);
});
${sniffer}
return {installed: !!globalThis.__ampSnifferInstalled};
`;

const run = async () => {
  const target = (await evaluate({port, urlSub: 'arena.ai', expression: 'return location.origin', timeout: 20000})).value;
  console.log('target:', target);

  const installed = (await evaluate({port, urlSub: 'arena.ai', expression: setup, timeout: 30000})).value;
  console.log('sniffer installed:', JSON.stringify(installed));

  const sid = (await evaluate({port, urlSub: 'arena.ai', expression: sidExpr, timeout: 15000})).value;
  console.log('session:', sid);

  const fetched = (await evaluate({
    port, urlSub: 'arena.ai', timeout: 60000,
    expression: `
      const r = await fetch('/api/evaluation/' + ${JSON.stringify(sid)}, {headers: {accept: 'application/json'}, credentials: 'include'});
      const text = await r.text();
      return {status: r.status, len: text.length, hasUsage: /"usage"\\s*:/.test(text)};
    `,
  })).value;
  console.log('fetched:', JSON.stringify(fetched));

  await new Promise((r) => setTimeout(r, 3500));

  const captured = (await evaluate({
    port, urlSub: 'arena.ai', timeout: 30000,
    expression: `
      const packets = window.__ampE2E || [];
      const evidence = packets.flatMap((p) => p.evidence || []);
      const usage = evidence.filter((e) => e.kind === 'usage');
      const cost = evidence.filter((e) => e.kind === 'cost');
      return {
        packets: packets.length,
        evidenceKinds: [...new Set(evidence.map((e) => e.kind))],
        usageCount: usage.length,
        usage: usage.slice(0, 4),
        costCount: cost.length,
      };
    `,
  })).value;

  console.log('\n=== 嗅探结果 ===');
  console.log(JSON.stringify(captured, null, 2));
  const ok = captured.usageCount > 0;
  console.log(ok ? '\n✅ 嗅探器成功捕获 usage' : '\n❌ 未捕获 usage');
  return ok ? 0 : 1;
};

run().then((code) => process.exit(code)).catch((error) => { console.error('E2E_ERROR:', error?.message || error); process.exit(4); });
