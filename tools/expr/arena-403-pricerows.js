/* 严格重抽单价表：对 /leaderboard RSC 做花括号配对，逐行取该对象自己的价格，
   并把结果回传（不再用 +N 字符的近似窗口）。 */
const r = await fetch('/leaderboard', {headers: {'RSC': '1'}, credentials: 'include'});
const t = await r.text();

const rows = [];
let idx = 0;
while (true) {
  const k = t.indexOf('"modelKey"', idx);
  if (k < 0) break;
  idx = k + 10;
  // 向前找对象起点 {
  let s = k;
  while (s > 0 && t[s] !== '{') s--;
  // 花括号配对（含字符串转义处理）
  let depth = 0, e = -1, inStr = false, esc = false;
  for (let i = s; i < t.length && i < s + 4000; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { e = i; break; } }
  }
  if (e < 0) continue;
  const obj = t.slice(s, e + 1);
  const pick = (name) => {
    const m = obj.match(new RegExp('"' + name + '"\\s*:\\s*(null|-?\\d+(?:\\.\\d+)?|"(?:[^"\\\\]|\\\\.)*")'));
    if (!m) return undefined;
    const v = m[1];
    if (v === 'null') return null;
    if (v.startsWith('"')) return v.slice(1, -1);
    return Number(v);
  };
  rows.push({
    key: pick('modelKey'),
    display: pick('modelDisplayName'),
    org: pick('modelOrganization'),
    in: pick('inputPricePerMillion'),
    out: pick('outputPricePerMillion'),
    cacheR: pick('cacheReadPricePerMillion'),
    cacheW: pick('cacheWritePricePerMillion'),
    perTask: pick('costPerTaskUsd'),
  });
}

const uniq = new Map();
for (const x of rows) if (x.key && !uniq.has(x.key)) uniq.set(x.key, x);
const all = [...uniq.values()];
const priced = all.filter((x) => typeof x.in === 'number' && typeof x.out === 'number' && x.in > 0 && x.out > 0);

return {
  raw_rows: rows.length,
  unique_keys: all.length,
  priced_rows: priced.length,
  key_prefixes: [...new Set(all.map((x) => String(x.key).split('/')[0]))].slice(0, 10),
  perTask_nonnull: all.filter((x) => typeof x.perTask === 'number').length,
  cacheR_nonnull: all.filter((x) => typeof x.cacheR === 'number').length,
  cacheW_nonnull: all.filter((x) => typeof x.cacheW === 'number').length,
  media_like: all.filter((x) => typeof x.in !== 'number' || typeof x.out !== 'number').map((x) => ({key: x.key, in: x.in, out: x.out})).slice(0, 20),
  media_count: all.filter((x) => !(typeof x.in === 'number' && typeof x.out === 'number' && x.in > 0 && x.out > 0)).length,
  sample: priced.slice(0, 10).map((x) => ({key: x.key, in: x.in, out: x.out, org: x.org})),
  astra: priced.find((x) => /gpt-6-astra-max-agent$/.test(x.key)),
  opus55: priced.find((x) => /claude-opus-5\.5-high-vertex-agent$/.test(x.key)),
  deepseek: priced.filter((x) => /deepseek/i.test(x.key)).slice(0, 4).map((x) => ({key: x.key, in: x.in, out: x.out})),
};
