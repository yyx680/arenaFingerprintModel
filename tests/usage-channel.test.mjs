import test from 'node:test';
import assert from 'node:assert/strict';
import {
  USAGE_SCHEMA, parseUsage, totalOf, usageShape, describeUsage, sumUsage,
  estimateCostUsd, sliceBalanced, extractUsageSignals, latestUsage,
} from '../usage-channel.js';

// 以下三份 payload 全部来自 2026-10-11 CDP 实测（/api/evaluation/<sid> 的 messages[].metadata.usage）。
const MEASURED_A = {type: 'language_model', inputTokens: 4, totalTokens: 7675, usageSource: 'provider', outputTokens: 326, cacheReadTokens: 3500, cacheWriteTokens: 3845};
const MEASURED_B = {type: 'language_model', inputTokens: 6, totalTokens: 15291, usageSource: 'provider', outputTokens: 4142, cacheReadTokens: 0, cacheWriteTokens: 11143};
const MEASURED_OLD = {type: 'language_model', inputTokens: 23937, totalTokens: 52473, usageSource: 'provider', outputTokens: 24184, cacheReadTokens: 4352, reasoningTokens: 14735};

test('parseUsage 归一化 Arena 实测用量', () => {
  const usage = parseUsage(MEASURED_A);
  assert.equal(usage.schema, USAGE_SCHEMA);
  assert.equal(usage.inputTokens, 4);
  assert.equal(usage.outputTokens, 326);
  assert.equal(usage.cacheReadTokens, 3500);
  assert.equal(usage.cacheWriteTokens, 3845);
  assert.equal(usage.totalTokens, 7675);
  assert.equal(usage.type, 'language_model');
  assert.equal(usage.usage_source, 'provider');
  // 缺失的 reasoningTokens 不应凭空补 0。
  assert.equal('reasoningTokens' in usage, false);
});

test('parseUsage 拒绝脏数据与空用量', () => {
  assert.equal(parseUsage(null), null);
  assert.equal(parseUsage([]), null);
  assert.equal(parseUsage({}), null);
  assert.equal(parseUsage({inputTokens: -5}), null);
  assert.equal(parseUsage({inputTokens: 0, outputTokens: 0}), null);
  assert.equal(parseUsage({inputTokens: '12'}), null);
  assert.equal(parseUsage({totalTokens: 900}).totalTokens, 900);
});

test('totalOf 与 Arena 的 totalTokens 口径一致', () => {
  for (const payload of [MEASURED_A, MEASURED_B, MEASURED_OLD]) {
    assert.equal(totalOf(payload), payload.totalTokens, 'in+out+cacheR+cacheW 应等于 totalTokens');
  }
});

test('usageShape 给出厂商/类别旁证签名', () => {
  const a = usageShape(parseUsage(MEASURED_A));
  assert.equal(a.has_cache_write, true);
  assert.equal(a.has_cache_read, true);
  assert.equal(a.has_reasoning, false);
  assert.equal(a.signature, 'cwcr--');
  assert.ok(a.cache_write_share > 0.4);

  // 旧会话实测里没有 cacheWriteTokens —— 说明「缓存写入」并非每个厂商都有，正是有判别力的那一维。
  const old = usageShape(parseUsage(MEASURED_OLD));
  assert.equal(old.has_reasoning, true);
  assert.equal(old.has_cache_write, false);
  assert.equal(old.signature, '--crrz');
  assert.ok(old.reasoning_share > 0.25);

  assert.equal(usageShape(null), null);
});

test('describeUsage 人读输出', () => {
  assert.equal(describeUsage(parseUsage(MEASURED_B)), 'in 6 / out 4142 / cacheW 11143 / total 15291');
  assert.equal(describeUsage(parseUsage(MEASURED_OLD)).includes('reason 14735'), true);
  assert.equal(describeUsage(null), '—');
});

test('sumUsage 合并多轮用量', () => {
  const merged = sumUsage([MEASURED_A, MEASURED_B]);
  assert.equal(merged.requests, 2);
  assert.equal(merged.inputTokens, 10);
  assert.equal(merged.outputTokens, 4468);
  assert.equal(merged.cacheWriteTokens, 14988);
  assert.equal(merged.totalTokens, 22966);
  assert.equal(sumUsage([]), null);
  assert.equal(sumUsage([null, {}]), null);
});

test('estimateCostUsd 只在有单价时折算，缺单价返回 null', () => {
  const usage = parseUsage(MEASURED_A);
  assert.equal(estimateCostUsd(usage, null), null);
  assert.equal(estimateCostUsd(usage, {}), null);
  const usd = estimateCostUsd(usage, {input_usd_per_mtok: 3, output_usd_per_mtok: 15});
  // 4/1e6*3 + 326/1e6*15 = 0.000012 + 0.00489
  assert.ok(Math.abs(usd - 0.004902) < 1e-6);
  const withCache = estimateCostUsd(usage, {input_usd_per_mtok: 3, output_usd_per_mtok: 15, cache_read_usd_per_mtok: 0.3, cache_write_usd_per_mtok: 3.75});
  assert.ok(withCache > usd);
});

test('sliceBalanced 正确配对花括号（含字符串与转义）', () => {
  assert.equal(sliceBalanced('{"a":1}', 0), '{"a":1}');
  assert.equal(sliceBalanced('xx{"a":{"b":2}}yy', 2), '{"a":{"b":2}}');
  assert.equal(sliceBalanced('{"a":"}\\"{"}', 0), '{"a":"}\\"{"}');
  assert.equal(sliceBalanced('{"a":1', 0), null);
  assert.equal(sliceBalanced('nope', 0), null);
});

test('extractUsageSignals 从会话 JSON 中抽出用量', () => {
  const body = JSON.stringify({messages: [
    {role: 'user', metadata: {}},
    {role: 'assistant', participantPosition: 'a', metadata: {usage: MEASURED_A, workflowRunId: 'run_x'}},
    {role: 'assistant', participantPosition: 'b', metadata: {usage: MEASURED_B, workflowRunId: 'run_y'}},
  ]});
  const signals = extractUsageSignals(body, 'fetch.body', 'https://arena.ai/api/evaluation/01a12bb5');
  assert.equal(signals.length, 2);
  assert.equal(signals[0].kind, 'usage');
  assert.equal(signals[0].usage.totalTokens, 7675);
  assert.equal(signals[0].via, 'usage-object');
  assert.equal(signals[1].usage.cacheWriteTokens, 11143);
  assert.equal(signals[1].where, 'fetch.body');
  assert.equal(signals[0].shape.has_cache_write, true);

  // 去重：同一份用量出现两次只记一条
  assert.equal(extractUsageSignals(body + body).length, 2);
});

test('extractUsageSignals 兜底覆盖转义流与 snake_case', () => {
  const escaped = 'a2:[{"metadata":{"usage":{"input_tokens":1200,"output_tokens":340,"total_tokens":1540}}}]';
  const signals = extractUsageSignals(escaped, 'fetch.stream', 'https://arena.ai/api/evaluation/x');
  assert.ok(signals.length >= 1);
  assert.equal(signals[0].usage.inputTokens, 1200);
  assert.equal(signals[0].usage.outputTokens, 340);
  assert.equal(signals[0].usage.totalTokens, 1540);

  assert.equal(extractUsageSignals('no tokens at all').length, 0);
  assert.equal(extractUsageSignals('inputTokens:'.repeat(60000)).length, 0);
});

test('latestUsage 取最近一条', () => {
  const signals = extractUsageSignals(JSON.stringify({a: {usage: MEASURED_A}, b: {usage: MEASURED_B}}), 'x', 'y');
  const last = latestUsage(signals);
  assert.equal(last.usage.totalTokens, 15291);
  assert.equal(last.shape.has_cache_write, true);
  assert.equal(latestUsage([]), null);
});
