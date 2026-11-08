/* 单价通道的自查工具：把指纹库 id 映射到 Arena 公开单价表，并演示「按价格反推」。

   用法（在仓库根目录）：
     node tools/pricing-map.mjs
     node tools/pricing-map.mjs --usage "in=6,out=4142,cacheW=11143" --candidates gpt-6-astra,claude-opus-5-5

   它只读两个随包文件（arena-pricing-table.json / modeltrace-bank.json），不联网、不写盘。
   用途：Arena 改版后确认映射是否还成立（库里模型若变成「无价」，就该重新抓一次单价表）。 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {
  normalizePricingTable, bankPricing, discrimination, rankByObservedCost,
  expectedCostUsd, pricingSummary,
} from '../pricing-channel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));

function parseArgs(argv) {
  const out = {usage: null, candidates: null};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--usage') out.usage = argv[i + 1];
    else if (argv[i] === '--candidates') out.candidates = argv[i + 1];
  }
  return out;
}

/** `in=6,out=4142,cacheW=11143` → usage-channel 的 camelCase 形状。 */
function parseUsage(text) {
  if (!text) return null;
  const map = {in: 'inputTokens', out: 'outputTokens', cacheR: 'cacheReadTokens', cacheW: 'cacheWriteTokens', rz: 'reasoningTokens', total: 'totalTokens'};
  const usage = {};
  for (const part of text.split(',')) {
    const [rawKey, rawValue] = part.split('=');
    const key = map[String(rawKey || '').trim()];
    const value = Number(rawValue);
    if (key && Number.isFinite(value)) usage[key] = value;
  }
  return Object.keys(usage).length ? usage : null;
}

const table = normalizePricingTable(load('arena-pricing-table.json'));
const bank = load('modeltrace-bank.json');
const ids = (bank.models || bank.entries || []).map((m) => m.id || m.model_id).filter(Boolean);
const args = parseArgs(process.argv.slice(2));

const summary = pricingSummary(table);
console.log('=== 单价表 ===');
console.log(`来源 ${summary.source}`);
console.log(`抓取于 ${summary.fetched_at}`);
console.log(`共 ${summary.models} 行：文本模型 ${summary.text_models}（可参与反推）· 图像/视频 ${summary.media_models}（按张/秒计，已排除）`);
console.log(`单价区间（USD/百万 token）：输入 $${summary.input_range?.[0]} ~ $${summary.input_range?.[1]} · 输出 $${summary.output_range?.[0]} ~ $${summary.output_range?.[1]}`);

console.log('\n=== 指纹库 id → Arena 变体 key ===');
let priced = 0;
for (const id of ids) {
  const p = bankPricing(id, table);
  if (p.priced) priced += 1;
  const detail = p.priced
    ? `${String(p.keys.length).padStart(2)} 档  in[${p.input_range.join('~')}] out[${p.output_range.join('~')}]`
    : '无公开单价（该模型不在榜单计价范围内）';
  console.log(`  ${id.padEnd(24)} ${detail}`);
}
console.log(`→ ${priced}/${ids.length} 个库内模型有公开单价`);
const unpriced = ids.filter((id) => !bankPricing(id, table).priced);
if (unpriced.length) console.log(`  无价：${unpriced.join(', ')}`);

const usage = parseUsage(args.usage) || {inputTokens: 6, outputTokens: 4142, cacheWriteTokens: 11143, totalTokens: 15291};
const candidates = args.candidates
  ? args.candidates.split(',').map((s) => s.trim()).filter(Boolean)
  : ids.filter((id) => bankPricing(id, table).priced).slice(0, 6);

console.log('\n=== 价格区分度 ===');
console.log(`用量 ${JSON.stringify(usage)}${args.usage ? '' : '（示例：2026-10-11 实测 payload）'}`);
const d = discrimination(usage, candidates, table);
if (!d) {
  console.log('候选不足 2 个或无价，无法计算区分度');
} else {
  console.log(`跨度 ${d.span}×  separable=${d.separable}${d.separable ? '（价格可唯一区分）' : '（区间重叠，单靠价格定不了）'}`);
  for (const r of d.rows) {
    console.log(`  ${r.model_key.padEnd(24)} ${String(r.variants).padStart(2)} 档  期望 $${r.min_usd} ~ $${r.max_usd}（中位 $${r.usd}）`);
  }
}

console.log('\n=== 按真实成本反推（演示） ===');
const target = candidates[0];
const targetKey = table.resolve(target)[0];
const observed = expectedCostUsd(usage, table.profile(targetKey)).usd;
console.log(`假设真实成本 = ${target}（${targetKey}）的期望值 $${observed}，看反推能否命中：`);
const ranked = rankByObservedCost(observed, usage, candidates, table);
if (!ranked) console.log('  无法排序（候选无价或用量缺失）');
else for (const r of ranked) console.log(`  ${r.model_key.padEnd(24)} 权重 ${r.weight}  比值 ${r.ratio}  命中变体 ${r.matched_key}`);
console.log('\n注意：真实按次成本需 GET /api/chat/:id/cost（实测按账号灰度，普通账号 403）。');
console.log('无真实成本时，上面「价格区分度」这一节依然有判别价值。');
