/* lmfpd 第二指纹通道（对照用，不参与主指纹的 status/改名判定）。
   评分核移植自 lmfpd-sdk 0.2.0（MIT，https://github.com/Ikaleio/lm-detector ，
   shared-detector-v2 ranker）；hellingerFeature / orderedBlockFeature /
   parseNumbers / countNumbers 与 modeltrace-core.js 同源同实现，直接复用。
   参考数据随包内置在 lmfpd-data/（tools/fetch-lmfpd-data.mjs 刷新），运行时不走网络。 */
import {parseNumbers, countNumbers, hellingerFeature, orderedBlockFeature} from './modeltrace-core.js';

/* ---------- 序列/位置特征（上游 shared-detector.ts + positional 头） ---------- */

const POSITIONAL_WEIGHTS = [0.6, 0.15, 0.125, 0.125];
const CENTRES = Array.from({length: 24}, (_, i) => 1 + i * 354 / 23);
const LAGS = [1, 2, 3, 5, 8, 13, 21, 34];
const mean = values => values.reduce((sum, x) => sum + x, 0) / values.length;
const fraction = (length, test) => {
  let hits = 0;
  for (let i = 0; i < length; i++) if (test(i)) hits++;
  return hits / length;
};

function positionKernel(x) {
  const n = x.length, out = Array(34 * 3).fill(0);
  x.forEach((value, position) => {
    const t = (position + 0.5) * 2 / n - 1, basis = [t, 0.5 * (3 * t * t - 1), 0.5 * (5 * t ** 3 - 3 * t)];
    const features = [
      ...CENTRES.map(centre => Math.exp(-0.5 * ((value - centre) / 20) ** 2)),
      ...Array.from({length: 10}, (_, digit) => digit === value % 10 ? 1 : 0),
    ];
    features.forEach((weight, k) => basis.forEach((b, j) => {
      out[k * 3 + j] += weight * b / n;
    }));
  });
  return out;
}

function centredTransitions(symbols, bins) {
  const joint = Array(bins * bins).fill(0.5), total = symbols.length - 1 + 0.5 * bins * bins;
  for (let i = 1; i < symbols.length; i++) joint[symbols[i - 1] * bins + symbols[i]] += 1;
  for (let i = 0; i < joint.length; i++) joint[i] /= total;
  const rows = Array.from({length: bins}, (_, a) => joint.slice(a * bins, a * bins + bins).reduce((s, v) => s + v, 0));
  const columns = Array.from({length: bins}, (_, b) => rows.reduce((s, _, a) => s + joint[a * bins + b], 0));
  return joint.map((value, i) => value - rows[Math.floor(i / bins)] * columns[i % bins]);
}

function sequenceFeatures(x) {
  const n = x.length, m = mean(x), sd = Math.max(Math.sqrt(mean(x.map(v => (v - m) ** 2))), 1);
  const s = x.map(v => (v - m) / sd), out = [];
  for (const lag of LAGS) {
    const count = n - lag, d = Array.from({length: count}, (_, i) => x[i + lag] - x[i]);
    out.push(mean(d.map((_, i) => s[i + lag] * s[i])), mean(d.map(Math.abs)) / 355, fraction(count, i => d[i] > 0), fraction(count, i => d[i] === 0), fraction(count, i => Math.abs(d[i]) <= 5), fraction(count, i => Math.abs(d[i]) <= 20));
  }
  out.push(...centredTransitions(x.map(v => Math.min(7, Math.floor((v - 1) * 8 / 355))), 8));
  out.push(...centredTransitions(x.map(v => v % 10), 10));
  const difference = Array.from({length: n - 1}, (_, i) => x[i + 1] - x[i]);
  const zStep = Array.from({length: n - 1}, (_, i) => Math.abs(s[i + 1] - s[i]));
  out.push(fraction(n - 2, i => Math.sign(difference[i + 1]) === Math.sign(difference[i])), fraction(n - 2, i => difference[i + 1] === difference[i]), fraction(n - 1, i => x[i] % 10 === x[i + 1] % 10), fraction(n - 1, i => zStep[i] > 1), fraction(n - 1, i => zStep[i] > 2));
  const buckets = x.map(v => Math.min(15, Math.floor((v - 1) * 16 / 355)));
  for (const width of [4, 8, 16]) {
    let sum = 0;
    for (let i = 0; i + width <= n; i++) sum += new Set(buckets.slice(i, i + width)).size / width;
    out.push(sum / (n - width + 1));
  }
  return out;
}

function positionalFeatures(numbers) {
  return [hellingerFeature(countNumbers(numbers)), orderedBlockFeature(numbers), positionKernel(numbers), sequenceFeatures(numbers)];
}

function positionalDecision(numbers, head) {
  const parts = positionalFeatures(numbers);
  const x = parts.flatMap((block, j) => {
    const p = head.params[j], scaled = block.map((v, i) => (v - p.mean[i]) / p.scale[i]);
    const length = Math.max(Math.sqrt(scaled.reduce((sum, v) => sum + v * v, 0)), 0.000000000001);
    return scaled.map(v => v / length * Math.sqrt(POSITIONAL_WEIGHTS[j]));
  });
  return head.weights.map((row, k) => row.reduce((sum, w, i) => sum + w * x[i], head.bias[k]));
}

/* ---------- shared-detector-v2 排名器 ---------- */

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const mean2 = a => a.reduce((sum, x) => sum + x, 0) / a.length;
const norm = a => {
  const n = Math.max(Math.sqrt(dot(a, a)), 0.000000000001);
  return a.map(x => x / n);
};
const z = a => {
  const m = mean2(a), s = Math.max(Math.sqrt(mean2(a.map(x => (x - m) ** 2))), 0.000000000001);
  return a.map(x => (x - m) / s);
};
const columnMean = a => a[0].map((_, i) => mean2(a.map(r => r[i])));
const median = a => {
  const v = [...a].sort((x, y) => x - y), i = Math.floor(v.length / 2);
  return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
};
const blocks = n => [hellingerFeature(countNumbers(n)), orderedBlockFeature(n)];
const transform = (b, p) => b.flatMap((v, j) => norm(v.map((x, i) => (x - p[j].mean[i]) / p[j].scale[i])).map(x => x * Math.sqrt(j === 0 ? 0.75 : 0.25)));
const centered = (v, p) => v.map((x, i) => (x - p.feature_mean[i]) / p.feature_scale[i]);
const subtract = (v, b) => {
  const coefficients = b.map(row => dot(v, row));
  return v.map((x, i) => x - b.reduce((sum, row, j) => sum + coefficients[j] * row[i], 0));
};
const referenceNorms = new WeakMap;

function nearest(x, references) {
  let norms = referenceNorms.get(references);
  if (!norms) {
    norms = references.map(r => dot(r, r));
    referenceNorms.set(references, norms);
  }
  const xx = dot(x, x);
  return mean2(references.map((r, i) => Math.max(0, xx + norms[i] - 2 * dot(x, r))).sort((a, b) => a - b).slice(0, 7));
}

function baseline(b, bank) {
  const {hellinger: h, ordered_blocks: o} = bank;
  const hUnit = norm(subtract(centered(b[0], h), h.nuisance_basis));
  const marginal = h.centroids.map(row => dot(hUnit, row));
  const oCentered = centered(b[1], o), raw = norm(oCentered), projected = norm(subtract(oCentered, o.nuisance_basis));
  const templates = o.centroids.map((_, i) => Math.max(...o.environment_centroids.map(rows => dot(raw, rows[i]))));
  const nuisance = o.centroids.map(row => dot(projected, row));
  const tz = z(templates), nz = z(nuisance), ordered = z(tz.map((v, i) => 0.5 * v + 0.5 * nz[i])), mz = z(marginal);
  return mz.map((v, i) => 0.5 * v + 0.5 * ordered[i]);
}

export function lmfpdBankMatches(bank, artifact) {
  return artifact?.schema === 'shared-detector-v2' && bank?.built_at === artifact.bank_built_at &&
    bank?.models?.length === artifact.model_ids?.length &&
    bank.models.every((m, i) => m.id === artifact.model_ids[i] && m.response_count === artifact.response_counts[i]);
}

function calibrateRanking(ranking, artifact) {
  const head = artifact.calibration, binding = head?.binding;
  if (!head || !binding || head.schema !== 'shared-confidence-v2' || head.method !== 'ranking-temperature' ||
      !Number.isFinite(head.tau) || head.tau < 0.001 || head.tau > 1000 ||
      binding.base_sha256 !== artifact.base_sha256 || binding.reference_sha256 !== artifact.source_reference_sha256 ||
      binding.model_ids.length !== ranking.length || ranking.length !== artifact.model_ids.length ||
      !ranking.every(Number.isFinite) || !binding.model_ids.every((id, i) => id === artifact.model_ids[i])) return null;
  const logits = ranking.map(score => head.tau * score);
  const maximum = Math.max(...logits), weights = logits.map(value => Math.exp(value - maximum)), sum = weights.reduce((a, b) => a + b, 0);
  return weights.map(value => value / sum);
}

function rankSharedNumbers(numbers, artifact) {
  const a = artifact.ranker, full = numbers.map(blocks);
  const ax = full.map(b => transform(b, a.full_params));
  const lda = numbers.map(n => {
    const x = transform(blocks(n.slice(0, 128)), a.head_params);
    return z(a.lda_weights.map((row, i) => dot(row, x) + a.lda_bias[i]));
  });
  const l = z(columnMean(lda)), near = z(a.references.map(ref => median(ax.map(x => -nearest(x, ref)))));
  const base = z(columnMean(full.map(b => baseline(b, a.bank))));
  const frequency = z(l.map((x, i) => 0.5 * x + 0.25 * near[i] + 0.25 * base[i]));
  const positional = z(columnMean(numbers.map(n => z(positionalDecision(n, a.positional)))));
  const ranking = frequency.map((x, i) => a.blend.frequency * x + a.blend.positional * positional[i]);
  if (!ranking.every(Number.isFinite)) throw new Error('排名计算产生无效数值');
  return ranking;
}

const SEQUENCE_LIMITS = {autocorrelation: -0.23, small_step_share: 0.05};

function sequenceShape(numbers) {
  const shapes = numbers.map(n => {
    const m = mean2(n), variance = mean2(n.map(x => (x - m) ** 2)), steps = n.slice(1).map((x, i) => x - n[i]);
    return {
      autocorrelation: variance ? mean2(steps.map((_, i) => (n[i + 1] - m) * (n[i] - m))) / variance : 1,
      small_step_share: mean2(steps.map(d => Math.abs(d) <= 20 ? 1 : 0)),
    };
  });
  const autocorrelation = median(shapes.map(s => s.autocorrelation)), small_step_share = median(shapes.map(s => s.small_step_share));
  return {
    autocorrelation,
    small_step_share,
    model_like: autocorrelation <= SEQUENCE_LIMITS.autocorrelation || small_step_share <= SEQUENCE_LIMITS.small_step_share,
  };
}

const minimumNumbers = expected => Math.max(80, Math.ceil(expected * 0.55));

/* 上游 analyzeSharedOutputs 原样移植（allowPartial 分支保留；证据文案本来就是中文，
   不走 SDK 的 englishAnalysis 英文包装）。 */
function analyzeSharedOutputs(outputs, bank, artifact, options = {}) {
  if (!lmfpdBankMatches(bank, artifact)) throw new Error('参考库与检测器不匹配');
  const parsed = outputs.map(o => parseNumbers(o.text));
  const diagnostics = outputs.map((o, index) => {
    const minimum = Math.max(80, Math.ceil((o.expected_count || 0) * 0.55));
    const raw = Array.from(o.text.matchAll(/-?\d+/g), m => Number(m[0]));
    return {
      index,
      parsed_numbers: parsed[index].length,
      minimum_numbers: minimum,
      accepted: parsed[index].length >= minimum,
      raw_out_of_range_count: raw.filter(n => n < 1 || n > 355).length,
    };
  });
  const used = diagnostics.filter(d => d.accepted).length;
  const accepted = parsed.filter((_, i) => diagnostics[i].accepted);
  const sequence = used ? sequenceShape(accepted) : null;
  const common = {
    probability: null,
    probability_status: 'unavailable',
    used_outputs: used,
    diagnostics,
    sequence,
    method: 'shared-detector-v2',
    model_version: {base_sha256: artifact.base_sha256},
  };
  const notModel = {
    ...common,
    prediction: '',
    prediction_name: '不像语言模型回答',
    family_prediction_name: '',
    results: [],
    decision: 'not_model',
    evidence: {
      insufficient: true,
      label: '不像语言模型回答',
      reason: '相邻数字的变化方式与参考库中的语言模型回答不同，常见于程序生成、排序或打乱顺序的数字。未生成排名。',
      threshold: null,
      method: 'sequence-shape',
    },
  };
  if (options.allowPartial && used > 0 && used < 3 && outputs.length <= 3) {
    if (!sequence.model_like) return notModel;
    const ranking = rankSharedNumbers(accepted, artifact);
    const order = artifact.model_ids.map((_, i) => i).sort((i, j) => ranking[j] - ranking[i]);
    const results = order.map(i => ({
      model: artifact.model_ids[i],
      display_name: bank.models[i].display_name,
      family: bank.models[i].family,
      family_name: bank.models[i].family_name,
      score: ranking[i],
      probability: null,
    }));
    const first = order[0];
    return {
      ...common,
      method: 'shared-ranker-partial-v1',
      decision: 'partial',
      prediction: results[0].model,
      prediction_name: results[0].display_name,
      family_prediction: bank.models[first].family,
      family_prediction_name: bank.models[first].family_name,
      results,
      ranking_score: ranking[first],
      calibration: null,
      evidence: {
        insufficient: true,
        label: '部分样本排名',
        reason: `使用 ${used}/3 条有效回答生成排名。补齐三条有效回答后才能计算置信度。`,
        threshold: null,
        method: 'partial-sample-ranking',
      },
    };
  }
  if (outputs.length !== 3 || used !== 3) {
    return {
      ...common,
      prediction: '',
      prediction_name: '暂不可评分',
      family_prediction_name: '',
      results: [],
      decision: 'unscorable',
      evidence: {
        insufficient: true,
        label: '需要三条完整回答',
        reason: `当前有 ${used}/${outputs.length} 条有效回答。请补齐原来的三条回答后重新检测。`,
        threshold: null,
        method: 'complete-three-answers',
      },
    };
  }
  if (!sequence.model_like) return notModel;
  const ranking = rankSharedNumbers(parsed, artifact);
  const probabilities = calibrateRanking(ranking, artifact);
  const order = artifact.model_ids.map((_, i) => i).sort((i, j) => ranking[j] - ranking[i]);
  const results = order.map(i => ({
    model: artifact.model_ids[i],
    display_name: bank.models[i].display_name,
    family: bank.models[i].family,
    family_name: bank.models[i].family_name,
    score: ranking[i],
    probability: probabilities?.[i] ?? null,
  }));
  const first = order[0];
  return {
    ...common,
    prediction: results[0].model,
    prediction_name: results[0].display_name,
    family_prediction: bank.models[first].family,
    family_prediction_name: bank.models[first].family_name,
    results,
    ranking_score: ranking[first],
    probability: results[0].probability,
    probability_status: probabilities ? 'reference_calibrated' : 'unavailable',
    probability_scope: probabilities ? 'reference-closed-set' : null,
    calibration: probabilities ? {
      method: artifact.calibration.method,
      run: artifact.calibration.calibration_run,
      tau: artifact.calibration.tau,
      sha256: artifact.calibration_sha256 ?? null,
    } : null,
    evidence: {
      insufficient: true,
      label: probabilities ? '库内校准排名' : '未校准排名',
      reason: probabilities ? '置信度是参考库内的闭集相对概率，不包含库外模型。' : '校准参数与当前检测器不匹配，置信度不可用。候选顺序由排名分数决定。',
      threshold: null,
      method: probabilities ? 'reference-calibrated-ranking' : 'uncalibrated-ranking',
    },
  };
}

/* 对外入口：等价于 SDK analyze() 的非严格模式（截断超额数字、不足条数置空、allowPartial）。 */
export function analyzeLmfpdOutputs(outputs, bank, artifact) {
  if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > 3 ||
      !outputs.every(item => item && typeof item.text === 'string' && Number.isSafeInteger(item.expected_count) && item.expected_count > 0)) {
    throw new Error('每轮需要 1–3 条带 text 与 expected_count 的回答');
  }
  const prepared = outputs.map(({text, expected_count}) => {
    const numbers = parseNumbers(text);
    if (numbers.length > expected_count) text = numbers.slice(0, expected_count).join(', ');
    if (numbers.length < minimumNumbers(expected_count)) text = '';
    return {text, expected_count};
  });
  /* 上游 scored 分支不显式写 decision，由 SDK canonicalAnalysis 缺省为 'scored'；这里在边界补上。 */
  const analysis = analyzeSharedOutputs(prepared, bank, artifact, {allowPartial: true});
  return analysis.decision ? analysis : {...analysis, decision: 'scored'};
}

/* ---------- shared_detector.bin 解码（上游 shared/detector-codec.ts） ---------- */

export function decodeLmfpdDetector(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLength = view.getUint32(0, true), start = Math.ceil((4 + headerLength) / 4) * 4;
  const count = (data.length - start) / 4;
  const raw = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) for (let b = 0; b < 4; b++) raw[i * 4 + b] = data[start + b * count + i];
  const little = new DataView(raw.buffer), floats = new Float32Array(count);
  for (let i = 0; i < count; i++) floats[i] = little.getFloat32(i * 4, true);
  return JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + headerLength)), (_, value) =>
    value && typeof value === 'object' && ('$f32' in value) ? Array.from(floats.subarray(value.$f32, value.$f32 + value.n)) : value);
}

/* ---------- 数据加载：随包内置，SW 内一次性 fetch + Promise 缓存 ---------- */

let channelPromise = null;

export function loadLmfpdChannel() {
  if (channelPromise) return channelPromise;
  channelPromise = (async () => {
    const bankUrl = chrome.runtime.getURL('lmfpd-data/unified_bank.json');
    const binUrl = chrome.runtime.getURL('lmfpd-data/shared_detector.bin');
    const [bankResponse, binResponse] = await Promise.all([fetch(bankUrl), fetch(binUrl)]);
    if (!bankResponse.ok || !binResponse.ok) throw new Error(`lmfpd 数据读取失败 HTTP ${bankResponse.status}/${binResponse.status}`);
    const bank = await bankResponse.json();
    const detector = decodeLmfpdDetector(new Uint8Array(await binResponse.arrayBuffer()));
    if (!lmfpdBankMatches(bank, detector)) throw new Error('lmfpd 参考库与检测器不匹配');
    return {bank, detector, builtAt: bank.built_at};
  })();
  channelPromise.catch(() => { channelPromise = null; });
  return channelPromise;
}

/* ---------- 与主指纹结果的对照摘要 ---------- */

const normModelId = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 把 lmfpd 分析压缩成浮层一行展示用的对象；agreement 对比主指纹最近候选。 */
export function lmfpdSummary(analysis, primary) {
  const top = analysis?.results?.[0] || null;
  let agreement = '无有效排名';
  if (analysis?.decision === 'not_model') agreement = 'lmfpd 判非模型序列';
  else if (top) {
    if (normModelId(top.model) === normModelId(primary?.id)) agreement = 'lmfpd 一致';
    else if (normModelId(top.family) === normModelId(primary?.family)) agreement = 'lmfpd 同族';
    else agreement = 'lmfpd 不一致';
  }
  return {
    decision: analysis?.decision || 'unscorable',
    prediction: analysis?.prediction || '',
    prediction_name: analysis?.prediction_name || '',
    family_prediction_name: analysis?.family_prediction_name || '',
    probability: Number.isFinite(analysis?.probability) ? analysis.probability : null,
    probability_status: analysis?.probability_status || 'unavailable',
    used_outputs: Number(analysis?.used_outputs) || 0,
    sequence_model_like: analysis?.sequence ? analysis.sequence.model_like === true : null,
    top3: (analysis?.results || []).slice(0, 3).map(item => ({
      model: item.model, display_name: item.display_name, family_name: item.family_name,
      score: item.score, probability: item.probability,
    })),
    agreement,
  };
}
