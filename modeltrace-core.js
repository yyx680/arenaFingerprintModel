/* ModelTrace fingerprint scoring core. Copyright (c) 2026 xqy2006; MIT License.
   Vendored from https://github.com/xqy2006/ModelTrace commit d4131b30243dfa05e70180b5eedde742103f1d73.
   See LICENSE-ModelTrace and THIRD_PARTY_NOTICES.md. */
export const VALUE_MIN = 1;
export const VALUE_MAX = 355;
export const DIMENSION = VALUE_MAX - VALUE_MIN + 1;
export const ALPHA = 0.5;
export const ORDERED_BLOCK_WEIGHT = 0.25;

export function parseNumbers(text) {
  const runs = [];
  let current = [];
  let previousEnd = 0;
  for (const match of String(text).matchAll(/\d+/g)) {
    const separator = String(text).slice(previousEnd, match.index);
    const value = Number(match[0]);
    if (current.length && /\p{L}/u.test(separator)) {
      runs.push(current);
      current = [];
    }
    if (value >= VALUE_MIN && value <= VALUE_MAX) current.push(value);
    previousEnd = match.index + match[0].length;
  }
  if (current.length) runs.push(current);
  return runs.reduce((best, run) => run.length > best.length ? run : best, []);
}

export function countNumbers(numbers) {
  const counts = Array(DIMENSION).fill(0);
  numbers.forEach((number) => { counts[number - VALUE_MIN] += 1; });
  return counts;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardize(values) {
  const center = mean(values);
  const variance = mean(values.map((value) => (value - center) ** 2));
  const scale = Math.max(Math.sqrt(variance), 1e-12);
  return values.map((value) => (value - center) / scale);
}

function dot(left, right) {
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += left[index] * right[index];
  return value;
}

function norm(values) {
  return Math.sqrt(dot(values, values));
}

function normalized(values) {
  const scale = Math.max(norm(values), 1e-12);
  return values.map((value) => value / scale);
}

function subtractBasis(values, basis) {
  const output = values.slice();
  for (const vector of basis || []) {
    const projection = dot(output, vector);
    for (let index = 0; index < output.length; index += 1) output[index] -= projection * vector[index];
  }
  return output;
}

function hellingerFeature(counts) {
  const total = counts.reduce((sum, value) => sum + value, 0) + ALPHA * DIMENSION;
  return counts.map((value) => Math.sqrt((value + ALPHA) / total));
}

function splitIntoFour(values) {
  const base = Math.floor(values.length / 4);
  const remainder = values.length % 4;
  const chunks = [];
  let start = 0;
  for (let index = 0; index < 4; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    chunks.push(values.slice(start, start + size));
    start += size;
  }
  return chunks;
}

function orderedBlockFeature(numbers) {
  const pieces = [];
  for (const chunk of splitIntoFour(numbers)) {
    const bins = Array(16).fill(0.5);
    for (const value of chunk) {
      const index = Math.min(15, Math.floor(((value - 1) / 355) * 16));
      bins[index] += 1;
    }
    const total = bins.reduce((sum, value) => sum + value, 0);
    pieces.push(...bins.map((value) => Math.sqrt(value / total)));
  }
  const lastDigits = Array(10).fill(0.5);
  numbers.forEach((value) => { lastDigits[value % 10] += 1; });
  const lastTotal = lastDigits.reduce((sum, value) => sum + value, 0);
  pieces.push(...lastDigits.map((value) => Math.sqrt(value / lastTotal)));
  return pieces;
}

function robustScoreCounts(counts, bank) {
  const artifact = bank.robust.hellinger;
  const feature = hellingerFeature(counts);
  let projected = feature.map((value, index) => (value - artifact.feature_mean[index]) / artifact.feature_scale[index]);
  projected = subtractBasis(projected, artifact.nuisance_basis);
  projected = normalized(projected);
  const scores = artifact.centroids.map((centroid) => dot(projected, centroid));
  return standardize(scores);
}

function orderedBlockScores(numbers, bank) {
  const artifact = bank.robust.ordered_blocks;
  const feature = orderedBlockFeature(numbers);
  const standardizedFeature = feature.map((value, index) => (value - artifact.feature_mean[index]) / artifact.feature_scale[index]);
  const unit = normalized(standardizedFeature);
  const environmentScores = artifact.environment_centroids.map(
    (centroids) => centroids.map((centroid) => dot(unit, centroid)),
  );
  const template = standardize(artifact.centroids.map((_, modelIndex) => Math.max(
    ...environmentScores.map((scores) => scores[modelIndex]),
  )));
  const projected = normalized(subtractBasis(standardizedFeature, artifact.nuisance_basis));
  const nuisance = standardize(artifact.centroids.map((centroid) => dot(projected, centroid)));
  return standardize(template.map((value, index) => 0.5 * value + 0.5 * nuisance[index]));
}

export function robustScoreNumbers(numbers, bank) {
  const marginal = robustScoreCounts(countNumbers(numbers), bank);
  const artifact = bank.robust.ordered_blocks;
  const weight = artifact ? Number(artifact.weight || 0) : 0;
  if (!artifact || weight === 0) return marginal;
  const ordered = orderedBlockScores(numbers, bank);
  return marginal.map((value, index) => (1 - weight) * value + weight * ordered[index]);
}

function softmax(values) {
  const maximum = Math.max(...values);
  const weights = values.map((value) => Math.exp(value - maximum));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((value) => value / total);
}

function jsSimilarity(left, right) {
  const leftTotal = left.reduce((sum, value) => sum + value, 0);
  const rightTotal = right.reduce((sum, value) => sum + value, 0) + ALPHA * DIMENSION;
  const p = left.map((value) => value / leftTotal);
  const q = right.map((value) => (value + ALPHA) / rightTotal);
  const midpoint = p.map((value, index) => (value + q[index]) / 2);
  const divergence = (values) => values.reduce(
    (total, value, index) => total + (value ? value * Math.log(value / midpoint[index]) : 0),
    0,
  );
  const js = (divergence(p) + divergence(q)) / 2;
  return 1 - Math.sqrt(js / Math.log(2));
}

export function analyzeGlobalOutputs(outputs, bank) {
  const modelIds = bank.models.map((model) => model.id);
  const valid = [];
  const diagnostics = [];
  outputs.forEach((item, index) => {
    const expected = Number(item.expected_count || 0);
    const numbers = parseNumbers(item.text || "");
    const minimum = expected ? Math.max(80, Math.ceil(expected * 0.55)) : 80;
    const accepted = numbers.length >= minimum;
    diagnostics.push({ index, parsed_numbers: numbers.length, minimum_numbers: minimum, accepted });
    if (accepted) valid.push({ numbers, counts: countNumbers(numbers), scores: robustScoreNumbers(numbers, bank) });
  });
  if (!valid.length) throw new Error("没有可用回答：请粘贴完整数字序列；拒答或严重截断的回答不会计入。");

  const combinedScores = modelIds.map((_, modelIndex) => mean(valid.map((item) => item.scores[modelIndex])));
  const calibrationKey = String(Math.min(valid.length, 3));
  const beta = Number(bank.calibration[calibrationKey].beta);
  const probabilities = softmax(combinedScores.map((value) => beta * value));
  const pooledCounts = Array.from({ length: DIMENSION }, (_, index) => valid.reduce((sum, item) => sum + item.counts[index], 0));
  const modelEntries = Object.fromEntries(bank.models.map((model) => [model.id, model]));
  const familyOrder = [...new Set(bank.models.map((model) => model.family || "models"))];
  const familyNames = Object.fromEntries(familyOrder.map((family) => [
    family,
    bank.models.find((model) => (model.family || "models") === family)?.family_name || family,
  ]));
  const results = modelIds.map((model, index) => ({
    model,
    display_name: modelEntries[model].display_name,
    probability: probabilities[index],
    profile_similarity: jsSimilarity(pooledCounts, modelEntries[model].counts),
    score: combinedScores[index],
    family: modelEntries[model].family || "models",
    family_name: familyNames[modelEntries[model].family || "models"],
  })).sort((left, right) => right.probability - left.probability);
  const familyProbabilities = Object.fromEntries(familyOrder.map((family) => [
    family,
    results.filter((item) => item.family === family).reduce((sum, item) => sum + item.probability, 0),
  ]));
  results.forEach((item) => { item.conditional_probability = item.probability / familyProbabilities[item.family]; });
  const winningFamily = familyOrder.reduce((best, family) => familyProbabilities[family] > familyProbabilities[best] ? family : best);
  return {
    prediction: results[0].model,
    prediction_name: results[0].display_name,
    probability: results[0].probability,
    used_outputs: valid.length,
    results,
    diagnostics,
    calibration: { queries: calibrationKey, beta, cv_accuracy: bank.calibration[calibrationKey].cv_accuracy },
    family_prediction: winningFamily,
    family_prediction_name: familyNames[winningFamily],
    family_probability: familyProbabilities[winningFamily],
    family_probabilities: familyOrder.map((family) => ({ family, display_name: familyNames[family], probability: familyProbabilities[family] })),
    method: "统一全局稳健数字指纹",
  };
}

/* v2.8.1 开集判据（新增，不改动上面的既有打分通道）：
   1) 多项分布对数似然 + 似然比置信集（2Δll <= LR_DELTA ~ chi2 95%）：
      把「统计上分不开的近亲」一起留在集合里，UI 显示家族 + 候选集而不是硬挑一个。
   2) 同族两模型混合检验：若 w·p_i+(1-w)·p_j 显著优于任何单一参考，说明现场分布
      不是库里任何单一模型（服务端在近亲之间路由，或参考库已漂移）。
      实测：真 50/50 混合触发 66%，单一模型漂移 0.35 也触发 85% —— 两者不可区分，
      因此只作为提示展示，不参与 clear 闸门。
   背景：模型库每档仅 36 条回答（约 1.05 万个数字），近亲之间的 Hellinger 距离
   0.086~0.110，单题 300 个数字的抽样噪声地板约 0.041，信噪比 2.7，本来就分不开。 */
export const LR_DELTA = 9.49;
const MIX_STEP = 0.05;
const MIX_MIN = 0.1;
const MIX_MAX = 0.9;
const MIX_TOP_CANDIDATES = 6;

const logRefCache = new WeakMap();

/** 每个模型的平滑多项分布对数概率（355 维），按 bank 缓存。 */
export function modelLogReference(bank) {
  let table = logRefCache.get(bank);
  if (!table) {
    table = bank.models.map((model) => {
      const total = model.counts.reduce((sum, value) => sum + value, 0) + ALPHA * DIMENSION;
      return model.counts.map((value) => Math.log((value + ALPHA) / total));
    });
    logRefCache.set(bank, table);
  }
  return table;
}

/* v2.9.0 建档层（B）：家族层级收缩。
   每档参考只有 36 条回答（约 1.05 万个数字），其中一部分是建档当天的环境噪声；
   把每档分布向「家族中心」拉 lambda 比例（lambda=0 完全关闭，0.1 是轻量默认），
   家族之间的差异保留、家族内部的伪差异被压掉 —— 让库自己承认「家族内不可分」，
   表现为置信集更常 >1（宁可显示候选集，也不硬挑一个近亲）。 */
export function shrinkageReference(bank, lambda = 0) {
  const weight = Math.min(0.9, Math.max(0, Number(lambda) || 0));
  if (!weight) return bank.models.map((model) => model.counts);
  const families = new Map();
  for (const model of bank.models) {
    const key = model.family || 'models';
    if (!families.has(key)) families.set(key, new Array(DIMENSION).fill(0));
    const bucket = families.get(key);
    for (let index = 0; index < DIMENSION; index += 1) bucket[index] += model.counts[index];
  }
  const normalized = new Map();
  for (const [key, bucket] of families) {
    const total = bucket.reduce((sum, value) => sum + value, 0) || 1;
    normalized.set(key, bucket.map((value) => value / total));
  }
  return bank.models.map((model) => {
    const own = model.counts;
    const ownTotal = own.reduce((sum, value) => sum + value, 0) || 1;
    const center = normalized.get(model.family || 'models');
    return own.map((value, index) => (1 - weight) * (value / ownTotal) + weight * center[index]);
  });
}

const shrinkLogCache = new WeakMap();

/** 收缩后的对数参考（按 bank + lambda 缓存）；lambda 为 0 时等价于 modelLogReference。 */
export function shrinkageLogReference(bank, lambda = 0) {
  const weight = Math.min(0.9, Math.max(0, Number(lambda) || 0));
  if (!weight) return modelLogReference(bank);
  let byLambda = shrinkLogCache.get(bank);
  if (!byLambda) { byLambda = new Map(); shrinkLogCache.set(bank, byLambda); }
  const key = weight.toFixed(2);
  let table = byLambda.get(key);
  if (!table) {
    table = shrinkageReference(bank, weight).map((distribution, modelIndex) => {
      const countTotal = bank.models[modelIndex].counts.reduce((sum, value) => sum + value, 0) || 1;
      const total = countTotal + ALPHA * DIMENSION;
      return distribution.map((value) => Math.log((value * countTotal + ALPHA) / total));
    });
    byLambda.set(key, table);
  }
  return table;
}

/** countsList: 同一会话内多份回答的 355 维计数；池化后做一次开集判决。 */
export function openSetDecision(countsList, bank, delta = LR_DELTA, shrinkage = 0) {
  const logReference = shrinkageLogReference(bank, shrinkage);
  const observed = countsList[0].map((_, index) => countsList.reduce((sum, counts) => sum + counts[index], 0));
  const logLikelihood = logReference.map((row) => row.reduce((sum, value, index) => sum + value * observed[index], 0));
  const order = logLikelihood.map((value, index) => [value, index])
    .sort((left, right) => right[0] - left[0])
    .map((item) => item[1]);
  const gap = logLikelihood.map((value) => 2 * (logLikelihood[order[0]] - value));
  const set = order.filter((index) => gap[index] <= delta);
  const bestSingle = logLikelihood[order[0]];
  const candidates = order.slice(0, Math.min(MIX_TOP_CANDIDATES, order.length));
  let mixture = null;
  for (let a = 0; a < candidates.length && !mixture; a += 1) {
    for (let b = a + 1; b < candidates.length; b += 1) {
      const left = candidates[a];
      const right = candidates[b];
      if ((bank.models[left].family || 'models') !== (bank.models[right].family || 'models')) continue;
      const referenceLeft = bank.models[left].counts;
      const referenceRight = bank.models[right].counts;
      const totalLeft = referenceLeft.reduce((sum, value) => sum + value, 0) + ALPHA * DIMENSION;
      const totalRight = referenceRight.reduce((sum, value) => sum + value, 0) + ALPHA * DIMENSION;
      for (let w = MIX_MIN; w <= MIX_MAX + 1e-9; w += MIX_STEP) {
        let value = 0;
        for (let index = 0; index < DIMENSION; index += 1) {
          const mixed = w * (referenceLeft[index] + ALPHA) / totalLeft + (1 - w) * (referenceRight[index] + ALPHA) / totalRight;
          value += Math.log(mixed) * observed[index];
        }
        if (value - bestSingle > delta / 2) {
          mixture = { models: [bank.models[left].id, bank.models[right].id], weight: Number(w.toFixed(2)), gain: value - bestSingle };
          break;
        }
      }
      if (mixture) break;
    }
  }
  return {
    best: bank.models[order[0]].id,
    set: set.map((index) => bank.models[index].id),
    runner_up_gap: order.length > 1 ? gap[order[1]] : Infinity,
    mixture,
    evidence: observed.reduce((sum, value) => sum + value, 0),
  };
}
