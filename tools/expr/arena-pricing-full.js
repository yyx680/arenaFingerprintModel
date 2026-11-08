// 完整抽取公开的「逐模型 token 单价」表（含 cache 单价与 costPerTaskUsd）
const out = {at: new Date().toISOString(), pages: {}};

function enclosing(text, idx) {
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') depth++;
    else if (ch === '{') { if (depth === 0) return i; depth--; }
  }
  return -1;
}
function balanced(text, start, maxLen = 4000) {
  let depth = 0;
  let inString = false;
  let esc = false;
  const end = Math.min(text.length, start + maxLen);
  for (let i = start; i < end; i++) {
    const ch = text[i];
    if (inString) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function extract(text) {
  const rows = new Map();
  const RE = /"inputPricePerMillion"/g;
  let m;
  let guard = 0;
  while ((m = RE.exec(text)) && guard < 600) {
    guard++;
    const start = enclosing(text, m.index);
    if (start < 0) continue;
    const slice = balanced(text, start, 6000);
    if (!slice) continue;
    let obj;
    try { obj = JSON.parse(slice); } catch { continue; }
    const key = obj.modelKey || obj.modelDisplayName;
    if (!key) continue;
    rows.set(key, {
      key: obj.modelKey || null,
      model: obj.modelDisplayName || null,
      org: obj.modelOrganization || null,
      input: obj.inputPricePerMillion ?? null,
      output: obj.outputPricePerMillion ?? null,
      cacheRead: obj.cacheReadPricePerMillion ?? null,
      cacheWrite: obj.cacheWritePricePerMillion ?? null,
      imageInput: obj.imageInputPricePerMillion ?? null,
      imageOutput: obj.imageOutputPricePerMillion ?? null,
      textOutput: obj.textOutputPricePerMillion ?? null,
      costPerTask: obj.costPerTaskUsd ?? null,
      rating: obj.rating ?? null,
      votes: obj.votes ?? null,
      rank: obj.rank ?? null,
    });
  }
  return [...rows.values()];
}

for (const path of ['/leaderboard', '/leaderboard/agent', '/leaderboard/agent/pareto']) {
  try {
    const r = await fetch(path, {headers: {RSC: '1', accept: 'text/x-component'}, credentials: 'include'});
    const t = await r.text();
    const rows = extract(t);
    out.pages[path] = {
      status: r.status,
      len: t.length,
      rows: rows.length,
      priced: rows.filter((x) => x.input != null || x.output != null).length,
      withCostPerTask: rows.filter((x) => x.costPerTask != null).length,
      withCacheWrite: rows.filter((x) => x.cacheWrite != null).length,
      withCacheRead: rows.filter((x) => x.cacheRead != null).length,
      all: rows.filter((x) => x.input != null || x.output != null),
    };
  } catch (e) { out.pages[path] = {err: e.message}; }
}

return out;
