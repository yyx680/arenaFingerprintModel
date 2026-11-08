/* 把 /leaderboard RSC 里**带价的行**完整导出（裸 key，排除 contenders/ 摘要列表）。 */
const r = await fetch('/leaderboard', {headers: {'RSC': '1'}, credentials: 'include'});
const t = await r.text();
const rows = [];
let idx = 0;
while (true) {
  const k = t.indexOf('"modelKey"', idx);
  if (k < 0) break;
  idx = k + 10;
  let s = k; while (s > 0 && t[s] !== '{') s--;
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
  const pick = (n) => {
    const m = obj.match(new RegExp('"' + n + '"\\s*:\\s*(null|-?\\d+(?:\\.\\d+)?|"(?:[^"\\\\]|\\\\.)*")'));
    if (!m) return undefined;
    const v = m[1];
    return v === 'null' ? null : (v.startsWith('"') ? v.slice(1, -1) : Number(v));
  };
  const key = pick('modelKey');
  if (!key || key.includes('/')) continue;          // 排除 contenders/ 摘要
  const i2 = pick('inputPricePerMillion'), o2 = pick('outputPricePerMillion');
  if (typeof i2 !== 'number' || typeof o2 !== 'number' || i2 <= 0 || o2 <= 0) continue;
  rows.push({model_key: key, display: pick('modelDisplayName') ?? key, org: pick('modelOrganization') ?? null, input_usd_per_mtok: i2, output_usd_per_mtok: o2});
}
const uniq = new Map();
for (const x of rows) if (!uniq.has(x.model_key)) uniq.set(x.model_key, x);
const list = [...uniq.values()].sort((a, b) => a.model_key.localeCompare(b.model_key));
return {count: list.length, json: JSON.stringify(list)};
