/* Arena 单价通道（v2.12.0）—— 「按价格反推模型」的算法实现。

   实测结论（详见 Arena成本接口实测.md，2026-10-11 CDP 直连）：
   · Arena **公开**每个模型的 token 单价：榜单 RSC 里每行都带
       inputPricePerMillion / outputPricePerMillion（schema 还定义了
       cacheRead/cacheWrite/imageInput/imageOutput/textOutputPricePerMillion）。
     快照见 arena-pricing-table.json（实测 208 个模型有价）。
   · Arena **按次成本**走这两个接口（前端 Hono RPC 客户端调用）：
       GET /api/chat/:id/cost?includeSession=true          （Agent 会话）
       GET /api/chat/:id/cost?includeSession=false&messageIds=a,b,c
       GET /api/evaluation/:id/cost                        （Battle 会话）
     返回 {session:{actualTotalUsd,chargedTotalUsd,messageCount,aggregate?},
           messages:{[messageId]:MessageCost}}。
     实测该接口**按账号灰度**：本机账号（PostHog flag credit-system-m1/m2 未开）
     对全部 40 个会话、即使带有效 Supabase JWT 也一律 403 {"error":"Unauthorized"}。

   于是「按价格反推模型」的完整公式是：
       期望成本(model) = Σ tokensᵢ/1e6 × priceᵢ(model)
       → 与实际成本比对，谁最接近就是谁。
   本模块只做这件事：纯函数、只读数据，不发请求、不写存储。
   没有实际成本时它依然有用：可以把指纹候选的「本次请求期望成本」摆出来做区分度检查。 */

export const PRICING_SCHEMA = 'arena-model-pricing';
export const PRICING_UNIT = 'usd_per_million_tokens';
/** 比值落在 [1/1.6, 1.6] 内视为「相符」（Arena 会叠加 margin/discount 倍率，给足余量）。 */
export const CONSISTENT_RATIO = 1.6;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const nonNeg = (v) => finite(v) && v >= 0;

/** 只在证据完全并列时用于稳定排序；不能拿来源优先级替代价格证据定名。 */
export function pricingSourcePriority(source) {
  if (source === 'arena-battle-observed') return 0;
  if (source === 'arena-official') return 1;
  if (source === 'openrouter-public') return 2;
  return 3;
}

export function validatePricingTable(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('单价表格式无效');
  if (table.schema !== PRICING_SCHEMA) throw new Error('单价表 schema 无效');
  if (!Array.isArray(table.rows) || table.rows.length < 1 || table.rows.length > 2000) throw new Error('单价表行数无效');
  for (const row of table.rows) {
    if (!row || typeof row !== 'object') throw new Error('单价表行无效');
    if (typeof row.model_key !== 'string' || !row.model_key.trim() || row.model_key.length > 160) throw new Error('单价表 model_key 无效');
    const hasInput = nonNeg(row.input_usd_per_mtok);
    const hasOutput = nonNeg(row.output_usd_per_mtok);
    if (!hasInput && !hasOutput) throw new Error('单价表价格无效');
  }
  return table;
}

/** Arena 榜不下发 cache 费率（实测恒 null），这里把外部补充表（arena-cache-rates.json，
 *  来源 OpenRouter 公开价目）合并进已归一化的单价表 **原地** 并返回。
 *
 *  为什么在归一化之后合并而不是在原始 JSON 里改：
 *  ① `arena-pricing-table.json` 是 Arena 官方快照，`loadPricingTable` 还会用**实时抓取**的表
 *     覆盖它 —— 如果只管快照，实时表就没有 cache 费率。合并层放在归一化之后就一并覆盖了。
 *  ② 补充表是**另一个来源**，与官方价分开存储、各自可独立更新/回滚，不会互相污染。
 *
 *  合并时逐条标 `cache_rate_source`，运行时据此如实披露「非 Arena 官方口径」。
 *  只补不覆盖：Arena 官方若将来真的下发了 cache 费率，官方值优先，补充值不生效。 */
export function applyCacheRates(table, ratesDoc) {
  if (!table || !ratesDoc || typeof ratesDoc !== 'object') return table;
  const rates = ratesDoc.rates && typeof ratesDoc.rates === 'object' ? ratesDoc.rates : {};
  let applied = 0;
  for (const [key, entry] of Object.entries(rates)) {
    const profile = table.profile(key);
    if (!profile || profile.kind === 'media') continue;
    const read = entry?.cache_read_usd_per_mtok;
    const write = entry?.cache_write_usd_per_mtok;
    const hasRead = nonNeg(read);
    const hasWrite = nonNeg(write);
    if (!hasRead && !hasWrite) continue;
    // 只有实际补入字段才标记第三方来源；不能把已有官方费率误标为 OpenRouter。
    const fillRead = profile.cache_read_usd_per_mtok === null && hasRead;
    const fillWrite = profile.cache_write_usd_per_mtok === null && hasWrite;
    if (!fillRead && !fillWrite) continue;
    if (fillRead) profile.cache_read_usd_per_mtok = Number(read);
    if (fillWrite) profile.cache_write_usd_per_mtok = Number(write);
    profile.cache_rate_source = 'openrouter-public';
    profile.cache_rate_or_id = typeof entry?.or_id === 'string' ? entry.or_id : null;
    profile.cache_rate_batch = entry?.batch === true;          // 来自 :batch 半价条目 → 需标注
    profile.cache_rate_consistent = entry?.consistent !== false;
    applied += 1;
  }
  table.cache_rates = {
    applied,
    source: typeof ratesDoc.source === 'string' ? ratesDoc.source : null,
    fetched_at: typeof ratesDoc.fetched_at === 'string' ? ratesDoc.fetched_at : null,
    caveat: typeof ratesDoc.caveat === 'string' ? ratesDoc.caveat : null,
  };
  return table;
}

/** 把 OpenRouter 公开价目里 **Arena 榜单没有的** 模型整行合并进单价表文档（v2.19.6）。
 *
 *  为什么需要：Arena 榜单只覆盖它自己上架的 208 个模型，而实际会话可能跑在榜单之外的模型上
 *  （实测：`deepseek/deepseek-v4-flash-vision-exp` 既不在榜单、也不在指纹库，
 *   但它的费率能逐项解释真实账单）。参考扩展 cost-browser-extension 的做法就是
 *  「完整官方价格未匹配，使用公开价格补充」。
 *
 *  合并策略 —— **只加不覆盖**：Arena 已有的 model_key 一律以 Arena 为准（它是 Arena 会话的
 *  权威计费口径，OpenRouter 只是公开挂牌价）。返回**新文档**，不改动入参。
 *  只收 in/out 都为正的行（计价单位才是「每 Mtok」，能参与整数反推）。 */
export function mergeOpenRouterPrices(doc, pricesDoc) {
  if (!doc || !pricesDoc || typeof pricesDoc !== 'object') return doc;
  const rows = Array.isArray(pricesDoc.rows) ? pricesDoc.rows : [];
  if (!rows.length) return doc;
  const base = Array.isArray(doc.rows) ? doc.rows : [];
  const have = new Set(base.map((r) => (r && typeof r.model_key === 'string' ? r.model_key : null)).filter(Boolean));
  const num = (value) => (value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
  const extra = [];
  for (const row of rows) {
    const key = row && typeof row.model_key === 'string' ? row.model_key : '';
    if (!key || have.has(key)) continue;
    const input = num(row.input_usd_per_mtok);
    const output = num(row.output_usd_per_mtok);
    if (!(input > 0 && output > 0)) continue;
    have.add(key);
    extra.push({
      model_key: key,
      display: row.display ? String(row.display) : key,
      org: row.org ? String(row.org) : null,
      input_usd_per_mtok: input,
      output_usd_per_mtok: output,
      cache_read_usd_per_mtok: num(row.cache_read_usd_per_mtok),
      cache_write_usd_per_mtok: num(row.cache_write_usd_per_mtok),
      source: 'openrouter-public',
    });
  }
  if (!extra.length) return doc;
  return {
    ...doc,
    rows: [...base, ...extra],
    openrouter_supplement: {
      added: extra.length,
      source: typeof pricesDoc.source === 'string' ? pricesDoc.source : null,
      fetched_at: typeof pricesDoc.fetched_at === 'string' ? pricesDoc.fetched_at : null,
      caveat: typeof pricesDoc.caveat === 'string' ? pricesDoc.caveat : null,
    },
  };
}

/** 把已揭示 Battle 训练集提炼出的稳定实测费率合并进原始价目文档。
 *
 *  输入必须是脱敏后的 `arena-battle-price-rates-v1`，而不是带 prompt/response 的训练集本体。
 *  优先级严格为 Battle 同消息实测价 > Arena 官方参考价 > 其他公开补充价。命中同 key 时用
 *  实测费率作为主值，同时把原官方费率保存在 `arena_official_reference` 供披露/辅助，不丢数据。
 *  生成器已要求 input/output 正费率在该模型全部样本中一致；这里再做边界校验。 */
export function mergeBattleObservedPrices(doc, ratesDoc) {
  if (!doc || !ratesDoc || ratesDoc.schema !== 'arena-battle-price-rates-v1') return doc;
  const rows = Array.isArray(ratesDoc.rows) ? ratesDoc.rows : [];
  if (!rows.length) return doc;
  const base = Array.isArray(doc.rows) ? doc.rows : [];
  const num = (value) => (value === null || value === undefined || value === ''
    ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
  const optionalPositive = (value) => { const parsed = num(value); return parsed > 0 ? parsed : null; };
  const observed = new Map();
  for (const row of rows) {
    const key = row && typeof row.model_key === 'string' ? row.model_key.trim() : '';
    if (!key || key.length > 160 || observed.has(key)) continue;
    const input = num(row.input_usd_per_mtok);
    const output = num(row.output_usd_per_mtok);
    if (!(input > 0 && output > 0)) continue;
    if (row.confidence && row.confidence !== 'unanimous-positive-rates') continue;
    observed.set(key, {
      model_key: key,
      display: typeof row.display === 'string' && row.display ? row.display : key,
      org: typeof row.org === 'string' && row.org ? row.org : null,
      input_usd_per_mtok: input,
      output_usd_per_mtok: output,
      cache_read_usd_per_mtok: optionalPositive(row.cache_read_usd_per_mtok),
      cache_write_usd_per_mtok: optionalPositive(row.cache_write_usd_per_mtok),
      source: 'arena-battle-observed',
      observed_samples: row.observed_samples && typeof row.observed_samples === 'object'
        ? {...row.observed_samples} : null,
    });
  }
  if (!observed.size) return doc;
  let overridden = 0;
  const mergedRows = base.map(row => {
    const hit = observed.get(row?.model_key);
    if (!hit) return row;
    observed.delete(row.model_key);
    overridden += 1;
    return {
      ...row,
      ...hit,
      display: row.display || hit.display,
      org: row.org || hit.org,
      arena_official_reference: {
        input_usd_per_mtok: num(row.input_usd_per_mtok),
        output_usd_per_mtok: num(row.output_usd_per_mtok),
        cache_read_usd_per_mtok: num(row.cache_read_usd_per_mtok),
        cache_write_usd_per_mtok: num(row.cache_write_usd_per_mtok),
      },
    };
  });
  const extra = [...observed.values()];
  return {
    ...doc,
    rows: [...mergedRows, ...extra],
    battle_observed_supplement: {
      applied: overridden + extra.length,
      added: extra.length,
      overridden,
      source: typeof ratesDoc.source === 'string' ? ratesDoc.source : null,
      generated_at: typeof ratesDoc.generated_at === 'string' ? ratesDoc.generated_at : null,
      training_generated_at: typeof ratesDoc.training_generated_at === 'string' ? ratesDoc.training_generated_at : null,
      policy: typeof ratesDoc.policy === 'string' ? ratesDoc.policy : null,
    },
  };
}

/** 归并成按 model_key 索引的单价档案。
 *
 *  每行按计价方式分两类：
 *    kind='text'  —— 输入/输出**都是正数**，可按 token 折算成本，参与反推。
 *    kind='media' —— 图像/视频模型（gpt-image 只有输入价、sora/veo/imagen 只有输出价），
 *                    单价单位其实是「每张/每秒」而非每 Mtok，**不能**参与 token 反推。
 */
export function normalizePricingTable(table) {
  validatePricingTable(table);
  const byKey = new Map();
  for (const row of table.rows) {
    const input = nonNeg(row.input_usd_per_mtok) ? Number(row.input_usd_per_mtok) : null;
    const output = nonNeg(row.output_usd_per_mtok) ? Number(row.output_usd_per_mtok) : null;
    const record = {
      model_key: String(row.model_key),
      display: row.display ? String(row.display) : String(row.model_key),
      org: row.org ? String(row.org) : null,
      kind: input > 0 && output > 0 ? 'text' : 'media',
      input_usd_per_mtok: input,
      output_usd_per_mtok: output,
      cache_read_usd_per_mtok: nonNeg(row.cache_read_usd_per_mtok) ? Number(row.cache_read_usd_per_mtok) : null,
      cache_write_usd_per_mtok: nonNeg(row.cache_write_usd_per_mtok) ? Number(row.cache_write_usd_per_mtok) : null,
    };
    byKey.set(record.model_key, record);
  }
  const all = [...byKey.values()];
  const text = all.filter((r) => r.kind === 'text');
  const textKeys = text.map((r) => r.model_key);

  /** 基础 id → 变体 key。精确命中优先；否则前缀匹配 + 最长前缀优先。 */
  const resolve = (baseId) => {
    const aliases = bankAliases(baseId);
    if (!aliases.length) return [];
    const exact = textKeys.find((k) => aliases.includes(k));
    if (exact) return [exact];
    const scored = [];
    for (const key of textKeys) {
      let best = 0;
      for (const alias of aliases) {
        const len = aliasMatchLength(key, alias);
        if (len > best) best = len;
      }
      if (best) scored.push({key, len: best});
    }
    if (!scored.length) return [];
    const longest = Math.max(...scored.map((s) => s.len));
    return scored.filter((s) => s.len === longest).map((s) => s.key);
  };

  return {
    schema: table.schema,
    source: table.source || null,
    fetched_at: table.fetched_at || null,
    unit: table.unit || PRICING_UNIT,
    rows: table.rows.length,
    models: byKey.size,
    text_models: text.length,
    media_models: all.length - text.length,
    byKey,
    profile: (key) => byKey.get(key) || null,
    all: () => [...byKey.values()],
    text: () => text.slice(),
    resolve,
  };
}

/** 单价表的展示文本：`$4/$20 每 Mtok`；非 token 计价模型标注出来。 */
export function describePrice(profile) {
  if (!profile) return '—';
  const fmt = (v) => (nonNeg(v) ? `$${Number(v.toFixed(4))}` : '—');
  const text = `${fmt(profile.input_usd_per_mtok)}/${fmt(profile.output_usd_per_mtok)} 每 Mtok`;
  return profile.kind === 'media' ? `${text}（按张/秒计，不可按 token 反推）` : text;
}

/**
 * 本次请求在该模型下的期望成本。
 * usage 用 usage-channel 归一化后的 camelCase 字段。
 * 缓存单价缺失时：缓存 token 不计入，并标 complete=false（期望值只是下界）。
 * 非 token 计价模型（kind='media'）返回 token_priced=false，调用方不应据此反推。
 */
export function expectedCostUsd(usage, profile, options = {}) {
  if (!usage || !profile) return null;
  const tokenPriced = profile.kind !== 'media';
  const cacheReadRate = nonNeg(options.cacheReadUsdPerMtok) ? options.cacheReadUsdPerMtok : profile.cache_read_usd_per_mtok;
  const cacheWriteRate = nonNeg(options.cacheWriteUsdPerMtok) ? options.cacheWriteUsdPerMtok : profile.cache_write_usd_per_mtok;
  let usd = 0;
  let covered = 0;
  let uncovered = 0;
  const add = (tokens, rate) => {
    const count = nonNeg(tokens) ? tokens : 0;
    if (nonNeg(rate)) { usd += (count / 1e6) * rate; covered += count; }
    else uncovered += count;
  };
  add(usage.inputTokens, profile.input_usd_per_mtok);
  add(usage.outputTokens, profile.output_usd_per_mtok);
  add(usage.cacheReadTokens, cacheReadRate);
  add(usage.cacheWriteTokens, cacheWriteRate);
  return {
    usd: Number(usd.toFixed(6)),
    complete: uncovered === 0,
    token_priced: tokenPriced,
    covered_tokens: covered,
    uncovered_tokens: uncovered,
  };
}

/** 实际成本 vs 期望成本的一致性。 */
export function costMatch(observedUsd, usage, profile, options = {}) {
  if (!(nonNeg(observedUsd) && observedUsd > 0) || !usage || !profile) return {applicable: false};
  const expected = expectedCostUsd(usage, profile, options);
  if (!expected || expected.usd <= 0) return {applicable: false};
  if (!expected.token_priced) return {applicable: false, note: '该模型非 token 计价，不能按用量反推'};
  const ratio = observedUsd / expected.usd;
  const z = Math.log(ratio) / Math.log(CONSISTENT_RATIO);
  return {
    applicable: true,
    expected_usd: expected.usd,
    observed_usd: Number(observedUsd.toFixed(6)),
    ratio: Number(ratio.toFixed(3)),
    z: Number(z.toFixed(2)),
    complete: expected.complete,
    consistent: Math.abs(z) <= 1,
    note: Math.abs(z) <= 1 ? '相符' : ratio > 1 ? '实测比该模型贵' : '实测比该模型便宜',
  };
}

/** 候选（Arena key 或指纹库基础 id）→ 它对应的单价档案列表。 */
function profilesOf(candidate, table) {
  const key = typeof candidate === 'string' ? candidate : candidate?.model_key || candidate?.id;
  if (!key) return {key: null, profiles: []};
  const direct = table.profile(key);
  if (direct && direct.kind !== 'media') return {key, profiles: [direct]};
  const profiles = (table.resolve ? table.resolve(key) : [])
    .map((k) => table.profile(k))
    .filter((p) => p && p.kind !== 'media');
  return {key, profiles};
}

/** 用「实际成本 + 本次用量」给候选模型排序（比值越接近 1 权重越高）。
 *  候选可以是 Arena 变体 key，也可以是指纹库基础 id（自动展开到全部变体，取最贴合的一档）。 */
export function rankByObservedCost(observedUsd, usage, candidates, table, limit = 5) {
  if (!(nonNeg(observedUsd) && observedUsd > 0) || !usage || !table || !Array.isArray(candidates)) return null;
  const scored = [];
  for (const candidate of candidates) {
    const {key, profiles} = profilesOf(candidate, table);
    if (!key || !profiles.length) continue;
    let best = null;
    for (const profile of profiles) {
      const match = costMatch(observedUsd, usage, profile);
      if (!match.applicable) continue;
      // 比值取对数后的高斯核；缓存单价缺失时降权（期望值只是下界）。
      const z = Math.log(match.ratio) / Math.log(CONSISTENT_RATIO);
      const weight = Math.exp(-0.5 * z * z) * (match.complete ? 1 : 0.6);
      if (!best || weight > best.weight
        || (weight === best.weight && pricingSourcePriority(profile.price_source) < pricingSourcePriority(best.price_source))) {
        best = {
          model_key: key,
          matched_key: profile.model_key,
          label: profile.display,
          price_source: profile.price_source || null,
          observed_samples: profile.battle_observed_samples || null,
          official_reference_rates: profile.official_reference_rates || null,
          expected_usd: match.expected_usd,
          ratio: match.ratio,
          complete: match.complete,
          variants: profiles.length,
          weight,
          rates: {
            input_usd_per_mtok: profile.input_usd_per_mtok,
            output_usd_per_mtok: profile.output_usd_per_mtok,
            cache_read_usd_per_mtok: profile.cache_read_usd_per_mtok,
            cache_write_usd_per_mtok: profile.cache_write_usd_per_mtok,
            cache_rate_source: profile.cache_rate_source || null,
            cache_rate_batch: profile.cache_rate_batch === true,
          },
        };
      }
    }
    if (best) scored.push(best);
  }
  if (!scored.length) return null;
  const total = scored.reduce((sum, item) => sum + item.weight, 0);
  for (const item of scored) item.weight = total > 0 ? Number((item.weight / total).toFixed(4)) : 0;
  scored.sort((a, b) => b.weight - a.weight
    || Math.abs(Math.log(a.ratio)) - Math.abs(Math.log(b.ratio))
    || pricingSourcePriority(a.price_source) - pricingSourcePriority(b.price_source)
    || String(a.model_key).localeCompare(String(b.model_key)));
  return scored.slice(0, Math.max(1, limit));
}

/** 区分度：候选里期望成本的最小/最大比值，以及「价格能否把候选切开」。
 *
 *  一个基础 id 往往对应多档变体（agent/webdev/text），单价不同，所以每个候选给出
 *  一个 [min_usd, max_usd] 区间；只有当所有候选区间两两不重叠时，
 *  单靠价格才能唯一确定模型（separable=true）。 */
export function discrimination(usage, candidates, table) {
  if (!usage || !table || !Array.isArray(candidates)) return null;
  const values = [];
  for (const candidate of candidates) {
    const {key, profiles} = profilesOf(candidate, table);
    if (!key || !profiles.length) continue;
    const usds = [];
    for (const profile of profiles) {
      const expected = expectedCostUsd(usage, profile);
      if (expected && expected.usd > 0) usds.push(expected.usd);
    }
    if (!usds.length) continue;
    values.push({
      model_key: key,
      label: profiles[0].display,
      usd: Number((usds.reduce((a, b) => a + b, 0) / usds.length).toFixed(6)),
      min_usd: Math.min(...usds),
      max_usd: Math.max(...usds),
      variants: usds.length,
    });
  }
  if (values.length < 2) return null;
  values.sort((a, b) => a.min_usd - b.min_usd);
  // 区间两两不重叠 = 价格可唯一区分
  let separable = true;
  for (let i = 1; i < values.length; i += 1) if (values[i].min_usd <= values[i - 1].max_usd) { separable = false; break; }
  const lo = values[0].min_usd;
  const hi = values[values.length - 1].max_usd;
  return {
    span: Number((hi / lo).toFixed(2)),
    separable,
    min: values[0],
    max: values[values.length - 1],
    rows: values,
  };
}

/** 表摘要，供浮层/自检显示。 */
export function pricingSummary(table) {
  if (!table) return null;
  const priced = table.all().filter((p) => p.kind !== 'media');
  const inputs = priced.map((p) => p.input_usd_per_mtok).filter((v) => v > 0);
  const outputs = priced.map((p) => p.output_usd_per_mtok).filter((v) => v > 0);
  return {
    source: table.source,
    fetched_at: table.fetched_at,
    unit: table.unit,
    models: table.models,
    text_models: priced.length,
    media_models: table.all().length - priced.length,
    input_range: inputs.length ? [Math.min(...inputs), Math.max(...inputs)] : null,
    output_range: outputs.length ? [Math.min(...outputs), Math.max(...outputs)] : null,
  };
}

/* ---------------------------------------------------------------------------
   指纹库 id ↔ Arena 单价 key 的归一化。

   实测（2026-10-11）两套命名并不相同：
     指纹库（modeltrace/whatsmyllm bank）：基础模型 id，如 gpt-6-astra / claude-opus-5-5
     Arena 榜单（单价表）           ：变体 key，如 gpt-6-astra-max-agent / claude-opus-5.5-high-vertex-agent
   即 Arena key = <基础 id>-<档位>-<载体>，档位/载体词表实测包含：
     max / high / xhigh / medium / minimal / thinking(-32k/-16k) / instant / preview / lite / public /
     agent / webdev / text / vertex / code-codex-harness / no-system-prompt
   于是「基础 id 是 Arena key 的前缀、且后缀从 `-` 开始」就是匹配规则。

   两个必须显式处理的坑（都已实测）：
   1. 版本号分隔符不一致：指纹库写 `claude-opus-5-5`，Arena 写 `claude-opus-5.5`。
      → 额外生成一个「末两位数字改用点号」的别名一起匹配。
   2. 前缀吞并：`claude-sonnet-5` 是 `claude-sonnet-5-5-xhigh` 的前缀，
      会把 sonnet-5.5 的行错算到 sonnet-5 头上。
      → 最长前缀优先（longest-prefix-wins）消歧。
   注意：不能用「把点号也换成短横」这种粗暴归一化——那会让 `claude-opus-5` 吞掉
   `claude-opus-5.5-*`，两个模型直接混淆。点号必须保留为「非边界字符」。
   --------------------------------------------------------------------------- */

/** 基础 id 的候选别名（原样 + 末两位数字改用点号）。 */
export function bankAliases(baseId) {
  if (typeof baseId !== 'string' || !baseId.trim()) return [];
  const id = baseId.trim().toLowerCase();
  const dotted = id.replace(/(\d)-(\d)$/, '$1.$2');
  return dotted === id ? [id] : [id, dotted];
}

/** key 是否以 alias 为前缀；命中返回 alias 长度，否则返回 0。
 *
 *  边界必须落在 `-`（或正好结尾），否则 `claude-opus-5` 会吞掉 `claude-opus-5.5-*`。
 *  另外前缀之后的第一个 token 若是**裸数字**（1~2 位），说明那是版本续写而非档位，
 *  同样不算命中——否则 `claude-sonnet-5` 会吞掉 `claude-sonnet-5-5-xhigh`。
 *  （长日期后缀如 `-20260517` 属正常变体，不在此列。） */
function aliasMatchLength(key, alias) {
  if (key === alias) return alias.length;
  if (!key.startsWith(alias + '-')) return 0;
  const first = key.slice(alias.length + 1).split('-')[0];
  return /^\d{1,2}$/.test(first) ? 0 : alias.length;
}

/** 基础 id → 该模型在 Arena 单价表里的全部变体 key（已按最长前缀消歧）。 */
export function resolvePricingKeys(baseId, table) {
  if (!table || typeof table.resolve !== 'function') return [];
  return table.resolve(baseId);
}

/** 基础 id 的价格档位汇总：命中哪些变体、输入/输出价区间。 */
export function bankPricing(baseId, table) {
  if (!table) return null;
  const keys = resolvePricingKeys(baseId, table);
  if (!keys.length) return {base: baseId, priced: false, keys: [], variants: [], input_range: null, output_range: null};
  const rows = keys.map((k) => table.profile(k)).filter(Boolean);
  if (!rows.length) return {base: baseId, priced: false, keys: [], variants: [], input_range: null, output_range: null};
  const ins = rows.map((r) => r.input_usd_per_mtok);
  const outs = rows.map((r) => r.output_usd_per_mtok);
  return {
    base: baseId,
    priced: true,
    keys,
    variants: rows.map((r) => ({
      model_key: r.model_key,
      display: r.display,
      input_usd_per_mtok: r.input_usd_per_mtok,
      output_usd_per_mtok: r.output_usd_per_mtok,
      text: describePrice(r),
    })),
    input_range: [Math.min(...ins), Math.max(...ins)],
    output_range: [Math.min(...outs), Math.max(...outs)],
  };
}

/* ---------- 四项分项整数反推（硬筛选）----------

   来源：Arena /api/chat/:id/cost 的每条消息带四项**分项费用**
   （inputTokensCostUsd / outputTokensCostUsd / cacheWriteTokensCostUsd / cacheReadTokensCostUsd）。
   思路借鉴参考扩展 cost-browser-extension 的 constrainByPrices：
       对每个模型，token数 = 分项费用 × 1e6 ÷ 该模型单价，要求**正整数**（容差 1e-6）。
   这是**硬约束**：能整除的模型才有资格当候选，其余直接出局。

   与软判据（rankByObservedCost 的 log 比值高斯核）的区别：
   · 硬筛选给「是/否」——不整除就是不整除，没有权重可调；
   · 软判据给「像/不像」——靠阈值排序，永远有第一名。

   诚实在前（实测结论，dev-scratch/_verify-constraint-strength.mjs）：
   把 read 费用随机扰动 ±20% 跑 200 次 → 候选数**恒为 0**；真实样本能出 2 个候选。
   这说明整除是**真实约束**而非数字巧合，但也说明**筛选极度脆弱** ——
   费用数值稍有偏差就全灭。所以硬筛选出唯一解可以定名，出多解/零解一律降级。 */

/* /cost may expose modality-specific charges, but USAGE_SCHEMA has no matching
   image/video/audio count. Such a row must not be compared with text-token rates. */
const NON_TOKEN_MEDIA_COST_KEYS = new Set([
  'priceperimage',
  'imageinputtokenscostusd', 'imageoutputtokenscostusd', 'imagegenerationcostusd',
  'videoinputtokenscostusd', 'videooutputtokenscostusd', 'videogenerationcostusd',
  'audioinputtokenscostusd', 'audiooutputtokenscostusd', 'audiogenerationcostusd',
]);

export function hasNonTokenMediaCost(payload) {
  if (!payload || typeof payload !== 'object') return false;
  for (const source of [payload.actual, payload]) {
    if (!source || typeof source !== 'object') continue;
    if (source.non_token_media_cost === true || source.has_non_token_media_cost === true) return true;
    for (const [field, value] of Object.entries(source)) {
      const key = String(field).toLowerCase().replace(/[^a-z0-9]/g, '');
      const amount = Number(value);
      if (NON_TOKEN_MEDIA_COST_KEYS.has(key) && Number.isFinite(amount) && amount > 0) return true;
    }
  }
  return false;
}

/** 分项费用形状：四项都是「美元」金额（非 token 数）。 */
export function normalizeCostBreakdown(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const actual = payload.actual && typeof payload.actual === 'object' ? payload.actual : payload;
  const nonTokenMediaCost = hasNonTokenMediaCost(payload);
  const pick = (key) => {
    const v = actual[key];
    return finite(v) && v >= 0 ? Number(v) : null;
  };
  const input = pick('inputTokensCostUsd');
  const output = pick('outputTokensCostUsd');
  const cacheWrite = pick('cacheWriteTokensCostUsd');
  const cacheRead = pick('cacheReadTokensCostUsd');
  const total = pick('totalCostUsd');
  const base = finite(payload.basePriceUsd) && payload.basePriceUsd >= 0 ? Number(payload.basePriceUsd) : null;
  const strategy = typeof payload.pricingStrategy === 'string' ? payload.pricingStrategy : null;
  const fallback = actual.isFallback === true;
  if ([input, output, cacheWrite, cacheRead].every((v) => v === null) && !nonTokenMediaCost) return null;
  /* 分项之和必须与总额自洽（容差同参考扩展：max(1e-9, total×1e-6)）。不自洽 = 这份账单不可信。 */
  const sum = [input, output, cacheWrite, cacheRead].reduce((s, v) => s + (v || 0), 0);
  const totalConsistent = total === null ? null : Math.abs(sum - total) <= Math.max(1e-9, total * 1e-6);
  return {
    input_usd: input || 0,
    output_usd: output || 0,
    cache_write_usd: cacheWrite || 0,
    cache_read_usd: cacheRead || 0,
    total_usd: total,
    base_usd: base,
    pricing_strategy: strategy,
    is_fallback: fallback,
    total_consistent: totalConsistent,
    any_cache: (cacheWrite || 0) > 0 || (cacheRead || 0) > 0,
    has_non_token_media_cost: nonTokenMediaCost,
  };
}

/** 单条账单在单个模型档案下的整数反推。返回 {ok, counts, missing_rates}。 */
function solveIntegerCounts(breakdown, profile) {
  const spec = [
    [breakdown.input_usd, profile.input_usd_per_mtok, 'I'],
    [breakdown.output_usd, profile.output_usd_per_mtok, 'O'],
    [breakdown.cache_write_usd, profile.cache_write_usd_per_mtok, 'W'],
    [breakdown.cache_read_usd, profile.cache_read_usd_per_mtok, 'R'],
  ];
  const counts = {};
  const missing = [];
  for (const [cost, rate, key] of spec) {
    if (!(cost > 0)) { counts[key] = 0; continue; }                 // 该分项为 0 → 推定 token 数为 0
    if (!(nonNeg(rate) && rate > 0)) { counts[key] = null; missing.push(key); continue; }  // 缺费率
    const raw = cost * 1e6 / rate;
    const n = Math.round(raw);
    if (!Number.isInteger(n) || n <= 0 || Math.abs(raw - n) > 1e-6) return {ok: false, reason: 'not-integer', counts: null, missing_rates: missing};
    counts[key] = n;
  }
  return {ok: true, counts, missing_rates: missing};
}

/** 按「四项费率完全相同」分组（比只看 input/output 更细）。 */
function groupByRates(candidates) {
  const buckets = new Map();
  for (const c of candidates) {
    const key = JSON.stringify([c.rates.input, c.rates.output, c.rates.cache_write, c.rates.cache_read]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c.model_key);
  }
  return [...buckets.entries()].map(([key, ids]) => ({
    rates: JSON.parse(key),
    ids: [...new Set(ids)],
    ambiguous: new Set(ids).size > 1,
  }));
}

/** 变体 key → 基础模型名：剥掉 harness / effort 后缀与日期戳，用于「同一模型」折叠。
 *  例：qwen3.7-plus-agent → qwen3.7-plus；claude-opus-4-7-thinking-webdev → claude-opus-4-7。
 *  只做机械剥壳，不猜语义 —— 剥完为空就退回原 key（宁可少折叠，不可错折叠）。 */
export function baseModelName(modelKey) {
  let s = String(modelKey || '').toLowerCase().trim();
  if (!s) return s;
  s = s.replace(/-\d{8}$/, '');                                              // 日期戳 -20260910
  let prev = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(/-(?:agent|webdev|text|code|thinking|vertex|public|preview|codex-harness|code-arena-harness)$/, '');
  }
  s = s.replace(/-(?:max|high|xhigh|low|medium|minimal)$/, '');              // 档位词只在最后剥一次
  return s || String(modelKey || '').toLowerCase().trim();
}

/** 硬筛选：拿分项账单在候选集（或全库）里做整数反推。
 *
 *  返回 {state, candidates, partial, excluded_media, note, ...}
 *  state:
 *    'unique'            —— 只有一个模型能整除（可定名）
 *    'multiple'          —— 多个模型能整除（不可定名，列出候选）
 *    'none'              —— 没有任何模型能整除
 *    'partial-only'      —— 只有缺费率的模型进 partial（cache 费率仍不全时会出现）
 *    'missing-cost'      —— 账单分项缺失 / 是估算费用
 *    'off-integer-grid'  —— 四项之和与总额不自洽（账单不可信）
 */
export function hardFilterByCosts(breakdown, table, options = {}) {
  if (!breakdown) return {state: 'missing-cost', candidates: [], partial: [], note: '账单没有可用的分项费用。'};
  if (breakdown.is_fallback === true) return {state: 'missing-cost', candidates: [], partial: [], note: '该条是估算费用（isFallback），不参与整数反推。'};
  if (breakdown.has_non_token_media_cost === true) return {
    state: 'non-token-media-cost', candidates: [], partial: [], excluded_media: 0,
    note: '账单含图像/视频/音频专属费用，但用量没有对应模态计数；不能按纯 token 费率反推。',
  };
  if (breakdown.total_consistent === false) return {state: 'off-integer-grid', candidates: [], partial: [], note: '四项分项之和与总额不自洽 —— 这份账单不可信，不做反推。'};
  if (!table || typeof table.all !== 'function') return {state: 'missing-cost', candidates: [], partial: [], note: '单价表不可用。'};

  const keys = Array.isArray(options.keys) && options.keys.length
    ? options.keys.map((k) => table.profile(k)).filter(Boolean)
    : table.all();
  const candidates = [];
  const partial = [];
  let excludedMedia = 0;

  for (const profile of keys) {
    if (profile.kind === 'media') { excludedMedia += 1; continue; }   // 按张/秒计价，不能参与 token 反推
    const solved = solveIntegerCounts(breakdown, profile);
    if (!solved.ok) continue;
    if (solved.missing_rates.length) {
      partial.push({model_key: profile.model_key, display: profile.display, counts: solved.counts, missing_rates: solved.missing_rates});
      continue;
    }
    candidates.push({
      model_key: profile.model_key,
      display: profile.display,
      org: profile.org,
      counts: solved.counts,
      rates: {
        input: profile.input_usd_per_mtok,
        output: profile.output_usd_per_mtok,
        cache_write: profile.cache_write_usd_per_mtok,
        cache_read: profile.cache_read_usd_per_mtok,
      },
      cache_rate_source: profile.cache_rate_source || null,
      cache_rate_batch: profile.cache_rate_batch === true,
      price_source: profile.price_source || null,
      observed_samples: profile.battle_observed_samples || null,
      official_reference_rates: profile.official_reference_rates || null,
    });
  }

  /* 表顺序不能决定并列代表：完全同价/同分时严格按 Battle > 官方 > OpenRouter。
     这只改变展示和同基础名去重时保留哪一行，不改变整除结果或唯一性判据。 */
  candidates.sort((a, b) => pricingSourcePriority(a.price_source) - pricingSourcePriority(b.price_source));

  /* 同一模型的多个变体 key 会重复计数 —— 例如 `qwen3.7-plus`（text 档）与
     `qwen3.7-plus-agent`（agent 档）单价与反推结果完全相同，若不去重会把「1 个候选」
     说成「2 个候选」，凭空把唯一解降级成多解。按**归一化后的基础名**折叠：
     剥掉 harness/effort 后缀（-agent/-webdev/-text/-code/-thinking 及档位词）+ 日期戳。 */
  const seen = new Set();
  const uniqueCandidates = [];
  for (const c of candidates) {
    const base = baseModelName(c.model_key);
    if (seen.has(base)) continue;
    seen.add(base);
    uniqueCandidates.push({...c, base_name: base});
  }

  const tokenGroups = [...new Map(uniqueCandidates.map((c) => [JSON.stringify(c.counts), c.counts])).values()];
  const samePriceGroups = groupByRates(uniqueCandidates);

  const state = uniqueCandidates.length === 1 ? 'unique'
    : uniqueCandidates.length > 1 ? 'multiple'
      : partial.length ? 'partial-only' : 'none';

  const usesBatchRate = uniqueCandidates.some((c) => c.cache_rate_batch);
  const winner = uniqueCandidates[0];
  const note = state === 'unique'
    ? `唯一整数解：${winner.display || winner.model_key}`
    : state === 'multiple'
      ? `${uniqueCandidates.length} 个模型都能整除这份账单 —— 更多费用记录仍无法切开`
      : state === 'partial-only'
        ? `${partial.length} 个模型的费率不全（缺 ${[...new Set(partial.flatMap((p) => p.missing_rates))].join('/')}），只能进待定`
        : '没有任何模型能整除这份账单';

  return {
    state,
    candidates: uniqueCandidates,
    partial,
    token_groups: tokenGroups,
    same_price_groups: samePriceGroups,
    excluded_media: excludedMedia,
    uses_batch_rate: usesBatchRate,
    checked_models: keys.length,
    note,
  };
}
