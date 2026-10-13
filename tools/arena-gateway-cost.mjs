#!/usr/bin/env node
/* Arena API 网关 · 按成本反推模型（路线 B，v2.10.0）
 *
 * 背景：Arena 的 API 网关 https://api.preview.arena.ai 是 OpenAI / Anthropic 兼容的，
 * 官方文档明确写着请求会走「billing, logging, and rate-limit pipeline」，并且有个 router
 * （coding-router-preview）会隐藏真实模型。**每次请求的成本在这里是可观测的** —— 而网页版
 * Agent Mode 只下发额度百分比。所以「按价格反推模型」只有在这条路径上能真正成立。
 *
 * 本脚本做三件事：
 *   1. 列模型：GET  /v1/models
 *   2. 发探针：POST /v1/chat/completions（默认一条与扩展同款的数字题），拿回 usage / cost / model 字段
 *   3. 反推：若响应里有成本，则用费率表（tools/arena-rate-table.json）算每个模型的预期成本，
 *            与观测成本比对数（对数正态似然），给出最可能的模型。
 *
 * 用法：
 *   ARENA_API_KEY=<你的 Arena key> node tools/arena-gateway-cost.mjs
 *   ARENA_API_KEY=... node tools/arena-gateway-cost.mjs --list
 *   ARENA_API_KEY=... node tools/arena-gateway-cost.mjs --model gpt-6-astra --json
 *   ARENA_API_KEY=... node tools/arena-gateway-cost.mjs --prompt "ping" --max-tokens 32
 *
 * 已知限制（别当成 bug）：
 *   · 网关的「listed rates」在 dashboard 的 Models 页，本仓库没有它的权威副本；
 *     tools/arena-rate-table.json 里费率默认留空 —— 留空时只打印 usage / 成本字段，不做反推。
 *     从你的 dashboard 抄一次即可长期使用。
 *   · 脚本只读：不发任何第三方请求、不落盘、不回显你的 key。
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';

const DEFAULT_BASE = 'https://api.preview.arena.ai';
const RATE_TABLE_URL = new URL('./arena-rate-table.json', import.meta.url);
/** 与扩展同款的数字探针（缩短版，够产生可比的 token 量级）。 */
const DEFAULT_PROMPT = 'For each of 120 positions, make one separate first-instinct choice of an integer from 1 to 355 inclusive. Separate values clearly and output the complete sequence without explanation.';

export function parseArgs(argv) {
  const args = {base: DEFAULT_BASE, model: 'coding-router-preview', prompt: DEFAULT_PROMPT, maxTokens: 512, list: false, json: false, rates: null, timeout: 120000};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => argv[++i];
    if (token === '--base') args.base = String(next() || DEFAULT_BASE).replace(/\/+$/, '');
    else if (token === '--model') args.model = String(next() || args.model);
    else if (token === '--prompt') args.prompt = String(next() || args.prompt);
    else if (token === '--max-tokens') args.maxTokens = Math.max(1, Number(next()) || args.maxTokens);
    else if (token === '--rates') args.rates = String(next() || '');
    else if (token === '--timeout') args.timeout = Math.max(1000, Number(next()) || args.timeout);
    else if (token === '--list') args.list = true;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

function help() {
  console.log(`Arena API 网关 · 按成本反推模型

  ARENA_API_KEY=<key> node tools/arena-gateway-cost.mjs [options]

  --base <url>        网关根（默认 ${DEFAULT_BASE}）
  --model <id>        模型 ID（默认 coding-router-preview；direct model 需组织授权）
  --prompt <text>     探针文本
  --max-tokens <n>    最大输出 token（默认 512）
  --rates <file>      费率表路径（默认 tools/arena-rate-table.json）
  --timeout <ms>      单次请求超时（默认 120000）
  --list              只列可用模型，不发探针
  --json              以 JSON 输出（便于管道处理）
  -h, --help          显示本帮助

  环境变量：ARENA_API_KEY（必填，绝不出现在输出里）`);
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;

export function loadRateTable(path) {
  try {
    const raw = JSON.parse(readFileSync(path || fileURLToPath(RATE_TABLE_URL), 'utf8'));
    const models = raw && typeof raw.models === 'object' && !Array.isArray(raw.models) ? raw.models : {};
    const clean = {};
    for (const [id, rate] of Object.entries(models)) {
      const input = Number(rate?.input_usd_per_mtok);
      const output = Number(rate?.output_usd_per_mtok);
      if (positive(input) || positive(output)) clean[id] = {input: positive(input) ? input : null, output: positive(output) ? output : null};
    }
    return {source: path || 'tools/arena-rate-table.json', fetched_at: raw?.fetched_at || null, models: clean, raw: models};
  } catch (error) {
    return {source: path || 'tools/arena-rate-table.json', fetched_at: null, models: {}, raw: {}, error: String(error?.message || error)};
  }
}

async function callGateway(base, path, key, {method = 'GET', body = null, timeout = 120000} = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'x-api-key': key,
      Accept: 'application/json',
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON：原样返回文本 */ }
  return {status: response.status, ok: response.ok, data, text: text.slice(0, 4000)};
}

/** 从响应里尽量捞出模型名 / 用量 / 成本字段（字段名不做假设，见一个记一个）。 */
export function readSignals(data) {
  const signals = {model: null, usage: null, cost: null, costFields: []};
  if (!data || typeof data !== 'object') return signals;
  if (typeof data.model === 'string') signals.model = data.model;
  if (data.usage && typeof data.usage === 'object') {
    signals.usage = {
      prompt_tokens: Number(data.usage.prompt_tokens ?? data.usage.input_tokens) || null,
      completion_tokens: Number(data.usage.completion_tokens ?? data.usage.output_tokens) || null,
      total_tokens: Number(data.usage.total_tokens) || null,
    };
  }
  const scan = (object, depth = 0) => {
    if (!object || typeof object !== 'object' || depth > 3) return;
    for (const [key, value] of Object.entries(object)) {
      if (/^(cost|totalcost|total_cost|costusd|cost_usd|priceusd|price_usd|spend)$/i.test(key) && positive(Number(value))) {
        signals.costFields.push({field: key, value: Number(value)});
      } else if (value && typeof value === 'object') scan(value, depth + 1);
    }
  };
  scan(data);
  if (signals.costFields.length) signals.cost = Math.max(...signals.costFields.map(item => item.value));
  return signals;
}

/** 用费率表把 usage 折算成每个模型的预期成本，再与观测成本比对数似然。 */
export function inferByCost(observedUsd, usage, rateTable, sigma = 0.7) {
  if (!positive(observedUsd) || !usage) return null;
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  if (!promptTokens && !completionTokens) return null;
  const scored = [];
  for (const [id, rate] of Object.entries(rateTable.models)) {
    const expected = (promptTokens / 1e6) * (rate.input || 0) + (completionTokens / 1e6) * (rate.output || 0);
    if (!positive(expected)) continue;
    const z = (Math.log(observedUsd) - Math.log(expected)) / sigma;
    scored.push({id, expected_usd: Number(expected.toFixed(6)), ratio: Number((observedUsd / expected).toFixed(3)), likelihood: Math.exp(-0.5 * z * z)});
  }
  if (!scored.length) return null;
  const total = scored.reduce((sum, item) => sum + item.likelihood, 0);
  for (const item of scored) item.weight = total > 0 ? Number((item.likelihood / total).toFixed(4)) : 0;
  scored.sort((left, right) => right.likelihood - left.likelihood || left.expected_usd - right.expected_usd);
  return scored;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return 0; }
  const key = process.env.ARENA_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('缺少 ARENA_API_KEY。用法：ARENA_API_KEY=<key> node tools/arena-gateway-cost.mjs --help');
    return 2;
  }
  const rateTable = loadRateTable(args.rates);

  const models = await callGateway(args.base, '/v1/models', key, {timeout: 30000});
  if (!models.ok) {
    console.error(`列模型失败：HTTP ${models.status}`);
    console.error(models.text.slice(0, 500));
    if (models.status === 401 || models.status === 403) console.error('→ 检查 key 是否有效、是否属于同一 workspace。');
    return 1;
  }
  const ids = Array.isArray(models.data?.data) ? models.data.data.map(item => item?.id).filter(Boolean) : [];
  if (args.list) {
    if (args.json) console.log(JSON.stringify({base: args.base, models: ids}, null, 2));
    else console.log(`可用模型（${ids.length}）：\n` + ids.map(id => '  - ' + id).join('\n'));
    return 0;
  }

  const chat = await callGateway(args.base, '/v1/chat/completions', key, {
    method: 'POST',
    timeout: args.timeout,
    body: {model: args.model, messages: [{role: 'user', content: args.prompt}], max_tokens: args.maxTokens, stream: false},
  });
  if (!chat.ok) {
    console.error(`探针失败：HTTP ${chat.status}`);
    console.error(chat.text.slice(0, 800));
    return 1;
  }
  const signals = readSignals(chat.data);
  const inference = inferByCost(signals.cost, signals.usage, rateTable);
  const reply = chat.data?.choices?.[0]?.message?.content;

  const report = {
    base: args.base,
    requested_model: args.model,
    echoed_model: signals.model,
    usage: signals.usage,
    cost_usd: signals.cost,
    cost_fields: signals.costFields,
    rate_table: {source: rateTable.source, fetched_at: rateTable.fetched_at, models_with_rates: Object.keys(rateTable.models).length},
    inference: inference ? inference.slice(0, 5) : null,
    reply_preview: typeof reply === 'string' ? reply.slice(0, 160) : null,
    available_models: ids.length,
  };

  if (args.json) { console.log(JSON.stringify(report, null, 2)); return 0; }

  console.log('=== Arena 网关成本探测 ===');
  console.log(`网关        : ${args.base}`);
  console.log(`请求模型    : ${args.model}`);
  console.log(`响应回显模型: ${signals.model || '（网关没有回显 model 字段）'}`);
  console.log(`可用模型数  : ${ids.length}`);
  if (signals.usage) console.log(`用量        : in ${signals.usage.prompt_tokens ?? '—'} / out ${signals.usage.completion_tokens ?? '—'} / total ${signals.usage.total_tokens ?? '—'}`);
  else console.log('用量        : 响应里没有 usage 字段');
  if (signals.costFields.length) console.log(`成本字段    : ${signals.costFields.map(item => `${item.field}=${item.value}`).join(' ')} → 取 $${signals.cost}`);
  else console.log('成本字段    : 响应里没有 cost/price/spend 字段（可去 dashboard 的 usage 页看账单）');
  if (report.reply_preview) console.log(`回复预览    : ${report.reply_preview.replace(/\s+/g, ' ')}`);
  console.log('');
  if (inference) {
    console.log('按成本反推（费率表 ' + rateTable.source + '）：');
    for (const item of inference.slice(0, 5)) {
      console.log(`  ${String(item.weight).padEnd(6)} ${item.id.padEnd(28)} 预期 $${item.expected_usd} · 实测/预期 ${item.ratio}`);
    }
  } else if (!signals.cost) {
    console.log('未做反推：响应里没有可用的成本字段。');
    console.log('→ 若 dashboard 能看到每次请求花费，说明成本在服务端记账，可改用 dashboard 的 usage 接口；');
    console.log('→ 若响应里有成本但这里没认出来，请把响应 JSON（去掉 key）贴出来，我加字段。');
  } else if (!Object.keys(rateTable.models).length) {
    console.log('未做反推：费率表里还没有填任何费率。');
    console.log('→ 打开 ' + rateTable.source + '，按 dashboard 的 listed rates 填 input_usd_per_mtok / output_usd_per_mtok。');
  } else {
    console.log('未做反推：缺少 usage（prompt_tokens / completion_tokens）。');
  }
  return 0;
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(code => process.exit(code)).catch(error => {
    console.error('异常：' + (error?.message || error));
    process.exit(1);
  });
}
