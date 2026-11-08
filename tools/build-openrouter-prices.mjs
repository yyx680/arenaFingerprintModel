#!/usr/bin/env node
/* 把 OpenRouter 公开价目里的**模型本体**（in / out / cache 读写）导出成补充表。

   为什么要这个脚本（v2.19.6）：
   我们原有的价格通道只在 **Arena 榜单的 208 行** + **指纹库的 21 个模型**里找候选。
   但 Arena 榜单并不包含所有实际可用的模型 —— 实测用户那条会话的账单只能被
   `deepseek/deepseek-v4-flash-vision-exp` 解释（out $0.6468 / cache read $0.00686
   → 反推输出 20 tok、缓存读 8192 tok，与参考扩展 cost-browser-extension 的数字逐项吻合），
   而这个模型**既不在 Arena 榜单，也不在指纹库**里。
   参考扩展的做法是「完整官方价格未匹配，使用公开价格补充」—— 本脚本补上这一环。

   与 tools/build-cache-rates.mjs 的分工：
   · build-cache-rates    —— 给**已有的 Arena 行**补 cache 费率（只补不覆盖）；
   · build-openrouter-prices —— 把 Arena 榜单**没有的**模型整行加进来（Arena 已有的绝不覆盖）。

   消歧策略（宁缺毋滥）：
     1. 排除 `:batch`（半价档）与 `~`（滚动 latest 别名）—— 口径与 Arena 不可比；
     2. 只收 prompt / completion **都为正数**的模型（计价单位才是「每 Mtok」；
        两者为 0 的免费档会让整数反推恒成立，必须剔除）；
     3. 保留 OpenRouter 原始 id 作为 model_key（不与 Arena 的变体 key 冲突）。

   产出：openrouter-prices.json —— 独立补充表，**不改动 arena-pricing-table.json**。

   用法：
     node tools/build-openrouter-prices.mjs            # 用本地 openrouter-models.json 构建
     node tools/build-openrouter-prices.mjs --report   # 只打印统计，不写文件
     node tools/build-openrouter-prices.mjs --refresh  # 先重新拉一次 OpenRouter 价目

   本脚本只读本地文件、只在 --refresh 时发一次价目拉取，不发任何模型请求。 */

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OR_CACHE = join(ROOT, 'openrouter-models.json');
const OUT = join(ROOT, 'openrouter-prices.json');
const API = 'https://openrouter.ai/api/v1/models';
const UA = 'arena-model-probe-openrouter-prices/1.0';

const args = process.argv.slice(2);
const REPORT_ONLY = args.includes('--report');
const REFRESH = args.includes('--refresh');

/** $/token → $/Mtok（保留 6 位有效小数，避免 0.00000000686 这类值被抹平）。 */
function perMtok(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number((n * 1e6).toPrecision(6));
}

async function loadModels() {
  if (REFRESH || !existsSync(OR_CACHE)) {
    console.log(`拉取 ${API} …`);
    const res = await fetch(API, {headers: {'user-agent': UA}});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(OR_CACHE, JSON.stringify(await res.json(), null, 1));
    console.log(`已更新 ${OR_CACHE}`);
  }
  const doc = JSON.parse(readFileSync(OR_CACHE, 'utf8'));
  const list = Array.isArray(doc) ? doc : doc.data;
  if (!Array.isArray(list)) throw new Error('openrouter-models.json 结构无效');
  return list;
}

const models = await loadModels();

const rows = [];
const skipped = {batch: 0, alias: 0, no_price: 0, free: 0, notoken: 0};

for (const model of models) {
  const id = String(model?.id || '');
  if (!id) continue;
  if (id.includes(':batch')) { skipped.batch += 1; continue; }
  if (id.startsWith('~')) { skipped.alias += 1; continue; }

  const pricing = model?.pricing || {};
  const input = perMtok(pricing.prompt);
  const output = perMtok(pricing.completion);
  if (input === null && output === null) { skipped.no_price += 1; continue; }
  /* 两者都为正才算「按 token 计价」；否则（图像/视频、免费档）会污染整数反推。 */
  if (!(input > 0 && output > 0)) { skipped.notoken += 1; continue; }

  rows.push({
    model_key: id,
    display: String(model?.name || id),
    org: id.includes('/') ? id.split('/')[0] : null,
    input_usd_per_mtok: input,
    output_usd_per_mtok: output,
    cache_read_usd_per_mtok: perMtok(pricing.input_cache_read),
    cache_write_usd_per_mtok: perMtok(pricing.input_cache_write),
    source: 'openrouter-public',
  });
}

console.log(`OpenRouter 模型 ${models.length} 个 → 收录 ${rows.length} 行`);
console.log(`  跳过：:batch ${skipped.batch} · ~别名 ${skipped.alias} · 无价 ${skipped.no_price} · 非 token 计价 ${skipped.notoken}`);
const withCache = rows.filter((r) => r.cache_read_usd_per_mtok !== null || r.cache_write_usd_per_mtok !== null);
console.log(`  其中带 cache 费率 ${withCache.length} 行`);

if (REPORT_ONLY) process.exit(0);

writeFileSync(OUT, JSON.stringify({
  schema: 'openrouter-prices',
  fetched_at: new Date().toISOString().slice(0, 10),
  source: API,
  source_note: 'Arena 榜单只覆盖它自己上架的模型；本表把 OpenRouter 公开价目里 Arena 没有的模型整行补进来，供价格通道做候选。',
  caveat: '非 Arena 官方口径 —— 实际渠道价、分层价（tiers）、历史价未计入。Arena 榜单已有的 model_key 一律以 Arena 为准，本表不覆盖。',
  unit: 'usd_per_million_tokens',
  rows,
}, null, 1));
console.log(`已写出 ${OUT}（${rows.length} 行）`);
