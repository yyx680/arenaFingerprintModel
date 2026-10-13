import test from 'node:test';
import assert from 'node:assert/strict';
import {readSignals, inferByCost, loadRateTable, parseArgs} from '../tools/arena-gateway-cost.mjs';

test('parseArgs 解析网关参数与默认值', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.base, 'https://api.preview.arena.ai');
  assert.equal(defaults.model, 'coding-router-preview');
  assert.equal(defaults.list, false);
  const custom = parseArgs(['--base', 'https://example.test/', '--model', 'gpt-6-astra', '--max-tokens', '64', '--json', '--list']);
  assert.equal(custom.base, 'https://example.test'); // 去掉结尾斜杠
  assert.equal(custom.model, 'gpt-6-astra');
  assert.equal(custom.maxTokens, 64);
  assert.equal(custom.json, true);
  assert.equal(custom.list, true);
});

test('readSignals 兼容 OpenAI / Anthropic 两种 usage 命名并捞成本字段', () => {
  const openai = readSignals({model: 'gpt-6-astra', usage: {prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540}, cost_usd: 0.0173});
  assert.equal(openai.model, 'gpt-6-astra');
  assert.equal(openai.usage.prompt_tokens, 1200);
  assert.equal(openai.usage.completion_tokens, 340);
  assert.equal(openai.cost, 0.0173);
  const anthropic = readSignals({type: 'message', usage: {input_tokens: 900, output_tokens: 120}});
  assert.equal(anthropic.usage.prompt_tokens, 900);
  assert.equal(anthropic.usage.completion_tokens, 120);
  assert.equal(anthropic.cost, null);
  // 嵌套成本字段也能捞到
  assert.equal(readSignals({billing: {totalCost: 0.5}}).cost, 0.5);
  assert.equal(readSignals(null).model, null);
});

test('loadRateTable 只保留填了费率的模型，空表不报错', () => {
  const shipped = loadRateTable();
  assert.equal(typeof shipped.models, 'object');
  assert.ok(Object.keys(shipped.raw).length >= 20, '模板里应预置 Arena 模型 ID');
  assert.equal(Object.keys(shipped.models).length, 0, '模板默认不填费率 → 不参与反推');
});

test('inferByCost 用 usage × 费率反推最接近观测成本的模型', () => {
  const rateTable = {models: {
    cheap: {input: 0.5, output: 1.5},
    mid: {input: 3, output: 15},
    pricey: {input: 15, output: 75},
  }};
  const usage = {prompt_tokens: 1000, completion_tokens: 2000};
  // cheap → 0.0005+0.003=0.0035 ; mid → 0.003+0.03=0.033 ; pricey → 0.015+0.15=0.165
  const mid = inferByCost(0.033, usage, rateTable);
  assert.equal(mid[0].id, 'mid');
  assert.equal(mid[0].ratio, 1);
  const pricey = inferByCost(0.17, usage, rateTable);
  assert.equal(pricey[0].id, 'pricey');
  const weights = mid.reduce((sum, item) => sum + item.weight, 0);
  assert.ok(Math.abs(weights - 1) < 1e-3, '权重归一化（权重按 4 位取整，容差放宽）');
  // 没有成本 / 没有 usage / 没有费率 → 一律不做反推
  assert.equal(inferByCost(0, usage, rateTable), null);
  assert.equal(inferByCost(0.03, {prompt_tokens: 0, completion_tokens: 0}, rateTable), null);
  assert.equal(inferByCost(0.03, usage, {models: {}}), null);
});
