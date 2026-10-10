/* v2.9.0 轨迹直读：用 arena.ai 响应头里的 public-access-token（trigger.dev 公开 JWT）
   读取这次运行的 OTel 轨迹，从 span attributes 里挖三层模型信息：
     1) Arena 内部 modelName
     2) provider 请求模型（ai.model.id / gen_ai.request.model / llm.request_model …）
     3) provider 响应模型（ai.response.model / gen_ai.response.model / llm.response_model …）

   端点事实（trigger.dev 官方文档，2026-10 核对）：
     · GET /api/v1/runs/{runId}/trace   → { trace: { traceId, rootSpan{…, attributes, children[]} } }
     · GET /api/v3/runs/{runId}         → 运行对象；用 Public key 认证时官方会省略 payload/output
     · GET /api/v1/runs/{runId}/events  → span 事件
   官方 OpenAPI 把 trace 标成 secretKey 认证，但公开 JWT 是「read 该 run」的凭证，
   实际是否放行取决于服务端策略 —— 所以这里按候选阶梯逐个试，并把每个端点的成败原样返回，
   拿不到就明说拿不到，绝不猜一个模型名充数。 */

const DEFAULT_BASE = 'https://api.trigger.dev';
const RUN_RE = /\brun_[A-Za-z0-9]{4,80}\b/;

function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  let binary;
  try { binary = atob(padded); } catch { return null; }
  const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}
// (deactivated below: its heuristic accepted ANY string shorter than 80 chars, so an unrelated
//  run_* inside an email/note/URL could be queried as this run, and the model name of another
//  run could be reported as the live answer. Superseded by the strict findRunId further down.)
function findRunIdLegacy(claims) {
  const seen = new Set();
  const queue = [claims];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') {
        const match = item.match(RUN_RE);
        if (match && (/run|id|scope|sub|jti/i.test(key) || item.length < 80)) return match[0];
      } else if (item && typeof item === 'object') queue.push(item);
    }
  }
  return null;
}
function findRunId(claims) {
  // 只认「像 run id 的位置」：键名本身指向运行/资源/范围，或者值就是一枚干净的 run_*（无空白、≤64 字符）。
  // 旧写法允许任何 <80 字符的字符串命中，于是 email、备注、URL 里偶然出现的 run_* 会被当成本次运行
  // —— 那会去查别人的运行，甚至把别人的模型名当成现场结论。宁可返回 null 说「token 里没有 run id」。
  const KEY_RE = /^(run|runs|runid|run_id|runids|jti|sub|scope|resource|resources|payload|target|aud|principal)s?$/i;
  const looksLikeRunId = (value) => typeof value === 'string' && value.length <= 64 && !/\s/.test(value) && RUN_RE.test(value);
  const seen = new Set();
  const queue = [[claims, false]];
  while (queue.length) {
    const [value, keyTrusted] = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      const trusted = keyTrusted || KEY_RE.test(key);
      if (typeof item === 'string') {
        if (looksLikeRunId(item) && trusted) return item.match(RUN_RE)[0];
      } else if (item && typeof item === 'object') {
        queue.push([item, trusted]);
      }
    }
  }
  return null;
}

function findBaseUrl(claims) {
  // Never send a bearer token to an arbitrary host claimed inside an untrusted JWT.
  // Trigger.dev's documented public API host is fixed; unknown/custom hosts fall back to it.
  const keys = ['baseUrl', 'apiUrl', 'apiBaseUrl', 'base_url', 'api_url', 'url', 'endpoint', 'instanceUrl'];
  for (const key of keys) {
    const value = claims?.[key];
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.hostname === 'api.trigger.dev' && !url.username && !url.password) return DEFAULT_BASE;
    } catch { /* ignore malformed claims */ }
  }
  return DEFAULT_BASE;
}

/** 解析 token → { runId, base, claims }；runId 缺失时返回 null。 */
export function describeToken(token) {
  const claims = decodeJwt(token);
  if (!claims || typeof claims !== 'object') return null;
  const runId = findRunId(claims);
  if (!runId) return null;
  return { runId, base: findBaseUrl(claims), claims };
}

export function traceCandidates(runId, base) {
  const roots = [...new Set([base, DEFAULT_BASE].filter(Boolean))];
  const out = [];
  for (const root of roots) {
    out.push(`${root}/api/v1/runs/${runId}/trace`);
    out.push(`${root}/api/v3/runs/${runId}/trace`);
    out.push(`${root}/api/v1/runs/${runId}`);
    out.push(`${root}/api/v3/runs/${runId}`);
    out.push(`${root}/api/v1/runs/${runId}/events`);
  }
  return out;
}

const MODEL_ATTR_RE = /(gen_ai|ai|llm|arena|model|provider)[._a-z0-9-]*model[._a-z0-9-]*|modelname|model_name|modelaid|model_a_id/i;
const PROVIDER_REQUEST_RE = /request_model|request\.model|\.request\b|modelid|model\.id|model_id|modelaid/i;
const PROVIDER_RESPONSE_RE = /response_model|response\.model|\.response\b/i;
const VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,79}$/;
const NOISE_RE = /^(undefined|null|none|true|false|\d+)$/i;

function attrEntries(span) {
  const raw = span?.attributes;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => [String(item?.key ?? ''), item?.value]).filter(([key]) => key);
  }
  if (typeof raw === 'object') return Object.entries(raw).map(([key, value]) => [String(key), value]);
  return [];
}

function attrText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    if (typeof value.stringValue === 'string') return value.stringValue;
    if (typeof value.value === 'string') return value.value;
    if (Array.isArray(value)) return value.map(attrText).filter(Boolean).join(',');
  }
  return '';
}

function walkSpans(root) {
  const out = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const span = queue.shift();
    if (!span || typeof span !== 'object' || seen.has(span)) continue;
    seen.add(span);
    out.push(span);
    const children = span.children || span.childSpans || span.spans;
    if (Array.isArray(children)) queue.push(...children);
  }
  return out;
}

/** 从任意 JSON 里挖模型名，分三层归类。 */
export function collectModelEvidence(data) {
  const arena = new Set();
  const request = new Set();
  const response = new Set();
  const attributes = [];

  const keep = (value) => typeof value === 'string' && VALUE_RE.test(value.trim()) && !NOISE_RE.test(value.trim()) && !/https?:|^\/|\s/.test(value);

  const visitSpan = (span) => {
    for (const [key, raw] of attrEntries(span)) {
      const value = attrText(raw).trim();
      if (!value) continue;
      const modelAttribute = MODEL_ATTR_RE.test(key);
      const environmentAttribute = /(deployment[._-]?environment|service\.namespace|cloud\.region|provider\.name|arena\.environment)/i.test(key);
      // OTel span attributes may contain prompts or other user data. Retain only allowlisted
      // model/environment keys (short identifier values); never persist arbitrary attributes.
      if ((modelAttribute || environmentAttribute) && keep(value)) attributes.push({key, value: value.slice(0, 120)});
      if (!modelAttribute) continue;
      for (const token of value.split(/[,;\s]+/)) {
        if (!keep(token)) continue;
        if (PROVIDER_RESPONSE_RE.test(key)) response.add(token);
        else if (PROVIDER_REQUEST_RE.test(key)) request.add(token);
        else arena.add(token);
      }
    }
  };

  const visit = (value, depth, keyHint) => {
    if (depth > 8 || value === null || value === undefined) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 400)) visit(item, depth + 1, keyHint); return; }
    if (typeof value === 'object') {
      if (Array.isArray(value.attributes) || (value.attributes && typeof value.attributes === 'object')) visitSpan(value);
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string') {
          if (/modelname|model_name/i.test(key) && keep(item)) arena.add(item);
          else if (/^(model|modelid|model_id|modelaid|model_a_id|requestmodel|responsemodel)$/i.test(key) && keep(item)) {
            if (/response/i.test(key)) response.add(item); else if (/request/i.test(key)) request.add(item); else request.add(item);
          }
        } else visit(item, depth + 1, key);
      }
      return;
    }
  };

  visit(data, 0, '');
  const trim = (set) => [...set].slice(0, 12);
  return { arena: trim(arena), providerRequest: trim(request), providerResponse: trim(response), attributes: attributes.slice(0, 300) };
}

async function tryEndpoint(url, token, fetchImpl) {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const text = await response.text();
    const record = { url, status: response.status, ok: response.ok, ms: Date.now() - started, bytes: text.length, note: '' };
    if (!response.ok) {
      record.note = text.slice(0, 200).replace(/\s+/g, ' ');
      return record;
    }
    let data = null;
    try { data = JSON.parse(text); } catch { record.note = '响应不是 JSON'; return record; }
    record.evidence = collectModelEvidence(data);
    const root = data?.trace?.rootSpan || data?.rootSpan || data;
    record.spans = walkSpans(root).length;
    return record;
  } catch (error) {
    return { url, status: 0, ok: false, ms: Date.now() - started, bytes: 0, note: String(error?.message || error).slice(0, 200) };
  }
}

/**
 * 按候选阶梯查轨迹。命中条件：HTTP 200 且挖到了至少一个模型名。
 * 返回 { ok, runId, base, layers, endpoints, attempts, error }；JWT 不在返回对象或磁盘缓存中回显。
 */
export async function queryRunTrace({ token, fetchImpl = fetch, maxAttempts = 6, runIdHint = null }) {
  if (typeof token !== 'string' || token.split('.').length < 2) {
    return { ok: false, error: '缺少 public-access-token（响应头里没有，或还没触发过 Agent 运行）', attempts: [] };
  }
  const described = describeToken(token);
  const runId = runIdHint || described?.runId || (token.match(RUN_RE) || [null])[0];
  if (!runId) {
    return { ok: false, error: 'token 里找不到 run id（claims 已解析但无 run_*）', claims: described?.claims || null, attempts: [] };
  }
  const base = described?.base || DEFAULT_BASE;
  const attempts = [];
  let hit = null;
  for (const url of traceCandidates(runId, base)) {
    if (attempts.length >= maxAttempts) break;
    const record = await tryEndpoint(url, token, fetchImpl);
    attempts.push({ url: record.url, status: record.status, ok: record.ok, ms: record.ms, bytes: record.bytes, note: record.note });
    const found = record.evidence && (record.evidence.arena.length || record.evidence.providerRequest.length || record.evidence.providerResponse.length);
    if (record.ok && found) { hit = record; break; }
  }
  if (!hit) {
    return {
      ok: false,
      runId,
      base,
      error: '候选端点都没能同时满足「200」与「挖到模型名」；逐条结果见 attempts（401/403 说明公开 JWT 不放行该端点，需要服务端换发带 read 范围的 token）',
      attempts,
    };
  }
  return {
    ok: true,
    runId,
    base,
    endpoint: hit.url,
    spans: hit.spans,
    layers: hit.evidence,
    attempts,
    at: Date.now(),
  };
}
