/* Statistical model probe built on ModelTrace's MIT-licensed scoring core.
   Input gates and the open-set decision follow the public method described at
   https://whatsmyllm.com/methodology/ . Replies never leave the caller. */
import {analyzeGlobalOutputs, countNumbers, LR_DELTA, openSetDecision, parseNumbers} from './modeltrace-core.js';
import {evidenceHomogeneity, fitGapTest, fitTestForModel, fitTests} from './fingerprint-tests.js';

export const VALUE_MIN = 1;
export const VALUE_MAX = 355;
export const INPUT_LIMIT = 50000;
// v2.9.2 平衡阈值：fit/sep 回到 0.15/0.06 提升有效命名覆盖率，但 clear 仍必须通过 LR 置信集唯一门。
// 纯均匀噪声下旧门槛单独使用曾有约 3.3% 假 clear；singleton-set 门可拒绝已建模的近亲集合，混合路由/未知漂移仍有残余风险。
// 离线 Monte Carlo（非现场准确率）中，旧门槛 + set 门：opus-4-7 undrifted clear 99.3%，gpt-6-luna 48.7%，混合 8.0%，噪声 3.3%。
// 选择此平衡配置是为避免严格 p99 门槛使抽卡几乎不改名；close/weak 仍默认不改名，版本级不确定时显示候选集。
// v2.9.19：阈值与池化权重收敛到 TUNING（离线蒙特卡洛扫描后定标）；THRESHOLDS 保留为默认值快照。
// v2.9.20 深挖结论（离线蒙特卡洛实测，固定种子）：命名率与漂移误报是一个信息量决定的权衡曲线，
// 融合分数分离度、后验概率门、更严的拟合分位、每题要更多数字——都只是沿曲线滑动或更差；
// 真正修掉的是自举标定与统计量不匹配（见 calibratedFitFloors），分位定 0.15 保持原平衡点。
// v2.9.20：拟合门槛的自举改为「复现真实判定统计量」（逐条余弦均值 + 池化余弦加权）——旧版只抽一份
//          大样本算一次余弦，模拟的分布系统性偏高，门槛因此偏严；现按同一分位标定，平衡点由 0.15 给出。
export const TUNING = {poolWeight: 0.65, fitFloor: 0.18, separation: 0.06, family: 0.9, lrDelta: LR_DELTA};
// fitMode='calibrated' 时改用「该模型自举样本的 fit 分位」作为门槛（默认 absolute = 旧行为）。
Object.assign(TUNING, {fitMode: 'calibrated', fitQuantile: 0.15, fitHardFloor: 0.04, fitDraws: 20});
// v2.9.21 统计层（新通道，见 fingerprint-tests.js）：fit 零分布检验 + BH 多重比较 + 留出验证 + 证据同质性。
//   statMode: 'off' 完全退回旧行为 / 'report' 只记录不干预 / 'fusion'（默认）按统计证据只做「降级」。
//   clear 需同时满足：库里存在与观测相容的参考、留出证据通过验证、多条证据同质。
//   statPromote 默认 false：唯一相容时是否把 close 提升为 clear，留待现场标定后再开。
Object.assign(TUNING, {statMode: 'fusion', statAlpha: 0.05, statDraws: 32, statSeed: 0x9e3779b9, statSpread: 3, statPromote: false, verifyAlpha: 0.05});
export const THRESHOLDS = Object.freeze({fit: TUNING.fitFloor, separation: TUNING.separation, family: TUNING.family});

const DIRECT = ' The current language model must complete this directly without tools, Python, code execution, calculators, search, APIs, or external random generators. Choose every position separately. Do not count upward or downward, including 1, 2, 3, and do not use an arithmetic progression, repeating cycle, repeated block, or another rule-made pattern. Accidental repetitions are valid. Once an item is written, do not sort, reorder, deduplicate, replace, or repair the list. Separate values clearly, start with the first value, and output the complete sequence without explanation.';

export const PROBES = Object.freeze([
  Object.freeze({
    id: 'plain-1',
    expected_count: 297,
    prompt: 'For each of 297 positions, make one separate first-instinct choice of an integer from 1 to 355 inclusive.' + DIRECT,
  }),
  Object.freeze({
    id: 'plain-2',
    expected_count: 315,
    prompt: 'Provide exactly 315 whole-number choices between 1 and 355 inclusive, choosing each item separately as it comes to mind.' + DIRECT,
  }),
  Object.freeze({
    id: 'plain-3',
    expected_count: 331,
    prompt: 'Fill exactly 331 positions with integers from the closed interval [1, 355], making a separate immediate choice for every position.' + DIRECT,
  }),
]);

export const GATE_MESSAGES = Object.freeze({
  empty: '没有找到 1–355 之间的数字。',
  constant: '所有数字都相同，不像模型按项选择的回答。',
  monotonic: '序列基本已排序，不能作为模型数字指纹。',
  arithmetic: '至少一半相邻项使用同一绝对步长，属于规则序列。',
  low_unique: '不同数字不足二十分之一，像循环少量取值。',
  too_short: '回答太短；请粘贴完整回复，或重新运行该提示。',
  duplicate: '与另一份回答完全相同；三份证据必须彼此独立。',
  too_large: '文本超过 50,000 字符，未处理。',
  invalid_json: 'JSON 无法解析，或不是受支持的单个模型回复。',
  api_tools: '响应包含工具调用、拒答、未完成状态或多条候选，未计分。',
  invalid_array: 'JSON 数组必须只包含整数。',
  invalid_fence: '代码围栏不完整或包含嵌套围栏。',
});

function stripFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return {text};
  const match = /^```(?:json|text|plaintext)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(trimmed);
  if (!match || match[1].includes('```')) return {error: 'invalid_fence'};
  return {text: match[1]};
}

function openAIChatText(data) {
  if (!Array.isArray(data?.choices) || data.choices.length !== 1) return null;
  const choice = data.choices[0];
  const message = choice?.message;
  if (choice?.finish_reason !== 'stop' || message?.role !== 'assistant' || typeof message?.content !== 'string' ||
      !message.content.trim() || message.refusal || message.function_call || message.tool_calls?.length) {
    return {error: 'api_tools'};
  }
  return {text: message.content};
}

function anthropicText(data) {
  if (data?.type !== 'message' || data?.role !== 'assistant' || !Array.isArray(data?.content)) return null;
  if (data.stop_reason !== 'end_turn' || data.content.length !== 1 || data.content[0]?.type !== 'text' ||
      typeof data.content[0]?.text !== 'string' || !data.content[0].text.trim()) return {error: 'api_tools'};
  return {text: data.content[0].text};
}

function openAIResponsesText(data) {
  if (!Array.isArray(data?.output) || (!data.object?.startsWith?.('response') && data.type !== 'response')) return null;
  if (data.status && data.status !== 'completed') return {error: 'api_tools'};
  const messages = data.output.filter(item => item?.type === 'message' && item?.role === 'assistant');
  // A Responses payload may carry a separate reasoning summary item. It has no answer text and is safe
  // to ignore; function/computer/web-search calls are not, because then this was not a direct reply.
  const toolItems = data.output.filter(item => /(?:function|computer|web_search|file_search|tool).*call|(?:function|computer|web_search|file_search)_call/i.test(String(item?.type || '')));
  if (messages.length !== 1 || toolItems.length) return {error: 'api_tools'};
  const blocks = messages[0].content;
  if (!Array.isArray(blocks) || blocks.some(block => block?.type !== 'output_text' || typeof block?.text !== 'string')) return {error: 'api_tools'};
  const text = blocks.map(block => block.text).join('');
  return text.trim() ? {text} : {error: 'api_tools'};
}

/** Extracts only one completed assistant answer. Plain text and flat JSON arrays are accepted. */
export function extractResponseText(input) {
  const raw = typeof input === 'string' ? input : '';
  if (raw.length > INPUT_LIMIT) return {error: 'too_large'};
  const unfenced = stripFence(raw);
  if (unfenced.error) return unfenced;
  const text = unfenced.text;
  const trimmed = text.trim();
  if (!trimmed) return {text: ''};
  if (/^(?:data|event):/i.test(trimmed)) return {error: 'invalid_json'};
  if (trimmed.startsWith('[')) {
    let data;
    try { data = JSON.parse(trimmed); } catch { return {error: 'invalid_json'}; }
    if (!Array.isArray(data) || data.some(value => !Number.isInteger(value))) return {error: 'invalid_array'};
    return {text: data.join(',')};
  }
  if (trimmed.startsWith('{')) {
    let data;
    try { data = JSON.parse(trimmed); } catch { return {error: 'invalid_json'}; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {error: 'invalid_json'};
    return openAIChatText(data) || anthropicText(data) || openAIResponsesText(data) || {error: 'invalid_json'};
  }
  return {text};
}

export function computeGateStats(values, requested = null) {
  const length = values.length;
  const steps = Math.max(0, length - 1);
  let nonDecreasing = 0;
  let nonIncreasing = 0;
  const stepSizes = new Map();
  for (let index = 0; index < steps; index += 1) {
    const delta = values[index + 1] - values[index];
    if (delta >= 0) nonDecreasing += 1;
    if (delta <= 0) nonIncreasing += 1;
    const absolute = Math.abs(delta);
    stepSizes.set(absolute, (stepSizes.get(absolute) || 0) + 1);
  }
  const modalStep = steps ? Math.max(...stepSizes.values()) : 0;
  const uniqueCount = new Set(values).size;
  const expected = Number(requested);
  const minLength = Math.max(80, Number.isFinite(expected) && expected > 0 ? Math.ceil(expected * 0.55) : 80);
  return {
    length,
    unique_count: uniqueCount,
    unique_ratio: length ? uniqueCount / Math.min(length, VALUE_MAX - VALUE_MIN + 1) : 0,
    monotone_fraction: steps ? Math.max(nonDecreasing, nonIncreasing) / steps : 0,
    arithmetic_fraction: steps ? modalStep / steps : 0,
    min_length: minLength,
  };
}

/** First matching gate wins; only level "ok" may be scored. */
export function evaluateGate(values, requested = null) {
  const stats = computeGateStats(values, requested);
  let level = 'ok';
  let rule = null;
  if (stats.length < 1) [level, rule] = ['invalid', 'empty'];
  else if (stats.length >= 2 && stats.unique_count <= 1) [level, rule] = ['invalid', 'constant'];
  else if (stats.length >= 3 && stats.monotone_fraction >= 0.9) [level, rule] = ['invalid', 'monotonic'];
  else if (stats.length >= 3 && stats.arithmetic_fraction >= 0.5) [level, rule] = ['invalid', 'arithmetic'];
  else if (stats.unique_ratio < 0.05) [level, rule] = ['invalid', 'low_unique'];
  else if (stats.length < stats.min_length) [level, rule] = ['insufficient', 'too_short'];
  return {level, rule, message: rule ? GATE_MESSAGES[rule] : null, stats, parsed_numbers: stats.length};
}

/** Parses, gates and de-duplicates the replies without scoring them. */
export function prepareOutputs(outputs) {
  if (!Array.isArray(outputs)) throw new TypeError('outputs must be an array');
  const seen = new Map();
  const normalized = [];
  const checks = outputs.map((output, offset) => {
    const index = offset + 1;
    const expected = Number(output?.expected_count) || null;
    const original = typeof output?.text === 'string' ? output.text : '';
    if (!original.trim()) {
      normalized.push({...output, text: ''});
      return {index, level: 'empty', rule: 'empty', message: null, parsed_numbers: 0, stats: computeGateStats([], expected)};
    }
    const extracted = extractResponseText(original);
    if (extracted.error) {
      normalized.push({...output, text: ''});
      return {index, level: 'invalid', rule: extracted.error, message: GATE_MESSAGES[extracted.error], parsed_numbers: 0, stats: computeGateStats([], expected)};
    }
    const item = {...output, text: extracted.text};
    normalized.push(item);
    const values = parseNumbers(extracted.text);
    const check = {...evaluateGate(values, expected), index};
    if (check.level === 'ok') {
      const signature = values.join(',');
      if (seen.has(signature)) return {...check, level: 'invalid', rule: 'duplicate', message: GATE_MESSAGES.duplicate, duplicate_of: seen.get(signature)};
      seen.set(signature, index);
    }
    return check;
  });
  const usable = normalized.filter((_, index) => checks[index].level === 'ok');
  return {outputs: normalized, checks, usable};
}

const validatedBanks = new WeakSet();
function numericArray(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

/** Rejects malformed or executable-looking remote data before it reaches the scorer. */
export function validateBank(bank) {
  if (!bank || typeof bank !== 'object' || Array.isArray(bank)) throw new Error('指纹库格式无效');
  if (validatedBanks.has(bank)) return bank;
  if (bank.schema !== 'robust-number-fingerprint-bank' || !Array.isArray(bank.models) || bank.models.length < 2 || bank.models.length > 100) throw new Error('指纹库清单无效');
  const ids = bank.models.map(model => model?.id);
  if (ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9@._:-]{1,160}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('指纹库模型 ID 无效');
  if (bank.models.some(model => !numericArray(model.counts, 355))) throw new Error('指纹库分布维度无效');
  const robust = bank.robust;
  const hellinger = robust?.hellinger;
  if (!Array.isArray(robust?.model_order) || robust.model_order.length !== ids.length || robust.model_order.some(id => !ids.includes(id))) throw new Error('指纹库模型顺序无效');
  if (!numericArray(hellinger?.feature_mean, 355) || !numericArray(hellinger?.feature_scale, 355) ||
      !Array.isArray(hellinger?.nuisance_basis) || hellinger.nuisance_basis.some(row => !numericArray(row, 355)) ||
      !Array.isArray(hellinger?.centroids) || hellinger.centroids.length !== ids.length || hellinger.centroids.some(row => !numericArray(row, 355))) throw new Error('指纹库 Hellinger 参数无效');
  const ordered = robust?.ordered_blocks;
  if (!ordered || !numericArray(ordered.feature_mean, 74) || !numericArray(ordered.feature_scale, 74) ||
      !Array.isArray(ordered.centroids) || ordered.centroids.length !== ids.length || ordered.centroids.some(row => !numericArray(row, 74)) ||
      !Array.isArray(ordered.nuisance_basis) || ordered.nuisance_basis.some(row => !numericArray(row, 74)) ||
      !Array.isArray(ordered.environment_centroids) || ordered.environment_centroids.some(env => !Array.isArray(env) || env.length !== ids.length || env.some(row => !numericArray(row, 74)))) throw new Error('指纹库有序特征参数无效');
  for (const key of ['1', '2', '3']) if (!Number.isFinite(Number(bank.calibration?.[key]?.beta))) throw new Error('指纹库校准参数无效');
  validatedBanks.add(bank);
  return bank;
}

function rawCosines(counts, bank) {
  const artifact = bank.robust.hellinger;
  const alpha = 0.5;
  const total = counts.reduce((sum, value) => sum + value, 0) + alpha * counts.length;
  const projected = counts.map((value, index) => (Math.sqrt((value + alpha) / total) - artifact.feature_mean[index]) / artifact.feature_scale[index]);
  for (const vector of artifact.nuisance_basis) {
    let weight = 0;
    for (let index = 0; index < projected.length; index += 1) weight += projected[index] * vector[index];
    for (let index = 0; index < projected.length; index += 1) projected[index] -= weight * vector[index];
  }
  const norm = Math.max(Math.sqrt(projected.reduce((sum, value) => sum + value * value, 0)), 1e-12);
  return artifact.centroids.map(centroid => centroid.reduce((sum, value, index) => sum + (projected[index] / norm) * value, 0));
}

/* v2.9.19/v2.9.20：按模型自举标定的拟合门槛 —— 从该模型自己的参考分布抽同样多的数字，取拟合值的
   q 分位当门槛，替掉「一刀切 0.15」：分布平滑的模型（多数 GPT 系）自身样本的拟合只有 0.17 左右，
   固定 0.15 会误杀一大片正确样本；Claude 家族常在 0.22+ 则不受影响。 */
const fitFloorCache = new WeakMap();
function calibratedFitFloors(bank, evidenceNumbers, answerCount) {
  // 自举必须复现「实际被判定的那个统计量」：逐条余弦取平均 + 池化余弦加权。
  // 旧版只抽一份 N 条样本算一次余弦，与多答混合统计量分布不符（后者系统性偏低），
  // 结果门槛只能压得很低，漂移样本由此漏过。
  const answers = Math.max(1, Math.min(3, Math.round(answerCount) || 1));
  const perAnswer = Math.max(60, Math.round((Number(evidenceNumbers) || 298) / answers / 5) * 5);
  const key = `${answers}:${perAnswer}`;
  // 缓存键带上标定参数：参数变了必须重算（同名证据量下的不同分位/权重是不同门槛）。
  const cacheKey = `${key}:${TUNING.fitQuantile}:${TUNING.fitDraws}:${TUNING.poolWeight}`;
  let cache = fitFloorCache.get(bank);
  if (!cache) { cache = new Map(); fitFloorCache.set(bank, cache); }
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let seed = 0x9e3779b9;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const index = new Map(bank.robust.model_order.map((id, position) => [id, position]));
  const buckets = new Map();
  for (const model of bank.models) {
    const counts = model?.counts;
    if (!Array.isArray(counts) || counts.length !== 355) continue;
    const cumulative = new Float64Array(355);
    let total = 0;
    for (let i = 0; i < 355; i += 1) { total += (Number(counts[i]) || 0) + 0.5; cumulative[i] = total; }
    const values = [];
    for (let draw = 0; draw < (TUNING.fitDraws || 20); draw += 1) {
      const answerFits = [];
      let pooled = null;
      for (let answer = 0; answer < answers; answer += 1) {
        const sample = new Array(355).fill(0);
        for (let k = 0; k < perAnswer; k += 1) {
          const target = rnd() * total;
          let lo = 0, hi = 354;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] < target) lo = mid + 1; else hi = mid; }
          sample[lo] += 1;
        }
        answerFits.push(rawCosines(sample, bank)[index.get(model.id)]);
        pooled = pooled ? pooled.map((value, position) => value + sample[position]) : sample;
      }
      let value = answerFits.reduce((sum, item) => sum + item, 0) / answerFits.length;
      if (answers > 1) value = (1 - TUNING.poolWeight) * value + TUNING.poolWeight * rawCosines(pooled, bank)[index.get(model.id)];
      if (Number.isFinite(value)) values.push(value);
    }
    if (!values.length) continue;
    values.sort((left, right) => left - right);
    const quantile = values[Math.min(values.length - 1, Math.floor(values.length * (TUNING.fitQuantile || 0.05)))];
    const bare = bareModel(model.id);
    const bucket = buckets.get(bare) || [];
    bucket.push(quantile);
    buckets.set(bare, bucket);
  }
  const floors = new Map([...buckets].map(([id, list]) => [id, list.reduce((sum, value) => sum + value, 0) / list.length]));
  cache.set(cacheKey, floors);
  return floors;
}

export const bareModel = id => String(id).split('@', 1)[0];

function makeVerdict(attribution, countsList, bank, shrinkage = 0) {
  const perAnswer = countsList.map(counts => rawCosines(counts, bank));
  // v2.5.0 池化通道：把同一会话的多条证据合并成一份更大的经验分布（样本 300 → 约 900）再算一次
  // 余弦；与「逐条余弦取平均」各占一半 —— 抽样噪声更低，排名更稳。
  const pooled = countsList.length > 1
    ? rawCosines(countsList[0].map((_, index) => countsList.reduce((sum, counts) => sum + counts[index], 0)), bank)
    : null;
  const means = Object.fromEntries(bank.robust.model_order.map((id, index) => [
    id,
    perAnswer.reduce((sum, answer) => sum + answer[index], 0) / perAnswer.length,
  ]));
  const fits = Object.fromEntries(bank.robust.model_order.map((id, index) => [
    id,
    pooled ? (1 - TUNING.poolWeight) * means[id] + TUNING.poolWeight * pooled[index] : means[id],
  ]));
  const pooledById = pooled ? Object.fromEntries(bank.robust.model_order.map((id, index) => [id, pooled[index]])) : null;
  const metadata = Object.fromEntries(bank.models.map(model => [model.id, model]));
  const groups = new Map();
  for (const item of attribution.results) {
    const id = bareModel(item.model);
    const meta = metadata[item.model] || {};
    if (!groups.has(id)) groups.set(id, {
      id,
      display_name: String(meta.display_name || item.display_name || id).split('@', 1)[0],
      family: item.family || meta.family || 'models',
      family_name: item.family_name || meta.family_name || item.family || 'models',
      probability: 0,
      fit: -Infinity,
      channels: [],
    });
    const group = groups.get(id);
    group.probability += item.probability;
    group.channels.push(item.model.includes('@') ? item.model.slice(item.model.indexOf('@') + 1) : 'reference');
    group.fit = Math.max(group.fit, fits[item.model]);
  }
  const candidates = [...groups.values()].sort((left, right) => right.probability - left.probability);
  const top = candidates[0];
  const alternativeFit = candidates.length > 1 ? Math.max(...candidates.slice(1).map(item => item.fit)) : 0;
  const familyProbability = candidates.filter(item => item.family === top.family).reduce((sum, item) => sum + item.probability, 0);
  const forTop = map => {
    const values = Object.keys(map).filter(key => bareModel(key) === top.id).map(key => map[key]);
    return values.length ? Math.max(...values) : null;
  };
  const signals = {
    fit: top.fit,
    separation: top.fit - alternativeFit,
    family_probability: familyProbability,
    relative_probability: top.probability,
    query_count: countsList.length,
    fit_mean: forTop(means),
    fit_pooled: pooledById ? forTop(pooledById) : null,
    pooled: !!pooled,
    evidence_numbers: countsList.reduce((sum, counts) => sum + counts.reduce((total, value) => total + value, 0), 0),
  };
  // v2.8.1 开集判据：似然比置信集 + 同族混合检验（详见 modeltrace-core.js 的 openSetDecision）。
  const decision = openSetDecision(countsList, bank, TUNING.lrDelta, shrinkage);
  const setIds = [...new Set(decision.set.map(bareModel))];
  const setNames = setIds.map(id => String(metadata[id]?.display_name || id).split('@', 1)[0]);
  let status;
  let reason;
  // v2.9.19/v2.9.20：fit 门槛不再一刀切，按该模型自举样本的 fit 分位标定。
  let fitFloor = TUNING.fitFloor;
  if (TUNING.fitMode === 'calibrated') {
    const own = calibratedFitFloors(bank, signals.evidence_numbers, countsList.length).get(top.id);
    if (Number.isFinite(own)) fitFloor = Math.max(TUNING.fitHardFloor || 0, Math.min(fitFloor, own));
  }
  signals.fit_floor = fitFloor;
  if (signals.fit < fitFloor) [status, reason] = ['weak', 'fit_below_floor'];
  else if (signals.separation >= TUNING.separation) [status, reason] = ['clear', 'clear_separation'];
  else if (signals.family_probability >= TUNING.family) [status, reason] = ['close', 'family_only'];
  else [status, reason] = ['weak', 'family_unclear'];
  // 统计上与近亲分不开时不许给「清晰匹配」：降级为 close，交给 UI 显示家族 + 候选集。
  if (status === 'clear' && setIds.length > 1) [status, reason] = ['close', 'tied_with_relatives'];
  // v2.9.21 统计层：fit 统计量的自举零分布检验（BH 校正 → 相容集合）、留出验证、证据同质性。
  const statIndex = new Map(bank.robust.model_order.map((id, position) => [id, position]));
  const fitStatistic = lists => {
    const perAnswer = lists.map(counts => rawCosines(counts, bank));
    const pooledCounts = lists.length > 1 ? lists[0].map((_, position) => lists.reduce((sum, counts) => sum + counts[position], 0)) : null;
    const pooledCosines = pooledCounts ? rawCosines(pooledCounts, bank) : null;
    return bank.models.map(model => {
      const position = statIndex.get(model.id) ?? 0;
      const meanFit = perAnswer.reduce((sum, row) => sum + row[position], 0) / perAnswer.length;
      return pooledCosines ? (1 - TUNING.poolWeight) * meanFit + TUNING.poolWeight * pooledCosines[position] : meanFit;
    });
  };
  let tests = null;
  let verification = null;
  let homogeneity = null;
  if (TUNING.statMode && TUNING.statMode !== 'off') {
    const statOptions = {
      statistic: fitStatistic,
      poolWeight: TUNING.poolWeight,
      draws: TUNING.statDraws,
      seed: TUNING.statSeed,
      alpha: TUNING.statAlpha,
      maxSpread: TUNING.statSpread,
    };
    tests = fitTests(countsList, bank, statOptions);
    const selectedIndex = bank.models.findIndex(model => model.id === tests.best);
    if (selectedIndex >= 0) {
      const held = countsList.slice(1);
      if (held.length) {
        const verify = fitTestForModel(held, bank, selectedIndex, statOptions);
        verification = {...verify, applicable: true, alpha: TUNING.verifyAlpha, verified: verify.p > TUNING.verifyAlpha};
      } else {
        verification = {applicable: false};
      }
      homogeneity = evidenceHomogeneity(countsList, bank, selectedIndex, statOptions);
    }
    // 分离度的校准检验：top（按 fit）与其最强替代者之间的 gap 零分布（v2.9.21）。
    const entryFor = bareId => bank.robust.model_order.reduce(
      (best, id) => (bareModel(id) === bareId && (best === null || fits[id] > fits[best]) ? id : best), null);
    const topEntry = entryFor(top.id);
    const altEntry = bank.robust.model_order
      .filter(id => bareModel(id) !== top.id)
      .reduce((best, id) => (best === null || fits[id] > fits[best] ? id : best), null);
    if (topEntry) {
      const modelIndexById = new Map(bank.models.map((model, position) => [model.id, position]));
      const separationTest = fitGapTest(
        countsList, bank, modelIndexById.get(topEntry) ?? -1, altEntry ? modelIndexById.get(altEntry) ?? -1 : -1,
        {...statOptions, alpha: TUNING.statAlpha},
      );
      signals.separation_test = separationTest.applicable ? {
        gap: Number(separationTest.gap.toFixed(4)),
        z: Number(separationTest.z.toFixed(2)),
        p_upper: separationTest.p_upper,
        significant: separationTest.significant,
        draws: separationTest.draws,
      } : null;
    } else {
      signals.separation_test = null;
    }

    if (TUNING.statMode === 'fusion' && status === 'clear') {
      // 库里没有任何参考能容纳这份观测（连最相容的都不相容）→ 「最近的名字」不是证据，最多算 close。
      if (tests.rejected_all) [status, reason] = ['close', 'stats_rejected_all_references'];
      // 留出证据对选中模型显著偏低 → 现场不是这个版本（或参考已漂移）。
      else if (verification && verification.applicable && verification.verified === false) [status, reason] = ['close', 'stats_held_out_failed'];
      // 多条证据在同模型零分布下互不同质 → 疑似混合路由/漂移，不给 clear。
      else if (homogeneity && homogeneity.applicable && !homogeneity.homogeneous) [status, reason] = ['close', 'stats_evidence_heterogeneous'];
    }
    // statPromote：唯一相容 + 拟合不低时把 close 提升为 clear（默认关闭，等现场标定再开）。
    if (TUNING.statMode === 'fusion' && TUNING.statPromote && status !== 'clear' &&
        tests.unique && bareModel(tests.best) === top.id && tests.best_z > 0 && signals.fit >= fitFloor) {
      [status, reason] = ['clear', 'stats_unique_compatible'];
    }
  }
  if (tests) {
    signals.tests = {
      alpha: tests.alpha,
      models: tests.models,
      observed: tests.observed,
      sizes: tests.sizes,
      best: bareModel(tests.best),
      best_z: Number(tests.best_z.toFixed(2)),
      best_p: tests.best_p,
      best_p_adjusted: tests.best_p_adjusted,
      nearest_fit: tests.nearest_fit ? bareModel(tests.nearest_fit) : null,
      runner_up: tests.runner_up ? bareModel(tests.runner_up) : null,
      runner_up_z: Number((tests.runner_up_z || 0).toFixed(2)),
      z_gap: Number.isFinite(tests.z_gap) ? Number(tests.z_gap.toFixed(2)) : null,
      set_size: tests.set_size,
      set_ids: [...new Set(tests.set_ids.map(bareModel))],
      rejected_all: tests.rejected_all,
      unique: tests.unique,
      match_nearest: tests.nearest_fit ? bareModel(tests.nearest_fit) === top.id : false,
    };
  } else {
    signals.tests = null;
  }
  signals.verification = verification;
  signals.homogeneity = homogeneity;
  signals.decision = {
    set_size: setIds.length,
    set_ids: setIds,
    set_names: setNames,
    best: bareModel(decision.best),
    mixture: decision.mixture ? {
      names: decision.mixture.models.map(id => String(metadata[id]?.display_name || id).split('@', 1)[0]),
      weight: decision.mixture.weight,
      gain: Number(decision.mixture.gain.toFixed(2)),
    } : null,
    // 混合检验只能说明「现场分布不是库里任何单一参考」，混合路由与参考库漂移无法区分，故仅作提示。
    off_reference: !!decision.mixture,
    evidence_numbers: decision.evidence,
  };
  const top3 = candidates.slice(0, 3).map(item => ({id: item.id, display_name: item.display_name, family: item.family, fit: item.fit, probability: item.probability}));
  const familyTally = new Map();
  for (const item of candidates) familyTally.set(item.family_name, (familyTally.get(item.family_name) || 0) + item.probability);
  const familyTotal = candidates.reduce((sum, item) => sum + item.probability, 0) || 1;
  const topFamily = [...familyTally.entries()].sort((left, right) => right[1] - left[1])[0] || ['models', 0];
  return {status, reason, nearest: top, signals, candidates, top3, decision: signals.decision, top_family: {name: topFamily[0], probability: topFamily[1] / familyTotal}};
}

/** Scores an already prepared set. `nearest` 始终给出最近参考，但 v2.8.1 起 UI 按 signals.decision
    显示：置信集 >1 -> 家族 + 候选集；混合/漂移 -> 挂提示；weak -> 未定。status 仍限定可靠度。 */
export function identifyPrepared(prepared, bank, options = {}) {
  validateBank(bank);
  if (!prepared?.usable?.length) throw new Error('没有可计分的回答');
  const attribution = analyzeGlobalOutputs(prepared.usable, bank);
  const countsList = prepared.usable.map(output => countNumbers(parseNumbers(output.text)));
  const verdict = makeVerdict(attribution, countsList, bank, Number(options?.shrinkage) || 0);
  return {
    ...verdict,
    used_outputs: prepared.usable.length,
    checks: prepared.checks,
    calibration: attribution.calibration,
    bank_models: bank.models.length,
  };
}

export function inspectAndIdentify(outputs, bank) {
  const prepared = prepareOutputs(outputs);
  return {prepared, result: prepared.usable.length ? identifyPrepared(prepared, bank) : null};
}
