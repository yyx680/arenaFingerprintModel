import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ESTIMATE_METHOD, ESTIMATE_RATES, countChars, estimateTokensFromChars,
  messageTextStats, estimateUsageFromStats, transcriptStats,
} from '../usage-channel.js';
import {ledgerRowsFromTranscript, ledgerRowsFromEstimates, ledgerTotals, describeTotals, LEDGER_SCHEMA} from '../cost-ledger.js';
import {normalizePricingTable} from '../pricing-channel.js';

/* 合成单价表（与 cost-ledger 测试同源）：gpt-6-sol 一档 10/50，astra 两档同价。 */
const TABLE = normalizePricingTable({
  schema: 'arena-model-pricing',
  source: 'test',
  fetched_at: '2026-10-12T00:00:00.000Z',
  unit: 'usd_per_million_tokens',
  rows: [
    {model_key: 'gpt-6-sol-max-agent', display: 'GPT-6 Sol Max', org: 'OpenAI', input_usd_per_mtok: 10, output_usd_per_mtok: 50},
    {model_key: 'gpt-5.6-luna-xhigh-agent', display: 'GPT-5.6 Luna', org: 'OpenAI', input_usd_per_mtok: 0.2, output_usd_per_mtok: 1.2},
  ],
});

/* 2026-10-12 CDP 实测的 Agent 转录形状（canary.arena.ai /api/chat/<sid>，只改了 id）。 */
const REASONING = 'Simple: user wants the numeric answer to 1+1 with only the number. Output "2".\n';
const TRANSCRIPT = {
  id: '01a12ca1-0000-7000-0000-000000000000',
  messages: [
    {id: 'm1', role: 'user', parts: [{type: 'text', text: '1+1=? 只输出数字'}]},
    {id: 'm2', role: 'assistant', modelId: null, metadata: {timing: {startedAt: 1, completedAt: 2}}, parts: [
      {type: 'step-start'},
      {type: 'reasoning', text: REASONING, state: 'done'},
      {type: 'text', text: '2', state: 'done'},
    ]},
    {id: 'm3', role: 'assistant', modelId: 'gpt-6-sol-max-agent', parts: [
      {type: 'text', text: '好的，答案是 2。', state: 'done'},
    ]},
  ],
};

test('countChars 按码点分 CJK / 其他', () => {
  const mixed = countChars('1+1=? 只输出数字');
  assert.equal(mixed.chars, 11);
  assert.equal(mixed.cjk, 5);
  assert.equal(mixed.other, 6);
  assert.equal(countChars('').chars, 0);
  assert.equal(countChars(null).chars, 0);
  // 代理对（emoji）算一个字符，不劈成两半。
  assert.equal(countChars('🙂').chars, 1);
});

test('estimateTokensFromChars：CJK 1/字、其余 0.27/字符', () => {
  assert.equal(ESTIMATE_METHOD, 'chars-v1');
  assert.equal(ESTIMATE_RATES.cjk_tokens_per_char, 1);
  assert.equal(estimateTokensFromChars({chars: 11, cjk: 5, other: 6}), 7); // 5 + 1.62 → 7
  assert.equal(estimateTokensFromChars(countChars('好的，答案是 2。')), 8); // 7 + 0.54 → 8
  assert.equal(estimateTokensFromChars(null), 0);
  assert.equal(estimateTokensFromChars({chars: 0, cjk: 0, other: 0}), 0);
});

test('messageTextStats 分开数正文与 thinking，非文本 part 只计数', () => {
  const stats = messageTextStats(TRANSCRIPT.messages[1]);
  assert.equal(stats.text.chars, 1);
  assert.equal(stats.reasoning.chars, REASONING.length);
  assert.equal(stats.skipped_parts, 0, 'step-start 不算被跳过的 part');
  const withTool = messageTextStats({parts: [{type: 'text', text: 'a'}, {type: 'tool-call', toolName: 'x'}]});
  assert.equal(withTool.skipped_parts, 1);
  assert.equal(messageTextStats(null).text.chars, 0);
});

test('estimateUsageFromStats：output = 正文 + thinking，reasoning 不重复计', () => {
  const built = estimateUsageFromStats(messageTextStats(TRANSCRIPT.messages[1]));
  assert.equal(built.usage.usage_source, 'chars-v1');
  assert.equal(built.usage.reasoningTokens, estimateTokensFromChars(countChars(REASONING)));
  assert.equal(built.usage.outputTokens, built.usage.reasoningTokens + estimateTokensFromChars(countChars('2')));
  assert.equal(built.usage.totalTokens, built.usage.outputTokens, 'reasoning 已含在 output 里，不重复计入 total');
  assert.equal(built.estimate.method, 'chars-v1');
  assert.equal(built.estimate.chars.reasoning, REASONING.length);
  assert.equal(built.estimate.output_is_estimate, true);
  assert.equal(estimateUsageFromStats(messageTextStats({parts: [{type: 'step-start'}]})), null, '没有文字就没有估算');
});

test('transcriptStats：逐条统计 + 用户文字给输入下界', () => {
  const stats = transcriptStats(TRANSCRIPT);
  assert.equal(stats.method, 'chars-v1');
  assert.equal(stats.messages.length, 3);
  assert.equal(stats.totals.assistants, 2, '两条 assistant 都有输出');
  assert.equal(stats.totals.text_chars, '1+1=? 只输出数字'.length + 1 + '好的，答案是 2。'.length, '所有 text part 都计入字符数（含用户那条）');
  assert.equal(stats.totals.reasoning_chars, REASONING.length);
  assert.equal(stats.totals.input_tokens_lower_bound, 7, '用户那条 11 字符 → 7 token 下界');
  assert.equal(stats.totals.output_tokens, stats.messages[1].output_tokens + stats.messages[2].output_tokens);
  assert.equal(transcriptStats(null), null);
  assert.equal(transcriptStats({messages: 'nope'}), null);
});

test('ledgerRowsFromTranscript：行与 token 路径同形，多一个 estimate 标记', () => {
  const rows = ledgerRowsFromTranscript(TRANSCRIPT, TABLE);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].index, 1);
  assert.equal(rows[0].message_id, 'm2');
  assert.equal(rows[0].role, 'assistant');
  assert.equal(rows[0].model, null);
  assert.equal(rows[0].tokens, 21);
  assert.equal(rows[0].base_usd, null, '模型未知就不猜价');
  assert.equal(rows[0].source, 'transcript-estimate');
  assert.equal(rows[0].estimate.method, 'chars-v1');
  assert.match(rows[0].usage_text, /^in 0/);
  assert.equal(rows[1].message_id, 'm3');
  assert.equal(rows[1].model, 'gpt-6-sol-max-agent');
  assert.equal(rows[1].tokens, 8);
  assert.equal(rows[1].base_usd, 0.0004, '8 token × $50/Mtok');
  assert.equal(rows[1].source, 'transcript-estimate+pricing-table');
});

test('v2.15.0 输入下界：用户那条消息配给紧随的 assistant，且只认领一次', () => {
  const rows = ledgerRowsFromTranscript(TRANSCRIPT, TABLE);
  // m1（user，11 字符）→ 7 token，配给紧随的 m2。
  assert.equal(rows[0].estimate.input_tokens_lower_bound, 7);
  // m3 是同一轮的第二步 assistant，输入已被 m2 认领，不重复计。
  assert.equal(rows[1].estimate.input_tokens_lower_bound, undefined);
  // 输入下界**不进** tokens / base —— 输出侧口径不被污染。
  assert.equal(rows[0].tokens, 21);
  const totals = ledgerTotals(rows);
  assert.equal(totals.tokens, 29);
  assert.equal(totals.input_tokens_lower_bound, 7);
  // 嗅探器条目路径（input_chars 字符桶）走同一口径。
  const viaSignal = ledgerRowsFromEstimates([
    {message_id: 'm2', chars: {text: countChars('2'), reasoning: countChars(REASONING)}, input_chars: countChars('1+1=? 只输出数字')},
  ], TABLE);
  assert.equal(viaSignal[0].estimate.input_tokens_lower_bound, 7);
  // 没有用户消息时不给输入下界。
  const noInput = ledgerRowsFromEstimates([{message_id: 'x', chars: {text: countChars('好的'), reasoning: countChars('')}}], TABLE);
  assert.equal(noInput[0].estimate.input_tokens_lower_bound, undefined);
  assert.equal(ledgerTotals(noInput).input_tokens_lower_bound, undefined);
});

test('ledgerRowsFromTranscript：options.model 兜底，未知模型时才不折价', () => {
  const rows = ledgerRowsFromTranscript(TRANSCRIPT, TABLE, {model: 'gpt-5.6-luna-xhigh-agent'});
  assert.equal(rows.length, 2);
  assert.equal(rows[0].base_usd, Number((21 / 1e6 * 1.2).toFixed(6)));
  assert.equal(rows[0].source, 'transcript-estimate+pricing-table');
  assert.equal(ledgerRowsFromTranscript(null, TABLE).length, 0);
  assert.equal(ledgerRowsFromTranscript(TRANSCRIPT, null).length, 2, '没单价表也要出行（只报 token）');
  assert.ok(ledgerRowsFromTranscript(TRANSCRIPT, null).every((row) => row.base_usd === null && row.source === 'transcript-estimate'));
});

test('ledgerRowsFromEstimates：嗅探器条目（字符桶）→ 同样的行', () => {
  const estimates = [
    {message_id: 'm2', chars: {text: countChars('2'), reasoning: countChars(REASONING)}},
    {message_id: 'm3', model_id: 'gpt-6-sol-max-agent', chars: {text: countChars('好的，答案是 2。'), reasoning: countChars('')}},
  ];
  const fromPayload = ledgerRowsFromTranscript(TRANSCRIPT, TABLE);
  const fromSignals = ledgerRowsFromEstimates(estimates, TABLE);
  assert.deepEqual(fromSignals.map((row) => [row.message_id, row.tokens, row.base_usd, row.source]), fromPayload.map((row) => [row.message_id, row.tokens, row.base_usd, row.source]));
  assert.equal(ledgerRowsFromEstimates(null, TABLE).length, 0);
  assert.equal(ledgerRowsFromEstimates([{chars: null}], TABLE).length, 0);
});

test('ledgerTotals 标出估算来源', () => {
  const rows = ledgerRowsFromTranscript(TRANSCRIPT, TABLE);
  const totals = ledgerTotals(rows);
  assert.equal(totals.schema, LEDGER_SCHEMA);
  assert.equal(totals.estimated, true);
  assert.equal(totals.estimate_method, 'chars-v1');
  assert.equal(totals.messages, 2);
  assert.equal(totals.priced, 1);
  assert.equal(totals.unpriced, 1);
  assert.equal(totals.tokens, 29);
  // 非估算行不被打上标记。
  assert.equal(ledgerTotals([{tokens: 1, base_usd: 0.1, estimate: undefined}]).estimated, false);
});

test('v2.15.0 已识别模型 → 估算行折出金额（指纹结果接进账本）', () => {
  const estimates = [
    {message_id: 'm2', chars: {text: countChars('2'), reasoning: countChars(REASONING)}},
  ];
  // 模型未揭晓：只报 token，绝不猜价。
  const bare = ledgerRowsFromEstimates(estimates, TABLE);
  assert.equal(bare[0].base_usd, null);
  assert.equal(bare[0].source, 'transcript-estimate');
  // 指纹识别出唯一模型：按公开单价折 base（21 token × $50/Mtok）。
  const priced = ledgerRowsFromEstimates(estimates, TABLE, {model: 'gpt-6-sol-max-agent'});
  assert.equal(priced[0].model, 'gpt-6-sol-max-agent');
  assert.equal(priced[0].base_usd, Number((21 / 1e6 * 50).toFixed(6)));
  assert.equal(priced[0].source, 'transcript-estimate+pricing-table');
  // 账本里 message 自带的 model_id 优先于兜底模型。
  const explicit = ledgerRowsFromEstimates([{message_id: 'm3', model_id: 'gpt-5.6-luna-xhigh-agent', chars: {text: countChars('好的'), reasoning: countChars('')}}], TABLE, {model: 'gpt-6-sol-max-agent'});
  assert.equal(explicit[0].model, 'gpt-5.6-luna-xhigh-agent');
  // 摘要里出现基准价，且仍标「估算」。
  const text = describeTotals(ledgerTotals(priced));
  assert.ok(text.includes('基准价合计'), text);
  assert.ok(text.includes('1 条（估算）'), text);
});

test('describeTotals：估算会话必须露出 token 估算，不能只写「N 条无单价」', () => {
  // Agent 常态：模型未揭晓 → 全部行 unpriced，token 估算就是唯一产出。
  const rows = ledgerRowsFromTranscript(TRANSCRIPT, null);
  const text = describeTotals(ledgerTotals(rows));
  assert.ok(text.includes('2 条（估算）'), text);
  assert.ok(text.includes('输出约 29 token'), text);
  assert.ok(text.includes('输入下界约 7 token'), text);
  assert.ok(text.includes('2 条无单价'), text);
  // 有单价时（pinnedModel 兜底等）基准价照常显示，且仍标「估算」。
  const priced = describeTotals(ledgerTotals(ledgerRowsFromTranscript(TRANSCRIPT, TABLE)));
  assert.ok(priced.includes('2 条（估算）'), priced);
  assert.ok(priced.includes('基准价合计'), priced);
  // 非估算会话的摘要不变。
  assert.ok(!describeTotals(ledgerTotals([{tokens: 3, base_usd: 0.001}])).includes('估算'));
});
