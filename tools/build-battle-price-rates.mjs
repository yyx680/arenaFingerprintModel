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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = join(ROOT, 'arena-battle-price-training.json');
const OUTPUT = join(ROOT, 'arena-battle-price-rates.json');
const REPORT_ONLY = process.argv.includes('--report');
const BUCKETS = ['input', 'output', 'cache_read', 'cache_write'];

const training = JSON.parse(readFileSync(INPUT, 'utf8'));
if (!training || training.schema !== 'arena-battle-price-training-v1' || !Array.isArray(training.battles)) {
  throw new Error('arena-battle-price-training.json schema 无效');
}
if (training.history_complete !== true) throw new Error('训练集历史扫描不完整，拒绝生成运行时费率表');

const roundRate = value => Number(Number(value).toFixed(9));
const groups = new Map();
const ensure = name => {
  if (!groups.has(name)) groups.set(name, {messages: 0, modelIds: new Set(), providers: new Set(), values: Object.fromEntries(BUCKETS.map(bucket => [bucket, []]))});
  return groups.get(name);
};

for (const battle of training.battles) {
  for (const turn of battle?.turns || []) {
    for (const candidate of turn?.candidates || []) {
      const name = typeof candidate?.model_name === 'string' ? candidate.model_name.trim() : '';
      const evidence = candidate?.price_evidence;
      if (!name || name.length > 160 || !evidence || evidence.usage_source !== 'provider'
        || evidence.cost_source === 'agent_p50') continue;
      const group = ensure(name);
      group.messages += 1;
      if (typeof candidate.model_id === 'string' && candidate.model_id) group.modelIds.add(candidate.model_id);
      if (typeof candidate.model_provider === 'string' && candidate.model_provider) group.providers.add(candidate.model_provider);
      for (const bucket of BUCKETS) {
        const part = evidence.components?.[bucket];
        const tokens = Number(part?.tokens);
        const cost = Number(part?.cost_usd);
        if (!(Number.isFinite(tokens) && tokens > 0 && Number.isFinite(cost) && cost > 0)) continue;
        const value = roundRate(cost * 1e6 / tokens);
        if (Number.isFinite(value) && value > 0) group.values[bucket].push(value);
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
  const input = stable(group.values.input);
  const output = stable(group.values.output);
  if (!(input > 0 && output > 0)) {
    if (!group.values.input.length || !group.values.output.length) missingRequired += 1;
    else conflictingRequired += 1;
    continue;
  }
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
