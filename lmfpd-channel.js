/* lm.ikale.io（Fingerpoint Detector / lmfpd）主数字指纹引擎。
   评分核移植自 lmfpd-sdk（MIT，https://github.com/Ikaleio/lm-detector ，
   shared-detector-v2 ranker + nearby_pair_share 序列门）；
   hellingerFeature / orderedBlockFeature / parseNumbers / countNumbers 与 modeltrace-core.js 同源同实现。
   参考数据随包内置在 lmfpd-data/（tools/fetch-lmfpd-data.mjs 刷新），并支持插件内在线一键刷新并持久化到 IndexedDB。 */
import {parseNumbers, countNumbers, hellingerFeature, orderedBlockFeature} from './modeltrace-core.js';
import {decompress as zstdDecompress} from './fzstd.js';

export const LMFPD_LOW_CONFIDENCE_THRESHOLD = 0.75;
export const LMFPD_ASTRA_SHARED_ID = 'gpt-6-astra';
export const LMFPD_SOURCES = Object.freeze([
  'https://lm.ikale.io/data/',
  'https://cdn.jsdmirror.com/npm/lmfpd-data@latest/',
]);

const DB_NAME = 'amp-lmfpd-cache-v1';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'latest';
const MAX_PACKED_BYTES = 25 * 1024 * 1024;
const MAX_DETECTOR_BYTES = 32 * 1024 * 1024;

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

const SEQUENCE_LIMITS = {autocorrelation: -0.23, small_step_share: 0.05, nearby_pair_share: 0.07};

function nearbyPairShare(numbers) {
  let hits = 0;
  let total = 0;
  for (let lag = 1; lag <= 3; lag += 1) {
    for (let i = lag; i < numbers.length; i += 1) {
      if (Math.abs(numbers[i] - numbers[i - lag]) <= 20) hits += 1;
      total += 1;
    }
  }
  return total ? hits / total : 1;
}

function sequenceShape(numbers) {
  const shapes = numbers.map(n => {
    const m = mean2(n), variance = mean2(n.map(x => (x - m) ** 2)), steps = n.slice(1).map((x, i) => x - n[i]);
    return {
      autocorrelation: variance ? mean2(steps.map((_, i) => (n[i + 1] - m) * (n[i] - m))) / variance : 1,
      small_step_share: mean2(steps.map(d => Math.abs(d) <= 20 ? 1 : 0)),
    };
  });
  const autocorrelation = median(shapes.map(s => s.autocorrelation));
  const small_step_share = median(shapes.map(s => s.small_step_share));
  const nearby_pair_share = median(numbers.map(nearbyPairShare));
  return {
    autocorrelation,
    small_step_share,
    nearby_pair_share,
    model_like: autocorrelation <= SEQUENCE_LIMITS.autocorrelation ||
      small_step_share <= SEQUENCE_LIMITS.small_step_share ||
      nearby_pair_share <= SEQUENCE_LIMITS.nearby_pair_share,
  };
}

const minimumNumbers = expected => Math.max(80, Math.ceil(expected * 0.55));

/** 与 lm.ikale.io 前端 ru() 一致：检查有效样本中是否存在最小值 >= 200 的异常分布。 */
export function detectAnomalousSamples(outputs, diagnostics) {
  const anomalous = [];
  if (!Array.isArray(outputs)) return anomalous;
  for (let i = 0; i < outputs.length; i += 1) {
    if (diagnostics && !diagnostics[i]?.accepted) continue;
    const nums = parseNumbers(outputs[i]?.text || '');
    if (nums.length && Math.min(...nums) >= 200) anomalous.push(i);
  }
  return anomalous;
}

/* 上游 analyzeSharedOutputs 原样移植（allowPartial 分支保留；证据文案本来就是中文）。 */
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

/* ---------- 校验、SHA-256 与 IndexedDB 缓存 ---------- */

export function validateBundleMeta(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('参考库清单格式无效');
  if (bundle.schema !== 'lmfpd-data-v1' || bundle.detector_schema !== 'shared-detector-v2') {
    throw new Error(`不支持的参考库格式：${bundle.schema}/${bundle.detector_schema}`);
  }
  if (!Array.isArray(bundle.models) || bundle.models.length < 2 || bundle.models.length > 500) {
    throw new Error('参考库模型列表无效');
  }
  const file = bundle.files?.['shared_detector.bin'];
  if (!file || !Array.isArray(file.parts) || file.parts.length < 1 || file.parts.length > 32) {
    throw new Error('参考库分片清单缺失');
  }
  for (const part of file.parts) {
    if (typeof part !== 'string' || !/^[a-zA-Z0-9._-]+\.zst$/.test(part)) {
      throw new Error(`非法的分片文件名：${String(part)}`);
    }
  }
  if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(file.sha256)) {
    throw new Error('参考库 SHA-256 格式无效');
  }
  if (!Number.isFinite(file.bytes) || file.bytes <= 0 || file.bytes > MAX_PACKED_BYTES) {
    throw new Error('参考库大小超出限制');
  }
  return {bundle, file};
}

export async function sha256Hex(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function openSnapshotDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, {keyPath: 'id'});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readCachedSnapshot() {
  const db = await openSnapshotDb();
  if (!db) return null;
  try {
    return await new Promise(resolve => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } finally {
    try { db.close(); } catch {}
  }
}

async function writeCachedSnapshot(record) {
  const db = await openSnapshotDb();
  if (!db) return false;
  try {
    return await new Promise(resolve => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({id: SNAPSHOT_KEY, ...record});
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  } finally {
    try { db.close(); } catch {}
  }
}

function formatBankInfo(channel) {
  return {
    models: channel?.bank?.models?.length || 0,
    built_at: channel?.builtAt || null,
    sha256: channel?.sha256 || null,
    origin: channel?.origin || 'bundled',
    source: channel?.source || null,
    fetched_at: channel?.fetchedAt || null,
  };
}

/* ---------- 数据加载与在线一键刷新 ---------- */

let channelPromise = null;
let refreshPromise = null;

async function tryLoadCached(bundledBuiltAt) {
  try {
    const cached = await readCachedSnapshot();
    if (!cached?.bank || !cached?.detectorBytes) return null;
    const {file} = validateBundleMeta(cached.bank);
    const expectedSha = file.sha256.toLowerCase();
    const cachedTime = Date.parse(cached.bank.built_at || '');
    const bundledTime = Date.parse(bundledBuiltAt || '');
    if (!Number.isFinite(cachedTime) || (Number.isFinite(bundledTime) && cachedTime <= bundledTime)) return null;
    const bytes = cached.detectorBytes instanceof Uint8Array
      ? cached.detectorBytes
      : new Uint8Array(cached.detectorBytes);
    if ((await sha256Hex(bytes)) !== expectedSha) return null;
    const detector = decodeLmfpdDetector(bytes);
    if (!lmfpdBankMatches(cached.bank, detector)) return null;
    return {
      bank: cached.bank,
      detector,
      builtAt: cached.bank.built_at,
      sha256: expectedSha,
      origin: 'remote',
      source: cached.source || null,
      fetchedAt: cached.fetchedAt || null,
    };
  } catch {
    return null;
  }
}

export function loadLmfpdChannel() {
  if (channelPromise) return channelPromise;
  channelPromise = (async () => {
    const bankUrl = chrome.runtime.getURL('lmfpd-data/unified_bank.json');
    const binUrl = chrome.runtime.getURL('lmfpd-data/shared_detector.bin');
    const bankResponse = await fetch(bankUrl);
    if (!bankResponse.ok) throw new Error(`lmfpd 数据读取失败 HTTP ${bankResponse.status}`);
    const bundledBank = await bankResponse.json();
    const {file: bundledFile} = validateBundleMeta(bundledBank);
    const bundledSha = bundledFile.sha256.toLowerCase();

    const cachedChannel = await tryLoadCached(bundledBank.built_at);
    if (cachedChannel) return cachedChannel;

    const binResponse = await fetch(binUrl);
    if (!binResponse.ok) throw new Error(`lmfpd 检测器读取失败 HTTP ${binResponse.status}`);
    const detectorBytes = new Uint8Array(await binResponse.arrayBuffer());
    const digest = await sha256Hex(detectorBytes);
    if (digest !== bundledSha) throw new Error('内置 lmfpd 检测器 SHA-256 校验失败');
    const detector = decodeLmfpdDetector(detectorBytes);
    if (!lmfpdBankMatches(bundledBank, detector)) throw new Error('lmfpd 参考库与检测器不匹配');
    return {
      bank: bundledBank,
      detector,
      builtAt: bundledBank.built_at,
      sha256: bundledSha,
      origin: 'bundled',
      source: 'bundled',
      fetchedAt: null,
    };
  })();
  channelPromise.catch(() => { channelPromise = null; });
  return channelPromise;
}

export async function getLmfpdBankInfo() {
  const channel = await loadLmfpdChannel();
  return formatBankInfo(channel);
}

async function fetchBytes(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} (${url})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function performRefresh(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const sources = Array.isArray(options.sources) && options.sources.length ? options.sources : LMFPD_SOURCES;
  const persist = options.persist !== undefined ? options.persist : writeCachedSnapshot;
  const current = options.current !== undefined ? options.current : await loadLmfpdChannel().catch(() => null);
  const updateCache = options.updateCache !== undefined ? options.updateCache : !options.fetchImpl;
  const failures = [];

  for (const source of sources) {
    try {
      const bundleBytes = await fetchBytes(fetchImpl, `${source}bundle.json`, 15000);
      const bundle = JSON.parse(new TextDecoder().decode(bundleBytes));
      const {file} = validateBundleMeta(bundle);
      const expectedSha = file.sha256.toLowerCase();

      if (!options.force && current && current.sha256 === expectedSha && current.builtAt === bundle.built_at) {
        return {
          ok: true,
          updated: false,
          up_to_date: true,
          info: formatBankInfo(current),
          source,
        };
      }

      const chunks = [];
      let totalBytes = 0;
      for (const part of file.parts) {
        const chunk = await fetchBytes(fetchImpl, `${source}chunks/${part}`, 90000);
        totalBytes += chunk.length;
        if (totalBytes > MAX_PACKED_BYTES) throw new Error('远端分片总大小超出限制');
        chunks.push(chunk);
      }

      const packed = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        packed.set(chunk, offset);
        offset += chunk.length;
      }

      const detectorBytes = zstdDecompress(packed);
      if (!(detectorBytes instanceof Uint8Array) || detectorBytes.length === 0 || detectorBytes.length > MAX_DETECTOR_BYTES) {
        throw new Error('zstd 解压后的检测器大小异常');
      }
      const digest = await sha256Hex(detectorBytes);
      if (digest !== expectedSha) {
        throw new Error(`SHA-256 校验失败：${digest.slice(0, 12)} != ${expectedSha.slice(0, 12)}`);
      }
      const detector = decodeLmfpdDetector(detectorBytes);
      if (!lmfpdBankMatches(bundle, detector)) throw new Error('远端参考库与检测器不匹配');

      const fetchedAt = new Date().toISOString();
      let persisted = false;
      if (typeof persist === 'function') {
        try {
          persisted = !!(await persist({
            bank: bundle,
            detectorBytes,
            sha256: expectedSha,
            builtAt: bundle.built_at,
            fetchedAt,
            source,
          }));
        } catch {
          persisted = false;
        }
      }

      const nextChannel = {
        bank: bundle,
        detector,
        builtAt: bundle.built_at,
        sha256: expectedSha,
        origin: 'remote',
        source,
        fetchedAt,
      };
      if (updateCache) channelPromise = Promise.resolve(nextChannel);

      return {
        ok: true,
        updated: true,
        up_to_date: false,
        previous_models: current?.bank?.models?.length || 0,
        previous_built_at: current?.builtAt || null,
        info: formatBankInfo(nextChannel),
        persisted,
        source,
      };
    } catch (error) {
      failures.push(`${source}: ${error?.message || error}`);
    }
  }
  throw new Error(`拉取 lm.ikale.io 指纹库失败（${failures.join('；')}）`);
}

export function refreshLmfpdChannel(options = {}) {
  const customRun = Boolean(options.fetchImpl || options.sources || options.persist !== undefined || options.current !== undefined);
  if (customRun) return performRefresh(options);
  if (refreshPromise) return refreshPromise;
  refreshPromise = performRefresh(options).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

/* ---------- 摘要与主识别入口（以 lm.ikale.io 为准） ---------- */

const normModelId = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 把 lmfpd 分析压缩成摘要对象；提供 primary 时附带一致性对比，未提供则为主引擎输出。 */
export function lmfpdSummary(analysis, primary = null) {
  const top = analysis?.results?.[0] || null;
  let agreement = primary ? '无有效排名' : '';
  if (analysis?.decision === 'not_model') agreement = 'lmfpd 判非模型序列';
  else if (top && primary) {
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

/** 主数字指纹识别入口：全部状态、候选排序、概率与诊断均以 lm.ikale.io 为准。 */
export function identifyWithLmfpd(outputs, channel) {
  if (!channel?.bank || !channel?.detector) throw new Error('lmfpd 指纹库尚未加载');
  const analysis = analyzeLmfpdOutputs(outputs, channel.bank, channel.detector);
  const anomalousSamples = detectAnomalousSamples(outputs, analysis.diagnostics);
  const candidates = (analysis.results || []).map(item => ({
    id: item.model,
    display_name: item.display_name,
    family: item.family,
    family_name: item.family_name,
    score: item.score,
    probability: item.probability,
  }));
  const nearest = candidates[0] || null;
  const top3 = candidates.slice(0, 3);
  const scoreGap = candidates.length > 1 ? candidates[0].score - candidates[1].score : null;
  const familyProbability = nearest && analysis.probability_status === 'reference_calibrated'
    ? candidates.filter(item => item.family === nearest.family).reduce((sum, item) => sum + (item.probability || 0), 0)
    : null;
  const evidenceNumbers = (analysis.diagnostics || [])
    .filter(item => item.accepted)
    .reduce((sum, item) => sum + (Number(item.parsed_numbers) || 0), 0);
  const probability = Number.isFinite(analysis.probability) ? analysis.probability : null;
  const lowConfidence = analysis.decision === 'scored' && probability !== null && probability < LMFPD_LOW_CONFIDENCE_THRESHOLD;
  const sharedBaseNote = nearest?.id === LMFPD_ASTRA_SHARED_ID
    ? 'lm.ikale.io 无法通过数字指纹区分 gpt-6-astra 与 gpt-6.1-sol（共享底模），建议结合其它特征进一步辨认。'
    : '';

  let status;
  let reason;
  if (analysis.decision === 'scored' && probability !== null && probability >= LMFPD_LOW_CONFIDENCE_THRESHOLD && !anomalousSamples.length) {
    status = 'clear';
    reason = 'lmfpd_calibrated_confident';
  } else if (analysis.decision === 'scored') {
    status = 'close';
    reason = anomalousSamples.length
      ? 'lmfpd_anomalous_samples'
      : (probability !== null ? 'lmfpd_low_confidence' : 'lmfpd_uncalibrated');
  } else if (analysis.decision === 'partial') {
    status = 'close';
    reason = 'lmfpd_partial_samples';
  } else if (analysis.decision === 'not_model') {
    status = 'weak';
    reason = 'lmfpd_not_model';
  } else {
    status = 'weak';
    reason = 'lmfpd_unscorable';
  }

  const lmfpd = {
    ...lmfpdSummary(analysis),
    built_at: channel.builtAt || null,
    bank_models: channel.bank.models.length,
    sha256: channel.sha256 || null,
    origin: channel.origin || 'bundled',
    anomalous_samples: anomalousSamples,
    low_confidence: lowConfidence,
    shared_base_note: sharedBaseNote,
  };

  return {
    status,
    reason,
    decision: analysis.decision,
    nearest,
    top3,
    candidates,
    signals: {
      probability,
      probability_status: analysis.probability_status,
      score: nearest ? nearest.score : null,
      score_gap: scoreGap,
      family_probability: familyProbability,
      query_count: analysis.used_outputs,
      evidence_numbers: evidenceNumbers,
      sequence: analysis.sequence,
      anomalous_samples: anomalousSamples,
      low_confidence: lowConfidence,
      shared_base_note: sharedBaseNote,
      evidence: analysis.evidence,
    },
    used_outputs: analysis.used_outputs,
    bank_models: channel.bank.models.length,
    bank_source: 'Fingerpoint Detector（lm.ikale.io）',
    bank_built_at: channel.builtAt || null,
    bank_origin: channel.origin || 'bundled',
    bank_sha256: channel.sha256 || null,
    calibration: analysis.calibration || null,
    lmfpd,
  };
}
