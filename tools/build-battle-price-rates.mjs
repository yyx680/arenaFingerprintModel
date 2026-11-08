#!/usr/bin/env node
/* 从 arena-battle-price-training.json 生成可安全随扩展加载的精简实测费率表。

   原始训练集含 prompt/response，只用于离线提炼，绝不直接进入运行时包。输出仅保留：
   model_key、稳定费率和样本数。纳入条件（宁缺毋滥）：
   · usage_source 必须是 provider，且排除 agent_p50；
   · tokens/cost 都为正，费率由同消息两者重新计算；
   · 同一模型每个被采用分项的全部正费率必须完全一致（9 位小数）；
   · input/output 两项都必须有稳定实测值，cache 分项可缺失。

   用法：
     node tools/build-battle-price-rates.mjs
     node tools/build-battle-price-rates.mjs --report
*/

import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import '../token-estimator.js';
import {canonicalModelSlug} from '../pricing-channel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = join(ROOT, 'arena-battle-price-training.json');
const OFFICIAL_PRICING = join(ROOT, 'arena-pricing-table.json');
const OPENROUTER_PRICING = join(ROOT, 'openrouter-prices.json');
const OUTPUT = join(ROOT, 'arena-battle-price-rates.json');
const REPORT_ONLY = process.argv.includes('--report');
const BUCKETS = ['input', 'output', 'cache_read', 'cache_write'];
const tokenEstimator = globalThis.ArenaTokenEstimator;

const training = JSON.parse(readFileSync(INPUT, 'utf8'));
if (!training || training.schema !== 'arena-battle-price-training-v1' || !Array.isArray(training.battles)) {
  throw new Error('arena-battle-price-training.json schema 无效');
}
if (training.history_complete !== true) throw new Error('训练集历史扫描不完整，拒绝生成运行时费率表');

let officialRows = [];
try {
  const officialDoc = JSON.parse(readFileSync(OFFICIAL_PRICING, 'utf8'));
  if (Array.isArray(officialDoc?.rows)) officialRows = [...officialDoc.rows];
} catch {}
try {
  const orDoc = JSON.parse(readFileSync(OPENROUTER_PRICING, 'utf8'));
  if (Array.isArray(orDoc?.rows)) officialRows.push(...orDoc.rows);
} catch {}

const roundRate = value => Number(Number(value).toFixed(9));
const fracDigits = value => (String(value).split('.')[1] || '').length;
const median = values => {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const groups = new Map();
const ensure = name => {
  if (!groups.has(name)) groups.set(name, {
    messages: 0,
    modelIds: new Set(),
    providers: new Set(),
    values: Object.fromEntries(BUCKETS.map(bucket => [bucket, []])),
    allOutToVis: [],
    shortOutToVis: [],
    longOutToVis: [],
    veryLongOutToVis: [],
    reasoningTokens: [],
    extraOutTokens: [],
    costOnlySamples: [],
  });
  return groups.get(name);
};

for (const battle of training.battles) {
  for (const turn of battle?.turns || []) {
    for (const candidate of turn?.candidates || []) {
      const name = typeof candidate?.model_name === 'string' ? candidate.model_name.trim() : '';
      const evidence = candidate?.price_evidence;
      const isProvider = evidence?.usage_source === 'provider';
      const isCostOnly = !evidence?.usage_source && evidence?.cost_source !== 'unpriced' && Number(evidence?.actual_total_cost_usd) > 0;
      if (!name || name.length > 160 || !evidence || (!isProvider && !isCostOnly)
        || evidence.cost_source === 'agent_p50') continue;
      const group = ensure(name);
      group.messages += 1;
      if (typeof candidate.model_id === 'string' && candidate.model_id) group.modelIds.add(candidate.model_id);
      if (typeof candidate.model_provider === 'string' && candidate.model_provider) group.providers.add(candidate.model_provider);
      const cacheReadTokens = Number(evidence.components?.cache_read?.tokens ?? candidate.usage?.cacheReadTokens) || 0;
      for (const bucket of BUCKETS) {
        const part = evidence.components?.[bucket];
        const tokens = Number(part?.tokens);
        const cost = Number(part?.cost_usd);
        if (!(Number.isFinite(tokens) && tokens > 0 && Number.isFinite(cost) && cost > 0)) continue;
        let value = roundRate(cost * 1e6 / tokens);
        /* 部分上游（如 xAI / Vertex）的 usage.inputTokens 含 cacheReadTokens，但 input 费用仅对未缓存部分计费。 */
        if (bucket === 'input' && cacheReadTokens > 0 && tokens > cacheReadTokens && fracDigits(value) >= 7) {
          const uncachedRate = roundRate(cost * 1e6 / (tokens - cacheReadTokens));
          if (Number.isFinite(uncachedRate) && uncachedRate > 0 && fracDigits(uncachedRate) <= 6) {
            value = uncachedRate;
          }
        }
        if (Number.isFinite(value) && value > 0) group.values[bucket].push(value);
      }
      const outTokens = Number(evidence.components?.output?.tokens ?? candidate.usage?.outputTokens) || 0;
      if (outTokens > 0 && tokenEstimator && typeof candidate.response === 'string' && candidate.response.length > 0) {
        const charStats = tokenEstimator.count(candidate.response);
        const visTokens = Math.max(1, Number(tokenEstimator.estimate(charStats)?.tokens) || 1);
        const ratio = outTokens / visTokens;
        if (Number.isFinite(ratio) && ratio > 0) {
          group.allOutToVis.push(ratio);
          if (visTokens < 16) group.shortOutToVis.push(ratio);
          else if (visTokens < 500) group.longOutToVis.push(ratio);
          else group.veryLongOutToVis.push(ratio);
          if (visTokens < 500) group.extraOutTokens.push(Math.max(0, outTokens - visTokens));
        }
      } else if (!(outTokens > 0) && Number(evidence.components?.output?.cost_usd) > 0 && tokenEstimator && typeof candidate.response === 'string' && candidate.response.length > 0) {
        const charStats = tokenEstimator.count(candidate.response);
        const visTokens = Math.max(1, Number(tokenEstimator.estimate(charStats)?.tokens) || 1);
        group.costOnlySamples.push({
          inCost: Number(evidence.components?.input?.cost_usd) || 0,
          outCost: Number(evidence.components.output.cost_usd) || 0,
          visTokens,
        });
      }
      const reasTokens = candidate.usage?.reasoningTokens;
      if (typeof reasTokens === 'number' && Number.isFinite(reasTokens) && reasTokens >= 0) {
        group.reasoningTokens.push(reasTokens);
      }
    }
  }
}

const stable = values => {
  const distinct = [...new Set(values.map(value => value.toFixed(9)))];
  return distinct.length === 1 ? Number(distinct[0]) : null;
};
const rows = [];
let missingRequired = 0;
let conflictingRequired = 0;
for (const [modelKey, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  let input = stable(group.values.input);
  let output = stable(group.values.output);
  /* 全量命中缓存的样本（input 费用为 0）已实测稳定 output 与 cache_read 单价时，从同 slug 且同 output 单价的官方行补齐 input 单价。 */
  if (!(input > 0) && !group.values.input.length && output > 0) {
    const slug = canonicalModelSlug(modelKey);
    const matchedOfficial = officialRows.filter(r =>
      r && r.source !== 'openrouter-public' &&
      Number(r.output_usd_per_mtok) === output &&
      Number(r.input_usd_per_mtok) > 0 &&
      (r.model_key === modelKey || canonicalModelSlug(r.display || r.model_key) === slug || canonicalModelSlug(r.model_key) === slug)
    );
    const distinctIn = [...new Set(matchedOfficial.map(r => Number(r.input_usd_per_mtok)))];
    if (distinctIn.length === 1) input = distinctIn[0];
  }
  if (!(input > 0 && output > 0) && !group.values.input.length && !group.values.output.length && group.costOnlySamples.length) {
    const slug = canonicalModelSlug(modelKey);
    const fitsAllSamples = r => {
      if (!r || !(Number(r.input_usd_per_mtok) > 0 && Number(r.output_usd_per_mtok) > 0)) return false;
      const rIn = Number(r.input_usd_per_mtok), rOut = Number(r.output_usd_per_mtok);
      return group.costOnlySamples.every(s => {
        const iTok = s.inCost > 0 ? (s.inCost * 1e6) / rIn : 0;
        const oTok = s.outCost > 0 ? (s.outCost * 1e6) / rOut : 0;
        return Math.abs(iTok - Math.round(iTok)) <= 1e-4
          && Math.abs(oTok - Math.round(oTok)) <= 1e-4
          && (s.visTokens <= 0 || (oTok >= s.visTokens * 0.5 && oTok <= s.visTokens * 8));
      });
    };
    let matchedOfficial = officialRows.filter(r =>
      fitsAllSamples(r) && (r.model_key === modelKey || canonicalModelSlug(r.display || r.model_key) === slug || canonicalModelSlug(r.model_key) === slug)
    );
    if (!matchedOfficial.length && group.costOnlySamples.length >= 2) {
      matchedOfficial = officialRows.filter(fitsAllSamples);
    }
    const distinctPairs = [...new Set(matchedOfficial.map(r => `${Number(r.input_usd_per_mtok)}|${Number(r.output_usd_per_mtok)}`))];
    if (distinctPairs.length === 1) {
      const [rIn, rOut] = distinctPairs[0].split('|').map(Number);
      input = rIn;
      output = rOut;
    }
  }
  if (!(input > 0 && output > 0)) {
    if (!group.values.input.length || !group.values.output.length) missingRequired += 1;
    else conflictingRequired += 1;
    continue;
  }
  for (const sample of group.costOnlySamples) {
    const impliedOut = Math.round(sample.outCost * 1e6 / output);
    if (impliedOut > 0 && sample.visTokens > 0) {
      const ratio = impliedOut / sample.visTokens;
      group.allOutToVis.push(ratio);
      if (sample.visTokens < 16) group.shortOutToVis.push(ratio);
      else if (sample.visTokens < 500) group.longOutToVis.push(ratio);
      else group.veryLongOutToVis.push(ratio);
      if (sample.visTokens < 500) group.extraOutTokens.push(Math.max(0, impliedOut - sample.visTokens));
    }
  }
  const outToVisP50 = median(group.longOutToVis.length ? group.longOutToVis : group.allOutToVis);
  const shortP50 = median(group.shortOutToVis);
  const veryLongP50 = median(group.veryLongOutToVis);
  const extraMed = group.extraOutTokens.length >= 2 ? median(group.extraOutTokens) : null;
  const rawReasP50 = group.reasoningTokens.length
    ? median(group.reasoningTokens)
    : (extraMed !== null ? (extraMed > 12 ? extraMed : 0) : null);
  const reasP50 = rawReasP50 !== null && (group.messages >= 2 || rawReasP50 <= 600) ? rawReasP50 : null;
  rows.push({
    model_key: modelKey,
    display: modelKey,
    org: null,
    input_usd_per_mtok: input,
    output_usd_per_mtok: output,
    cache_read_usd_per_mtok: stable(group.values.cache_read),
    cache_write_usd_per_mtok: stable(group.values.cache_write),
    confidence: 'unanimous-positive-rates',
    observed_samples: {
      messages: group.messages,
      input: group.values.input.length,
      output: group.values.output.length,
      cache_read: group.values.cache_read.length,
      cache_write: group.values.cache_write.length,
      model_ids: group.modelIds.size,
      providers: group.providers.size,
      ...(outToVisP50 !== null ? {output_to_visible_p50: Number(outToVisP50.toFixed(4))} : {}),
      ...(shortP50 !== null ? {short_output_to_visible_p50: Number(shortP50.toFixed(4))} : {}),
      ...(veryLongP50 !== null ? {long_output_to_visible_p50: Number(veryLongP50.toFixed(4))} : {}),
      ...(reasP50 !== null ? {reasoning_tokens_p50: Math.round(reasP50)} : {}),
    },
  });
}

const result = {
  schema: 'arena-battle-price-rates-v1',
  generated_at: new Date().toISOString(),
  source: 'arena-battle-price-training.json (revealed Arena Battle labels + same-message actual cost buckets)',
  training_generated_at: training.generated_at || null,
  unit: 'usd_per_million_tokens',
  policy: 'provider usage only; agent_p50 excluded; unanimous positive rate per bucket; input/output required; Battle observed primary, Arena official reference, OpenRouter fallback',
  training_models_seen: groups.size,
  included_models: rows.length,
  excluded_models: {missing_required_rate: missingRequired, conflicting_required_rate: conflictingRequired},
  rows,
};

console.log(JSON.stringify({
  training_models_seen: result.training_models_seen,
  included_models: result.included_models,
  excluded_models: result.excluded_models,
  output: REPORT_ONLY ? null : 'arena-battle-price-rates.json',
}));
if (!REPORT_ONLY) writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + '\n', 'utf8');
