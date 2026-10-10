/* v2.9.0 节奏通道（被动，0 探测消息）。
   输入：network-sniffer.js 在 MAIN world 记录的流式分片到达时间与字节数。
   依据：arXiv 2502.20589《LLMs Have Rhythm》—— inter-token 时间 + 分块大小构成的「节奏」
   与架构/参数规模/硬件相关，跨天 F1 85%、跨网 74%、VPN 71%；与数字指纹通道的信息来源正交，
   适合当第二票。这里只做纯函数部分：特征提取 + 与本机基线的最近邻比较。 */

const MIN_CHUNKS = 24;
const MIN_BYTES = 512;

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** 把若干条 stream 观测合并成一份节奏特征。 */
export function rhythmProfile(streams) {
  const list = (Array.isArray(streams) ? streams : []).filter((item) => item && item.chunks >= 2);
  if (!list.length) return null;
  const gaps = [];
  const sizes = [];
  let chunks = 0;
  let bytes = 0;
  let duration = 0;
  for (const stream of list) {
    chunks += Number(stream.chunks) || 0;
    bytes += Number(stream.bytes) || 0;
    duration += Number(stream.duration_ms) || 0;
    for (const gap of stream.gaps || []) {
      const value = Number(gap);
      if (Number.isFinite(value) && value > 0 && value < 30000) gaps.push(value);
    }
    if (Number(stream.chunks) > 0) sizes.push((Number(stream.bytes) || 0) / Number(stream.chunks));
  }
  if (chunks < MIN_CHUNKS || bytes < MIN_BYTES || !gaps.length) {
    return { enough: false, streams: list.length, chunks, bytes, reason: chunks < MIN_CHUNKS ? 'chunks_too_few' : (bytes < MIN_BYTES ? 'bytes_too_small' : 'no_gaps') };
  }
  gaps.sort((left, right) => left - right);
  sizes.sort((left, right) => left - right);
  const medianGap = quantile(gaps, 0.5);
  return {
    enough: true,
    streams: list.length,
    chunks,
    bytes,
    duration_ms: Math.round(duration),
    chunks_per_s: Number((chunks / Math.max(duration, 1) * 1000).toFixed(3)),
    bytes_per_s: Number((bytes / Math.max(duration, 1) * 1000).toFixed(1)),
    gap_p10_ms: Math.round(quantile(gaps, 0.10)),
    gap_p50_ms: Math.round(medianGap),
    gap_p90_ms: Math.round(quantile(gaps, 0.90)),
    gap_iqr_ms: Math.round(quantile(gaps, 0.75) - quantile(gaps, 0.25)),
    gap_cv: Number((gapStd(gaps) / Math.max(medianGap, 1e-9)).toFixed(3)),
    burst_ratio: Number((gaps.filter((gap) => gap < 12).length / gaps.length).toFixed(3)),
    bytes_per_chunk_p50: Math.round(quantile(sizes, 0.5)),
    bytes_per_chunk_iqr: Math.round(quantile(sizes, 0.75) - quantile(sizes, 0.25)),
  };
}

function gapStd(sorted) {
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const variance = sorted.reduce((total, value) => total + (value - mean) ** 2, 0) / sorted.length;
  return Math.sqrt(variance);
}

/** 参与比较的特征（顺序固定，改这里就等于换指纹定义，需同时清掉本机基线）。 */
export const RHYTHM_FEATURES = Object.freeze([
  'chunks_per_s', 'bytes_per_s', 'gap_p10_ms', 'gap_p50_ms', 'gap_p90_ms',
  'gap_iqr_ms', 'gap_cv', 'burst_ratio', 'bytes_per_chunk_p50', 'bytes_per_chunk_iqr',
]);

export function rhythmVector(profile) {
  if (!profile?.enough) return null;
  return RHYTHM_FEATURES.map((key) => {
    const value = Number(profile[key]);
    return Number.isFinite(value) ? Math.log1p(Math.abs(value)) * Math.sign(value || 1) : 0;
  });
}

export function rhythmDistance(left, right) {
  const a = rhythmVector(left);
  const b = rhythmVector(right);
  if (!a || !b) return Infinity;
  const normA = Math.hypot(...a) || 1;
  const normB = Math.hypot(...b) || 1;
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += (a[index] / normA) * (b[index] / normB);
  return Number((1 - dot).toFixed(5));
}

/**
 * 与本机基线比较（基线来自历史上被判「清晰匹配」或轨迹直读确认的那些轮次）。
 * 返回四态，绝不硬判：insufficient / match / uncertain / mismatch。
 */
export function rhythmVote(profile, bank) {
  const entries = Object.entries(bank || {});
  if (!profile?.enough) return { verdict: 'insufficient', reason: '本次流式样本不足（分片或字节太少）', candidates: [] };
  if (!entries.length) return { verdict: 'insufficient', reason: '本机还没有节奏基线（先用数字通道或轨迹直读确认几轮）', candidates: [] };
  const scored = entries
    .map(([id, entry]) => ({ id, samples: Number(entry?.samples) || 0, distance: rhythmDistance(profile, entry?.profile) }))
    .filter((item) => item.samples >= 5 && Number.isFinite(item.distance))
    .sort((left, right) => left.distance - right.distance);
  if (!scored.length) return { verdict: 'insufficient', reason: '节奏基线每个模型至少需要 5 轮（本机匹配阈值尚未做本地校准）', candidates: [] };
  const best = scored[0];
  const runnerUp = scored[1] || null;
  const margin = runnerUp ? Number((runnerUp.distance - best.distance).toFixed(5)) : Infinity;
  // 仅作旁路提示，绝不参与改名/主判决；match 需完整 8 轮基线且距离与间隔都很紧。
  const verdict = best.samples >= 8 && best.distance <= 0.015 && margin >= 0.02 ? 'match'
    : best.distance <= 0.08 ? 'uncertain'
      : 'mismatch';
  return { verdict, reason: verdict === 'match' ? '节奏与本机基线一致' : (verdict === 'mismatch' ? '节奏与所有本机基线都不一致' : '节奏接近但区分不开'), best: best.id, distance: best.distance, margin, candidates: scored.slice(0, 3) };
}

/** 把一次观测并入基线（滑动平均，最多记 8 次）。 */
export function rhythmAccumulate(previous, profile, cap = 8) {
  if (!profile?.enough) return previous || null;
  if (!previous?.profile) return { profile, samples: 1, updatedAt: Date.now() };
  const samples = Math.min(cap, (Number(previous.samples) || 0) + 1);
  const weight = 1 / samples;
  const merged = { ...previous.profile };
  for (const key of RHYTHM_FEATURES) {
    const old = Number(merged[key]);
    const next = Number(profile[key]);
    if (Number.isFinite(old) && Number.isFinite(next)) merged[key] = Number((old + (next - old) * weight).toFixed(4));
  }
  merged.enough = true;
  return { profile: merged, samples, updatedAt: Date.now() };
}
