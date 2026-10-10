/* 统计检定层 v2.9.21（运行时计算，不改指纹库结构，不改 ModelTrace vendored 核心）。
   方法：把管线自己的「拟合分 fit」当检验统计量，用该模型参考分布的自举零分布做 z 变换与单侧检验
   （fit 是否显著低于该模型自己的正常水平），再对全库做 Benjamini-Hochberg 校正，得到
   「仍与观测相容的模型集合」：空集=库里没有这个模型；单元素=唯一相容；多元素=近亲分不开。
   文献依据：
   - One Token Is Enough (arXiv 2607.10252)：分布级指纹 + 拆分样本验证协议（全电池 EER 7.3%），
     说明用「同一统计量的零分布」做检验，比再调一个距离阈值更接近已验证的协议。
   - LLMmap (USENIX Sec 2025)：开放集识别的关键是能拒绝未知模型，而不是永远硬指一个名字。
   - The Randomness Floor (arXiv 2604.22771)：模型偏离均匀是权重层结构性质，可作显著性检验。
   实测选型（17 模型库，N=315，离线）：边缘分布卡方检验对近亲无分辨力、还会拒绝真模型，弃用；
   fit 统计量的自举 z 有分辨力（同模型抽样最近命中 10/10；均匀噪声应被整体拒绝）。 */

const DEFAULT_ALPHA = 0.05;
const DEFAULT_DRAWS = 32;
const DEFAULT_SEED = 0x9e3779b9;
const SMOOTHING = 0.5;

/* ---------- 正态下尾 Φ(z)（A&S 26.2.17 有理逼近） ---------- */

export function normalLowerTail(z) {
  if (!Number.isFinite(z)) return 0;
  const absolute = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = 0.3989422804014327 * Math.exp(-0.5 * absolute * absolute);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = density * poly;
  return z >= 0 ? 1 - upper : upper;
}

/* ---------- 确定性随机 + 多项式抽样（零分布来自模型参考分布） ---------- */

export function makeRandom(seed) {
  let state = (Number(seed) || DEFAULT_SEED) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function drawCounts(referenceCounts, size, rnd) {
  const dimension = referenceCounts.length;
  let referenceTotal = 0;
  for (const value of referenceCounts) referenceTotal += Number(value) || 0;
  const denominator = referenceTotal + SMOOTHING * dimension;
  const cumulative = new Float64Array(dimension);
  let running = 0;
  for (let index = 0; index < dimension; index += 1) {
    running += ((Number(referenceCounts[index]) || 0) + SMOOTHING) / denominator;
    cumulative[index] = running;
  }
  const sample = new Array(dimension).fill(0);
  for (let draw = 0; draw < size; draw += 1) {
    const target = rnd() * running;
    let low = 0;
    let high = dimension - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] < target) low = mid + 1; else high = mid;
    }
    sample[low] += 1;
  }
  return sample;
}

/* ---------- 每个模型、每种「证据规模」的 fit 零分布（按库缓存） ---------- */

const nullCache = new WeakMap();

function cacheKey(modelIndex, sizes, poolWeight, draws, seed) {
  return modelIndex + '|' + sizes.join(',') + '|' + poolWeight + '|' + draws + '|' + seed;
}

/** 用模型自己的参考分布模拟同规模 k 份答案，复现管线统计量（逐条 fit 均值 + 池化 fit 加权）。 */
export function fitNullTable(bank, modelIndex, sizes, options = {}) {
  const statistic = options.statistic;
  if (typeof statistic !== 'function') throw new TypeError('options.statistic is required');
  const draws = Math.max(8, Number(options.draws) || DEFAULT_DRAWS);
  const poolWeight = Number.isFinite(options.poolWeight) ? Number(options.poolWeight) : 0;
  const seed = Number(options.seed) || DEFAULT_SEED;
  let table = nullCache.get(bank);
  if (!table) { table = new Map(); nullCache.set(bank, table); }
  const key = cacheKey(modelIndex, sizes, poolWeight, draws, seed);
  if (table.has(key)) return table.get(key);
  const reference = bank.models[modelIndex].counts;
  const rnd = makeRandom(seed + modelIndex * 7919);
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let draw = 0; draw < draws; draw += 1) {
    const samples = sizes.map(size => drawCounts(reference, size, rnd));
    const value = Number(statistic(samples)[modelIndex]);
    if (!Number.isFinite(value)) continue;
    sum += value;
    sumSquares += value * value;
    count += 1;
  }
  const mean = count ? sum / count : 0;
  const variance = count > 1 ? Math.max(0, (sumSquares - count * mean * mean) / (count - 1)) : 0;
  const result = { mean, sd: Math.sqrt(variance), draws: count, sizes: sizes.slice(), modelIndex };
  table.set(key, result);
  return result;
}

/* ---------- 单模型检验 / 全库检验 ---------- */

/** 观测证据对单个模型参考的检验：z<0 表示拟合显著低于该模型自己的正常水平。 */
export function fitTestForModel(countsList, bank, modelIndex, options = {}) {
  const usable = (countsList || []).filter(Array.isArray);
  if (!usable.length) return { p: 1, z: 0, fit: null, mean: null, sd: null, draws: 0, sizes: [] };
  const sizes = usable.map(counts => counts.reduce((sum, value) => sum + (Number(value) || 0), 0));
  const fit = Number(options.statistic(usable)[modelIndex]);
  const nullTable = fitNullTable(bank, modelIndex, sizes, options);
  const sd = nullTable.sd > 1e-9 ? nullTable.sd : 1e-9;
  const z = (fit - nullTable.mean) / sd;
  return { p: normalLowerTail(z), z, fit, mean: nullTable.mean, sd: nullTable.sd, draws: nullTable.draws, sizes };
}

/**
 * 全库检验 + BH 多重比较校正。
 * best 取 z 最大（在该模型自己的零分布下最不异常）；最近参考（fit 最大）单独报。
 */
export function fitTests(countsList, bank, options = {}) {
  const alpha = Number.isFinite(options.alpha) ? Number(options.alpha) : DEFAULT_ALPHA;
  const usable = (countsList || []).filter(Array.isArray);
  const empty = {
    alpha, models: 0, observed: 0, sizes: [], best: null, best_z: 0, best_p: 1, best_p_adjusted: 1,
    nearest_fit: null, runner_up: null, runner_up_z: 0, runner_up_p: 1, z_gap: Infinity,
    set_size: 0, set_ids: [], rejected_all: false, unique: false, rows: [],
  };
  if (!usable.length) return empty;
  const sizes = usable.map(counts => counts.reduce((sum, value) => sum + (Number(value) || 0), 0));
  options.statistic(usable);
  const rows = bank.models.map((model, index) => {
    const test = fitTestForModel(usable, bank, index, options);
    return { id: model.id, family: model.family || 'models', index, fit: test.fit, mean: test.mean, sd: test.sd, z: test.z, p: test.p };
  });
  const byP = [...rows].sort((left, right) => left.p - right.p || right.z - left.z);
  const total = rows.length;
  const adjusted = new Array(total).fill(1);
  let running = 1;
  for (let rank = total - 1; rank >= 0; rank -= 1) {
    const position = rows.indexOf(byP[rank]);
    running = Math.min(running, (byP[rank].p * total) / (rank + 1));
    adjusted[position] = running;
  }
  rows.forEach((row, index) => {
    row.p_adjusted = adjusted[index];
    row.compatible = adjusted[index] > alpha;
  });
  const byZ = [...rows].sort((left, right) => right.z - left.z);
  const best = byZ[0];
  const runnerUp = byZ[1] || null;
  const nearestFit = [...rows].sort((left, right) => (right.fit ?? -Infinity) - (left.fit ?? -Infinity))[0];
  const set = rows.filter(row => row.compatible);
  return {
    alpha,
    models: total,
    observed: sizes.reduce((sum, value) => sum + value, 0),
    sizes,
    best: best.id,
    best_z: best.z,
    best_p: best.p,
    best_p_adjusted: best.p_adjusted,
    nearest_fit: nearestFit ? nearestFit.id : null,
    runner_up: runnerUp ? runnerUp.id : null,
    runner_up_z: runnerUp ? runnerUp.z : 0,
    runner_up_p: runnerUp ? runnerUp.p : 1,
    z_gap: runnerUp ? best.z - runnerUp.z : Infinity,
    set_size: set.length,
    set_ids: set.map(row => row.id),
    rejected_all: set.length === 0,
    unique: set.length === 1,
    rows: rows.map(row => ({ id: row.id, fit: row.fit, mean: row.mean, sd: row.sd, z: row.z, p: row.p, p_adjusted: row.p_adjusted, compatible: row.compatible })),
  };
}

/**
 * 证据同质性：每条答案单独对选中模型做同一检验，看 z 的离散度。
 * 同分布的两条答案 z 差通常在 3 以内；混合路由或明显漂移会把离散度拉大。
 */
export function evidenceHomogeneity(countsList, bank, modelIndex, options = {}) {
  const usable = (countsList || []).filter(Array.isArray);
  if (usable.length < 2) return { applicable: false };
  const maxSpread = Number.isFinite(options.maxSpread) ? Number(options.maxSpread) : 3;
  const zs = usable.map(counts => {
    const fit = Number(options.statistic([counts])[modelIndex]);
    const size = [counts.reduce((sum, value) => sum + (Number(value) || 0), 0)];
    const nullTable = fitNullTable(bank, modelIndex, size, options);
    const sd = nullTable.sd > 1e-9 ? nullTable.sd : 1e-9;
    return (fit - nullTable.mean) / sd;
  });
  const spread = Math.max(...zs) - Math.min(...zs);
  return { applicable: true, zs, spread, max_spread: maxSpread, homogeneous: spread <= maxSpread };
}

/**
 * 分离度的校准检验（把「fit 差 >= 0.06」这类固定阈值换成有零分布的分位数）：
 * 以「参考模型 nullFrom」的分布抽样，看 (fit_nullFrom - fit_other) 的零分布；
 * 观测 gap 落在零分布上尾尾部（p_upper 小）= 领先幅度显著，不是抽样抖动。
 */
export function fitGapTest(countsList, bank, nullFromIndex, otherIndex, options = {}) {
  const usable = (countsList || []).filter(Array.isArray);
  if (!usable.length || nullFromIndex < 0 || otherIndex < 0) return { applicable: false };
  const sizes = usable.map(counts => counts.reduce((sum, value) => sum + (Number(value) || 0), 0));
  const fits = options.statistic(usable);
  const observed = Number(fits[nullFromIndex]) - Number(fits[otherIndex]);
  const draws = Math.max(8, Number(options.draws) || DEFAULT_DRAWS);
  const seed = Number(options.seed) || DEFAULT_SEED;
  const reference = bank.models[nullFromIndex].counts;
  const rnd = makeRandom(seed + nullFromIndex * 104729 + otherIndex);
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let draw = 0; draw < draws; draw += 1) {
    const samples = sizes.map(size => drawCounts(reference, size, rnd));
    const values = options.statistic(samples);
    const gap = Number(values[nullFromIndex]) - Number(values[otherIndex]);
    if (!Number.isFinite(gap)) continue;
    sum += gap;
    sumSquares += gap * gap;
    count += 1;
  }
  const mean = count ? sum / count : 0;
  const variance = count > 1 ? Math.max(0, (sumSquares - count * mean * mean) / (count - 1)) : 0;
  const sd = Math.sqrt(variance);
  const z = (observed - mean) / (sd > 1e-9 ? sd : 1e-9);
  return {
    applicable: true,
    gap: observed,
    gap_mean: mean,
    gap_sd: sd,
    z,
    p_upper: normalLowerTail(-z),
    draws: count,
    significant: normalLowerTail(-z) < (Number.isFinite(options.alpha) ? Number(options.alpha) : DEFAULT_ALPHA),
  };
}
