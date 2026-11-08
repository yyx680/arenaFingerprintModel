#!/usr/bin/env node
/* 用 OpenRouter 公开价目给 Arena 公开单价表补「缓存读 / 缓存写」费率。

   为什么要这个脚本：
   Arena 榜单的 RSC 载荷只发 inputPricePerMillion / outputPricePerMillion，
   cacheReadPricePerMillion / cacheWritePricePerMillion **实测恒为 null**
   （见 background.js:200 注释）。而 /cost 账单里 cacheReadTokensCostUsd 常常是
   金额大头 —— 没有 cache 费率，四项整数反推（参考 cost-browser-extension 的做法）
   直接 0 候选。OpenRouter 公开了这两个字段，且抽查确认其 input/output 挂牌价
   与 Arena 榜单价逐分一致 → 可作为 cache 费率的补充来源。

   消歧策略（缺一不可，宁缺毋滥）：
     1. 名称核心词命中：Arena 的 display / model_key 剥掉 effort 后缀与 harness 后缀，
        与 OpenRouter 的 model id / name 剥壳后比对；
     2. 价格一致：input/output 双向容差内吻合；
     3. 排除 :batch（半价）与 ~别名（滚动 latest）。

   产出：arena-cache-rates.json —— 独立补充表，**不改动 arena-pricing-table.json**。
   表里每条带 source / confidence / or_id，供运行时按需加载、如实标注来源。

   用法：
     node tools/build-cache-rates.mjs            # 用本地 openrouter-models.json 构建
     node tools/build-cache-rates.mjs --report   # 只打印匹配报告，不写文件
     node tools/build-cache-rates.mjs --refresh  # 先重新拉一次 OpenRouter 价目

   本脚本只读本地文件、只在 --refresh 时发一次价目拉取，不发任何模型请求。 */

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OR_CACHE = join(ROOT, 'openrouter-models.json');
const ARENA_TABLE = join(ROOT, 'arena-pricing-table.json');
const OUT = join(ROOT, 'arena-cache-rates.json');
const API = 'https://openrouter.ai/api/v1/models';
const UA = 'arena-model-probe-cache-rates/1.0';

const args = process.argv.slice(2);
const REPORT_ONLY = args.includes('--report');
const REFRESH = args.includes('--refresh');

/* ---------- 文本归一 ---------- */

/** 名字变体展开：给一个「已剥壳」的名字补上末两位数字的 `-`/`.` 互转。 */
function dotDash(s) {
  return [...new Set([s, s.replace(/(\d)\.(\d)$/, '$1-$2'), s.replace(/(\d)-(\d)$/, '$1.$2')])];
}

/** Arena 侧：同时产出「原名」与「剥壳名」两组变体。
 *  为什么要两组：Arena 的 `kimi-k2.6-code` 与 OpenRouter 的 `moonshotai/kimi-k2.6` 是同一模型，
 *  但 `claude-opus-4-6-webdev` 的核心名就是 `claude-opus-4-6`（webdev 是 harness 后缀）。
 *  单靠一套剥壳规则会顾此失彼 —— 两套一起喂给交集判断，谁命中算谁。 */
function arenaCore(...candidates) {
  const out = new Set();
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw) continue;
    let s = raw.toLowerCase();
    s = s.replace(/^[a-z0-9.-]+\//, '');
    s = s.split(':')[0];
    // 变体括号（(Max) / (High) / (codex-harness) …）一律去掉
    s = s.replace(/\([^)]*\)/g, '');
    s = s.replace(/[^a-z0-9.-]/g, '-');
    s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
    for (const v of dotDash(s)) out.add(v);                                 // 原名
    // 剥 harness / effort 后缀后的核心名
    let c = s;
    c = c.replace(/-\d{8}$/, '');                                           // 长日期戳
    c = c.replace(/-(?:max|high|xhigh|agent|public|preview|thinking|vertex|webdev|text|code|codex-harness|code-arena-harness)(?=-|$)/g, '');
    c = c.replace(/-+/g, '-').replace(/^-|-$/g, '');
    for (const v of dotDash(c)) out.add(v);
    // preview 也可能在最末尾（gemini-3-flash-preview → gemini-3-flash）—— 已由上面的 (?=-|$) 覆盖
  }
  return [...out];
}

/** OpenRouter 侧：去 provider 前缀 / :batch / ~ 前缀，产出原名 + 剥壳名。 */
function orCore(...candidates) {
  const out = new Set();
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw) continue;
    let s = raw.toLowerCase();
    s = s.replace(/^~/, '');
    s = s.split(':')[0];
    const slash = s.lastIndexOf('/');
    if (slash >= 0) s = s.slice(slash + 1);
    s = s.replace(/[^a-z0-9.-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    for (const v of dotDash(s)) out.add(v);
    let c = s.replace(/-(?:max|high|xhigh|agent|public|preview|thinking|vertex|webdev|text|code|codex-harness)(?=-|$)/g, '');
    c = c.replace(/-+/g, '-').replace(/^-|-$/g, '');
    for (const v of dotDash(c)) out.add(v);
  }
  return [...out];
}

/* ---------- 加载 ---------- */

function loadOpenRouter() {
  if (!existsSync(OR_CACHE)) throw new Error(`缺少 ${OR_CACHE}：先跑 node tools/openrouter-reverse.mjs --refresh`);
  const raw = JSON.parse(readFileSync(OR_CACHE, 'utf8'));
  const rows = [];
  let media = 0;
  for (const m of raw?.data || []) {
    const id = String(m?.id || '');
    if (!id) continue;
    const p = m.pricing || {};
    const mtok = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e6 * 1e6) / 1e6 : null; };
    const input = mtok(p.prompt);
    const output = mtok(p.completion);
    if (!(input > 0 && output > 0)) { media += 1; continue; }
    const cacheRead = p.input_cache_read != null ? mtok(p.input_cache_read) : null;
    const cacheWrite = p.input_cache_write != null ? mtok(p.input_cache_write) : null;
    rows.push({
      id, name: m.name || id,
      batch: /:batch$/.test(id), rolling: /^~/.test(id) || /-latest$/.test(id),
      input, output, cacheRead, cacheWrite,
      cores: orCore(id, m.name || ''),
    });
  }
  return {rows, media, total: (raw?.data || []).length};
}

/* ---------- 匹配 ---------- */

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** 为一条 Arena 行找 OpenRouter 候选：名称核心词命中 + 价格一致。
 *  batch 条目可以参与匹配（Arena 部分档位恰好与 batch 半价一致），但排序时垫底，
 *  并单独标 kind='batch' —— 来源如实披露，绝不把半价说成标价。 */
function matchRow(arenaRow, orRows) {
  const cores = arenaCore(arenaRow.display, arenaRow.model_key);
  const ai = Number(arenaRow.input_usd_per_mtok);
  const ao = arenaRow.output_usd_per_mtok == null ? -1 : Number(arenaRow.output_usd_per_mtok);
  const hits = [];
  for (const r of orRows) {
    if (r.rolling) continue;
    if (!r.cores.some((c) => cores.includes(c))) continue;
    if (!near(r.input, ai, 0.02)) continue;
    if (ao >= 0 && !near(r.output, ao, 0.05)) continue;
    hits.push(r);
  }
  // 非 batch 优先（同价位下），batch 垫底
  hits.sort((a, b) => Number(a.batch) - Number(b.batch));
  return hits;
}

/* ---------- 主流程 ---------- */

async function refreshOpenRouter() {
  const res = await fetch(API, {headers: {'User-Agent': UA}});
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const raw = await res.json();
  writeFileSync(OR_CACHE, JSON.stringify(raw));
  console.log(`已刷新 ${OR_CACHE}`);
}

if (REFRESH) await refreshOpenRouter();

const {rows: orRows, media, total} = loadOpenRouter();
const arenaTable = JSON.parse(readFileSync(ARENA_TABLE, 'utf8'));
const arenaRows = arenaTable.rows || [];

console.log(`OpenRouter: ${total} 行（文本 ${orRows.length} · 媒体/免费 ${media} 被排除）`);
console.log(`Arena 榜  : ${arenaRows.length} 行\n`);

const matched = [];       // 名称+价格双命中，且补到了至少一项 cache 费率
const dualNoCache = [];   // 双命中但 OpenRouter 也没 cache 费率
const unmatched = [];     // 未命中

for (const a of arenaRows) {
  const hits = matchRow(a, orRows);
  if (!hits.length) { unmatched.push(a); continue; }
  // 多重命中时优先取带 cache 费率的
  const withCache = hits.filter((h) => h.cacheRead != null || h.cacheWrite != null);
  const pool = withCache.length ? withCache : hits;
  // 同池内 cache 费率一致则高置信；不一致则记下分歧
  const crs = [...new Set(pool.map((h) => h.cacheRead))];
  const cws = [...new Set(pool.map((h) => h.cacheWrite))];
  const picked = pool[0];
  if (withCache.length) {
    matched.push({
      model_key: a.model_key,
      display: a.display,
      org: a.org || null,
      input_usd_per_mtok: a.input_usd_per_mtok,
      output_usd_per_mtok: a.output_usd_per_mtok == null ? null : a.output_usd_per_mtok,
      cache_read_usd_per_mtok: picked.cacheRead,
      cache_write_usd_per_mtok: picked.cacheWrite,
      or_id: picked.id,
      or_variants: hits.length,
      or_batch: picked.batch === true,
      cache_consistent: crs.length === 1 && cws.length === 1,
    });
  } else dualNoCache.push({key: a.model_key, or: hits.map((h) => h.id)});
}

console.log(`✅ 补上 cache 费率 : ${matched.length} / ${arenaRows.length}`);
console.log(`   其中同价簇内 cache 一致（高置信）: ${matched.filter((m) => m.cache_consistent).length}`);
console.log(`   其中同价簇内 cache 有分歧（需标注）: ${matched.filter((m) => !m.cache_consistent).length}`);
console.log(`   其中来源为 :batch 半价条目（需标注）: ${matched.filter((m) => m.or_batch).length}`);
console.log(`⚠️  双命中但无 cache 费率: ${dualNoCache.length}`);
console.log(`❌ 未命中（保持 null）  : ${unmatched.length}\n`);

if (process.argv.includes('--verbose')) {
  console.log('=== 未命中清单 ===');
  for (const a of unmatched) console.log(`  ${String(a.display).slice(0, 30).padEnd(32)} ${a.model_key}`);
  console.log('\n=== cache 费率有分歧的（抽 10）===');
  for (const m of matched.filter((x) => !x.cache_consistent).slice(0, 10)) {
    console.log(`  ${m.display} <- ${m.or_id}（${m.or_variants} 个候选）`);
  }
}

if (!REPORT_ONLY) {
  const doc = {
    schema: 'arena-cache-rates',
    fetched_at: new Date().toISOString().slice(0, 10),
    source: 'https://openrouter.ai/api/v1/models',
    source_note: 'Arena 榜单不下发 cache 费率（实测恒 null）。本表用 OpenRouter 公开价目补充缓存读写费率；input/output 挂牌价与 Arena 榜单价逐条校验一致后才录用。',
    method: '名称核心词命中 + input/output 价格双向容差（in ±0.02 / out ±0.05），排除 :batch 与 ~别名',
    caveat: '非 Arena 官方口径。实际渠道价、历史价、单次调用分层（tiers）未计入。未命中项保持 null，绝不外推。',
    matched: matched.length,
    total: arenaRows.length,
    /** model_key → {cache_read_usd_per_mtok, cache_write_usd_per_mtok} */
    rates: Object.fromEntries(matched.map((m) => [m.model_key, {
      cache_read_usd_per_mtok: m.cache_read_usd_per_mtok,
      cache_write_usd_per_mtok: m.cache_write_usd_per_mtok,
      or_id: m.or_id,
      consistent: m.cache_consistent,
      batch: m.or_batch === true,
    }])),
  };
  writeFileSync(OUT, JSON.stringify(doc, null, 1));
  console.log(`已写出 ${OUT}（${matched.length} 条）`);
}
