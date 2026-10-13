#!/usr/bin/env node
/* 校验「成本字段表」两份副本是否同步（不需要浏览器、不需要网络）。

   背景：字段表在**两个文件**里各存一份 ——
     · price-channel.js  → COST_FIELD_RE（后台/测试用，可 import）
     · network-sniffer.js → COST_FIELD_RE（MAIN world IIFE，**无法 import**，只能复制）
   一旦只改一边，就等于没改：嗅探器抓不到字段，后台再正确也没用。
   本脚本把两份正则抠出来跑同一份探针 payload，字段名集合不一致就退出码 1。

   用法：
     node tools/check-cost-fields.mjs
     node tools/check-cost-fields.mjs --payload '{"basePriceUsd":1,"costMultiplier":2}' */

import {readFileSync} from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const read = name => readFileSync(new URL(name, ROOT), 'utf8');

/* 从源文件里抠出一个 `const NAME = <regex-literal>;` 行并求值成 RegExp。
   正则字面量本身不含引号/换行，故按行取即可。 */
function extractRegex(source, constName) {
  const line = source.split('\n').find(text => text.trim().startsWith(`const ${constName} =`));
  if (!line) throw new Error(`在源文件里找不到 ${constName}`);
  const literal = line.trim().slice(`const ${constName} =`.length).replace(/;\s*$/, '').trim();
  if (!literal.startsWith('/')) throw new Error(`${constName} 不是正则字面量：${literal.slice(0, 40)}`);
  return eval(literal); // eslint-disable-line no-eval
}

/* 按“字段名”收集命中，忽略大小写（两份正则的 i 标志一致，但书写风格可能不同）。 */
function fieldNames(re, text) {
  const out = new Set();
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text))) out.add(String(match[1]).toLowerCase());
  return out;
}

const args = process.argv.slice(2);
const payloadIndex = args.indexOf('--payload');
const PROBE = payloadIndex >= 0 && args[payloadIndex + 1]
  ? args[payloadIndex + 1]
  /* 默认探针：把 Arena `/cost` 真实响应里出现过的字段名全覆盖一遍
     （抄自 bundle 的 zod schema，见 Arena成本接口实测.md §7）。 */
  : JSON.stringify({
    actualTotalUsd: 1.06317612, chargedTotalUsd: 2.12635223, basePriceUsd: 1.06317612,
    totalCostUsd: 1.06317612, totalChargedUsd: 2.12635223, costPerTaskUsd: 0.07, pricePerImage: 0.04,
    totalCharged: 2.12635223, costMultiplier: 2, marginMultiplier: 2, discountPercent: 0,
    totalChargedCredits: 2126.35223, creditsUsed: 2126.35223,
    inputTokensCostUsd: 1, outputTokensCostUsd: 2, cacheWriteTokensCostUsd: 3, cacheReadTokensCostUsd: 4,
    textOutputTokensCostUsd: 5, imageInputTokensCostUsd: 6, imageOutputTokensCostUsd: 7,
    imageGenerationCostUsd: 8, videoGenerationCostUsd: 9,
    total_tokens: 15291, prompt_tokens: 6, completion_tokens: 4142,
    input_tokens: 6, output_tokens: 4142, cache_read_tokens: 0, cache_write_tokens: 11143,
    reasoning_tokens: 0, inputTokens: 6, outputTokens: 4142,
  });

const tryRegex = (source, name) => { try { return extractRegex(source, name); } catch { return null; } };
const priceRe = extractRegex(read('price-channel.js'), 'COST_FIELD_RE');
const snifferRe = extractRegex(read('network-sniffer.js'), 'COST_FIELD_RE');
/* price-channel.js 的门禁词是 extractCostSignals 里的内联正则（没有具名常量），故用 tryRegex 容错。 */
const priceMarker = tryRegex(read('price-channel.js'), 'COST_MARKER_RE');
const snifferMarker = extractRegex(read('network-sniffer.js'), 'COST_MARKER_RE');

const priceFields = fieldNames(priceRe, PROBE);
const snifferFields = fieldNames(snifferRe, PROBE);

const onlyPrice = [...priceFields].filter(f => !snifferFields.has(f)).sort();
const onlySniffer = [...snifferFields].filter(f => !priceFields.has(f)).sort();

console.log(`price-channel.js  抽出 ${priceFields.size} 个字段`);
console.log(`network-sniffer.js 抽出 ${snifferFields.size} 个字段`);
console.log(`嗅探器门禁词命中探针: ${snifferMarker.test(PROBE) ? '是' : '否 ← 会导致整包被跳过'}`);

let bad = 0;
if (onlyPrice.length) { console.log(`\n❌ 只在 price-channel.js 里（嗅探器会漏）: ${onlyPrice.join(', ')}`); bad = 1; }
if (onlySniffer.length) { console.log(`\n❌ 只在 network-sniffer.js 里（后台会漏）: ${onlySniffer.join(', ')}`); bad = 1; }
if (!snifferMarker.test(PROBE)) bad = 1;
if (priceMarker && !priceMarker.test(PROBE)) { console.log('❌ price-channel.js 的门禁词漏掉探针'); bad = 1; }

/* 单位归类也要一致：两份各有一份 unitOfCostField 副本，比对函数体文本即可。 */
const unitBody = (source) => {
  const at = source.indexOf('function unitOfCostField');
  if (at < 0) return null;
  const end = source.indexOf("return 'other';", at);
  if (end < 0) return null;
  /* 取到 `return 'other'; }` 为止，压掉所有空白差异（缩进两边不同，语义相同）。 */
  return source.slice(at, source.indexOf('}', end) + 1).replace(/\s+/g, ' ').trim();
};
const unitPrice = unitBody(read('price-channel.js'));
const unitSniffer = unitBody(read('network-sniffer.js'));
if (!unitPrice || !unitSniffer) { console.log('❌ 有一边缺 unitOfCostField'); bad = 1; }
else if (unitPrice !== unitSniffer) {
  console.log('❌ 两边的 unitOfCostField 实现不一致：');
  console.log(`   price-channel.js   : ${unitPrice}`);
  console.log(`   network-sniffer.js : ${unitSniffer}`);
  bad = 1;
}

if (bad) {
  console.log('\n两份字段表不同步。改完记得两边一起改（嗅探器是 MAIN world IIFE，不能 import）。');
  process.exit(1);
}
console.log('\n✅ 两份字段表同步，门禁词齐备。');
