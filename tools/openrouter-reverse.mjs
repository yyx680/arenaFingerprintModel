/* OpenRouter 价目反推工具（v1，2026-10-12）—— 「用 token 用量 + 单价，经 OpenRouter 反推模型」。

   背景与结论（2026-10-12 实测）：
   · Arena 的模型在 OpenRouter 上有**同名条目**（openai/gpt-6-astra、anthropic/claude-fable-5.1、
     meta/muse-spark-1.3、xiaomi/mimo-v2.6-pro、deepseek/deepseek-v4.1-flash …）；
   · 抽查 5 个模型的挂牌价与 Arena 公开单价表**逐分一致**：
       gpt-6-astra $10/$50 · claude-opus-5 $5/$25 · claude-opus-5.5 $4/$20 ·
       gpt-5.6-luna $0.2/$1.2 · deepseek-v4.1-flash $0.3/$1.2；
   · OpenRouter 还补齐了 Arena 表里全为 null 的**缓存读/写价**与**分层价**（overrides，
     min_prompt_tokens 阈值，如 272000）→ 正好补强「按价格反推」。

   用法（仓库根目录）：
     node tools/openrouter-reverse.mjs --refresh                 # 拉取并缓存 OpenRouter 价目
     node tools/openrouter-reverse.mjs                           # 总览 + 已知价对反查演示
     node tools/openrouter-reverse.mjs --price "in=10,out=50"    # 单价对 → 哪些模型（含缓存价/分层价）
     node tools/openrouter-reverse.mjs --usage "in=6,out=4142,cacheW=11143" \
          [--observed 0.346413] [--candidates gpt-6-astra,claude-opus-5-5] [--top 8]
     node tools/openrouter-reverse.mjs --map                     # 指纹库 id → OpenRouter 候选

   匹配数学复用 ../pricing-channel.js（expectedCostUsd / costMatch / CONSISTENT_RATIO）：
     比值 = 实测/期望，z = ln(比值)/ln(1.6)，|z|≤1 相符；权重 = exp(-z²/2)，缓存价缺失 ×0.6 降权。
   OpenRouter 口径：overrides 按「输入侧总量」（in + cacheR + cacheW）选档；
   `:batch`（半价）与 `~xxx-latest`（滚动别名）默认排除，--batch / --alias 可收进。

   缓存：openrouter-models.json = /api/v1/models 原始响应；不联网时直接用它。
   本工具只读本地文件、只在 --refresh 时发一次价目拉取，不发任何模型请求。 */

import {readFileSync, writeFileSync, statSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';
import {expectedCostUsd, costMatch, CONSISTENT_RATIO} from '../pricing-channel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'openrouter-models.json');
const API = 'https://openrouter.ai/api/v1/models';
const UA = 'modeltrace-openrouter-reverse/1.0';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const mtok = (v) => Math.round(num(v) * 1e6 * 1e6) / 1e6; // 美元/token 字符串 → 美元/Mtok（6 位内）
const fmtUsd = (v) => `$${Number(Number(v).toFixed(6))}`;
const fmtRate = (v) => (v == null ? '—' : `$${Number(Number(v).toFixed(6))}`);

function parseArgs(argv) {
  const out = {refresh: false, price: null, usage: null, observed: null, candidates: null, map: false, top: 8, batch: false, alias: false, tol: 0.005};
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--refresh') out.refresh = true;
    else if (t === '--price') out.price = argv[++i];
    else if (t === '--usage') out.usage = argv[++i];
    else if (t === '--observed') out.observed = Number(argv[++i]);
    else if (t === '--candidates') out.candidates = argv[++i];
    else if (t === '--map') out.map = true;
    else if (t === '--batch') out.batch = true;
    else if (t === '--alias') out.alias = true;
    else if (t === '--top') out.top = Math.max(1, Number(argv[++i]) || 8);
    else if (t === '--tol') out.tol = Math.max(0, Number(argv[++i]) || 0);
  }
  return out;
}

/** `in=6,out=4142,cacheR=..,cacheW=..,rz=..` → usage-channel 的 camelCase 形状。 */
function parseUsage(text) {
  if (!text) return null;
  const map = {in: 'inputTokens', out: 'outputTokens', cacheR: 'cacheReadTokens', cacheW: 'cacheWriteTokens', rz: 'reasoningTokens', total: 'totalTokens'};
  const usage = {};
  for (const part of String(text).split(',')) {
    const [rawKey, rawValue] = part.split('=');
    const key = map[String(rawKey || '').trim()];
    const value = Number(rawValue);
    if (key && Number.isFinite(value)) usage[key] = value;
  }
  return Object.keys(usage).length ? usage : null;
}

/** OpenRouter id → 基础名（去 provider 前缀 / :variant 后缀 / ~ 前缀）。 */
function orBase(id) {
  let s = String(id).toLowerCase();
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon);
  s = s.replace(/^~/, '');
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  return s;
}

/** 基础名的别名（与 pricing-channel.bankAliases 同思路，方向为 OR→指纹库）：
 *  末两位数字的 `-`/`.` 互转（claude-opus-5.5 ↔ claude-opus-5-5）。 */
function orBaseAliases(base) {
  const hyph = base.replace(/(\d)\.(\d)$/, '$1-$2');
  const dotted = base.replace(/(\d)-(\d)$/, '$1.$2');
  return [...new Set([base, hyph, dotted])];
}

/** 前缀命中（与 pricing-channel.aliasMatchLength 同规则）：
 *  边界必须是 `-` 或正好结尾；前缀后第一个 token 若是 1~2 位裸数字则不算命中，
 *  避免 claude-sonnet-5 吞掉 claude-sonnet-5-5-*。 */
function prefixHit(base, alias) {
  if (base === alias) return alias.length;
  if (!base.startsWith(alias + '-')) return 0;
  const first = base.slice(alias.length + 1).split('-')[0];
  return /^\d{1,2}$/.test(first) ? 0 : alias.length;
}

async function loadCatalog(refresh) {
  if (!refresh) {
    try {
      const raw = JSON.parse(readFileSync(CACHE, 'utf8'));
      const mtime = statSync(CACHE).mtime.toISOString();
      return {raw, from: `cache(${CACHE.split(/[\\/]/).pop()}, ${mtime})`};
    } catch { /* 无缓存 → 拉取 */ }
  }
  const res = await fetch(API, {headers: {'User-Agent': UA}});
  if (!res.ok) throw new Error(`OpenRouter /api/v1/models HTTP ${res.status}`);
  const raw = await res.json();
  writeFileSync(CACHE, JSON.stringify(raw));
  return {raw, from: 'fetch'};
}

/** 原始响应 → 行（只保留输入/输出都是正价的文本模型；媒体/免费行排除）。 */
function normalize(raw) {
  const rows = [];
  let skippedMedia = 0;
  for (const m of raw?.data || []) {
    const id = String(m?.id || '');
    if (!id) continue;
    const p = m.pricing || {};
    const input = mtok(p.prompt);
    const output = mtok(p.completion);
    if (!(input > 0 && output > 0)) { skippedMedia += 1; continue; }
    const base = orBase(id);
    const tiers = (Array.isArray(p.overrides) ? p.overrides : []).map((o) => ({
      min_prompt_tokens: num(o.min_prompt_tokens),
      input_usd_per_mtok: mtok(o.prompt) || input,
      output_usd_per_mtok: mtok(o.completion) || output,
      cache_read_usd_per_mtok: o.input_cache_read != null ? mtok(o.input_cache_read) : (p.input_cache_read != null ? mtok(p.input_cache_read) : null),
      cache_write_usd_per_mtok: o.input_cache_write != null ? mtok(o.input_cache_write) : (p.input_cache_write != null ? mtok(p.input_cache_write) : null),
    })).filter((t) => t.min_prompt_tokens > 0).sort((a, b) => a.min_prompt_tokens - b.min_prompt_tokens);
    rows.push({
      model_id: id,
      display: m.name || id,
      org: id.includes('/') ? id.split('/')[0] : null,
      base,
      aliases: orBaseAliases(base),
      batch: /:batch$/.test(id),
      rolling: /^~/.test(id) || /-latest$/.test(id),
      input_usd_per_mtok: input,
      output_usd_per_mtok: output,
      cache_read_usd_per_mtok: p.input_cache_read != null ? mtok(p.input_cache_read) : null,
      cache_write_usd_per_mtok: p.input_cache_write != null ? mtok(p.input_cache_write) : null,
      context: num(m.context_length) || null,
      tiers,
    });
  }
  return {rows, skippedMedia};
}

/** OpenRouter 行 → pricing-channel 的单价档案形状（按用量选分层档）。 */
function profileOf(row, usage) {
  const inputSide = num(usage?.inputTokens) + num(usage?.cacheReadTokens) + num(usage?.cacheWriteTokens);
  let tier = null;
  for (const t of row.tiers) if (inputSide >= t.min_prompt_tokens) tier = t;
  const pick = (a, b) => (a != null ? a : b);
  return {
    model_key: row.model_id,
    display: row.display,
    org: row.org,
    kind: 'text',
    input_usd_per_mtok: pick(tier?.input_usd_per_mtok, row.input_usd_per_mtok),
    output_usd_per_mtok: pick(tier?.output_usd_per_mtok, row.output_usd_per_mtok),
    cache_read_usd_per_mtok: pick(tier?.cache_read_usd_per_mtok, row.cache_read_usd_per_mtok),
    cache_write_usd_per_mtok: pick(tier?.cache_write_usd_per_mtok, row.cache_write_usd_per_mtok),
    tier_applied: tier?.min_prompt_tokens || null,
  };
}

function defaultFilter(args) {
  return (row) => (args.batch || !row.batch) && (args.alias || !row.rolling);
}

/** 用「实测成本 + 本次用量」给 OpenRouter 全表排序（与 pricing-channel.rankByObservedCost 同核）。 */
function rankByObservedCost(observedUsd, usage, rows, args, limit) {
  if (!(Number.isFinite(observedUsd) && observedUsd > 0) || !usage) return null;
  const keep = defaultFilter(args);
  const scored = [];
  for (const row of rows) {
    if (!keep(row)) continue;
    const profile = profileOf(row, usage);
    const match = costMatch(observedUsd, usage, profile);
    if (!match.applicable) continue;
    const z = Math.log(match.ratio) / Math.log(CONSISTENT_RATIO);
    const weight = Math.exp(-0.5 * z * z) * (match.complete ? 1 : 0.6) * (row.batch ? 0.5 : 1);
    scored.push({row, profile, match, weight});
  }
  if (!scored.length) return null;
  const total = scored.reduce((s, i) => s + i.weight, 0);
  for (const i of scored) i.share = total > 0 ? Number((i.weight / total).toFixed(4)) : 0;
  scored.sort((a, b) => b.weight - a.weight || Math.abs(Math.log(a.match.ratio)) - Math.abs(Math.log(b.match.ratio)));
  return scored.slice(0, Math.max(1, limit));
}

/** 区分度：候选（基础名或 OR id）在该用量下的期望成本区间；区间两两不重叠才叫 separable。 */
function discrimination(usage, rows, candidates, args) {
  const keep = defaultFilter(args);
  const values = [];
  for (const cand of candidates) {
    const aliases = orBaseAliases(orBase(cand));
    const hits = rows.filter((row) => keep(row) && Math.max(...aliases.map((a) => prefixHit(row.base, a))) > 0);
    if (!hits.length) continue;
    const usds = [];
    for (const row of hits) {
      const profile = profileOf(row, usage);
      const u = expectedCostUsd(usage, profile);
      if (u && u.usd > 0) usds.push(u.usd);
    }
    if (!usds.length) continue;
    values.push({
      cand,
      variants: hits.length,
      usd: Number((usds.reduce((a, b) => a + b, 0) / usds.length).toFixed(6)),
      min_usd: Math.min(...usds),
      max_usd: Math.max(...usds),
    });
  }
  if (values.length < 2) return null;
  values.sort((a, b) => a.min_usd - b.min_usd);
  let separable = true;
  for (let i = 1; i < values.length; i += 1) if (values[i].min_usd <= values[i - 1].max_usd) { separable = false; break; }
  const span = Number((values[values.length - 1].max_usd / values[0].min_usd).toFixed(2));
  return {span, separable, rows: values};
}

/** 单价对 → OR 模型（相对容差 tol）。 */
function findByPrices(inputUsd, outputUsd, rows, args) {
  const keep = defaultFilter(args);
  const near = (a, b) => (b > 0 ? Math.abs(a - b) / b <= args.tol : a === b);
  return rows.filter((row) => keep(row) && near(row.input_usd_per_mtok, inputUsd) && near(row.output_usd_per_mtok, outputUsd));
}

/** 指纹库 id → OpenRouter 候选（最长前缀优先，方向与 pricing-channel.resolve 相反）。 */
function bankToOpenRouter(rows, bankIds, args) {
  const keep = defaultFilter(args);
  const out = [];
  for (const id of bankIds) {
    const aliases = orBaseAliases(String(id).toLowerCase());
    const usable = rows.filter(keep);
    const exact = usable.filter((row) => aliases.includes(row.base));
    if (exact.length) { out.push({id, hits: exact}); continue; }
    const scored = [];
    for (const row of usable) {
      const len = Math.max(...aliases.map((a) => prefixHit(row.base, a)));
      if (len) scored.push({row, len});
    }
    if (!scored.length) { out.push({id, hits: []}); continue; }
    const best = Math.max(...scored.map((s) => s.len));
    out.push({id, hits: scored.filter((s) => s.len === best).map((s) => s.row)});
  }
  return out;
}

function priceLine(row) {
  const r = fmtRate;
  const parts = [`in ${r(row.input_usd_per_mtok)} out ${r(row.output_usd_per_mtok)}`];
  if (row.cache_read_usd_per_mtok != null) parts.push(`cacheR ${r(row.cache_read_usd_per_mtok)}`);
  if (row.cache_write_usd_per_mtok != null) parts.push(`cacheW ${r(row.cache_write_usd_per_mtok)}`);
  if (row.tiers.length) parts.push(`tiers[${row.tiers.map((t) => `≥${t.min_prompt_tokens}:${r(t.input_usd_per_mtok)}/${r(t.output_usd_per_mtok)}`).join(' ')}]`);
  if (row.batch) parts.push('batch(半价)');
  if (row.rolling) parts.push('rolling-alias');
  return parts.join(' · ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const {raw, from} = await loadCatalog(args.refresh);
  const {rows, skippedMedia} = normalize(raw);
  const text = rows.filter((r) => !r.batch && !r.rolling);
  console.log('=== OpenRouter 价目 ===');
  console.log(`来源 ${from} · 模型 ${rows.length + skippedMedia} 行（文本 ${rows.length} · 媒体/免费 ${skippedMedia} 被排除）`);
  console.log(`非 batch/alias 文本模型 ${text.length} 个 · batch ${rows.filter((r) => r.batch).length} · rolling ${rows.filter((r) => r.rolling).length}`);
  const pairs = new Map();
  for (const r of text) {
    const k = `${r.input_usd_per_mtok}/${r.output_usd_per_mtok}`;
    if (!pairs.has(k)) pairs.set(k, []);
    pairs.get(k).push(r.base);
  }
  console.log(`不同价对 ${pairs.size} 个；有重名的价对 ${[...pairs.values()].filter((v) => v.length > 1).length} 个（价格只能定到簇，簇内要靠 token/缓存用量切开）`);

  if (args.price) {
    const m = /in=([\d.]+)\s*,?\s*out=([\d.]+)/.exec(String(args.price).replace(/\s+/g, ' '));
    if (!m) { console.error('--price 需要形如 "in=10,out=50"'); return 2; }
    const input = Number(m[1]); const output = Number(m[2]);
    console.log(`\n=== 单价对反查：in $${input} / out $${output} （相对容差 ${(args.tol * 100).toFixed(1)}%）===`);
    const hits = findByPrices(input, output, rows, args);
    if (!hits.length) console.log('  无命中');
    for (const row of hits) console.log(`  ${row.model_id.padEnd(34)} ${priceLine(row)}`);
    return 0;
  }

  if (args.usage) {
    const usage = parseUsage(args.usage);
    if (!usage) { console.error('--usage 需要形如 "in=6,out=4142,cacheW=11143"'); return 2; }
    console.log(`\n=== 本次用量 ${JSON.stringify(usage)} ===`);
    if (Number.isFinite(args.observed) && args.observed > 0) {
      console.log(`\n=== 按实测成本反推（实测 $${args.observed}） ===`);
      const ranked = rankByObservedCost(args.observed, usage, rows, args, args.top);
      if (!ranked) console.log('  无法排序（没有可用行或用量缺失）');
      else for (const item of ranked) {
        const t = item.profile.tier_applied ? ` 分层≥${item.profile.tier_applied}` : '';
        console.log(`  ${String(item.match.ratio).padEnd(10)} 权重 ${String(item.share).padEnd(7)} ${item.row.model_id.padEnd(30)} 期望 $${item.match.expected_usd}${t}${item.match.complete ? '' : '（有 token 未计价∈下界）'}`);
      }
    } else {
      console.log('（未给 --observed，改看候选区分度；给 --observed <USD> 可排序）');
    }
    if (args.candidates) {
      const cands = String(args.candidates).split(',').map((s) => s.trim()).filter(Boolean);
      console.log(`\n=== 区分度（候选 ${cands.length} 个） ===`);
      const d = discrimination(usage, rows, cands, args);
      if (!d) console.log('  候选不足 2 个或全部无价');
      else {
        console.log(`跨度 ${d.span}×  separable=${d.separable}${d.separable ? '（价格可唯一区分）' : '（区间重叠，单靠价格定不了）'}`);
        for (const row of d.rows) console.log(`  ${row.cand.padEnd(24)} ${String(row.variants).padStart(2)} 候选  期望 ${fmtUsd(row.min_usd)} ~ ${fmtUsd(row.max_usd)}（中位 ${fmtUsd(row.usd)}）`);
      }
    }
    return 0;
  }

  if (args.map) {
    let bank = null;
    try { bank = JSON.parse(readFileSync(join(ROOT, 'modeltrace-bank.json'), 'utf8')); } catch { /* 可选 */ }
    const ids = bank ? [...new Set((bank.models || bank.entries || []).map((m) => m.id || m.model_id).filter(Boolean))] : [];
    if (!ids.length) { console.log('\n=== 指纹库映射 ===\n  找不到 modeltrace-bank.json 或其中没有 id'); return 1; }
    console.log(`\n=== 指纹库 id → OpenRouter 候选（${ids.length} 个） ===`);
    let covered = 0;
    for (const {id, hits} of bankToOpenRouter(rows, ids, args)) {
      if (hits.length) covered += 1;
      console.log(`  ${id.padEnd(24)} ${hits.length ? hits.map((r) => `${r.model_id}（${r.input_usd_per_mtok}/${r.output_usd_per_mtok}）`).join(' · ') : '无同名候选（可能未收录/改名）'}`);
    }
    console.log(`→ ${covered}/${ids.length} 个库内模型在 OpenRouter 有同名候选`);
    return 0;
  }

  console.log('\n=== 已知价对反查（演示） ===');
  for (const [input, output] of [[10, 50], [5, 25], [4, 20], [0.2, 1.2], [0.3, 1.2]]) {
    const hits = findByPrices(input, output, rows, {tol: args.tol, batch: false, alias: false});
    console.log(`  in $${input} / out $${output}: ${hits.length ? hits.map((r) => r.model_id).join('、') : '无命中'}`);
  }
  console.log('\n提示：--price / --usage [--observed] / --map 三种用法见文件头注释。');
  return 0;
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error('异常：' + (error?.message || error));
    process.exit(1);
  });
}
