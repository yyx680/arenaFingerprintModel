/* 校验：/leaderboard RSC 里到底有多少行带价？
   （上次提取 208 行，但 inputPricePerMillion 出现 471 次 → 可能漏了。） */
const out = {};

for (const path of ['/leaderboard', '/leaderboard/agent/pareto']) {
  const r = await fetch(path, {headers: {'RSC': '1'}, credentials: 'include'});
  const t = await r.text();
  const rec = {status: r.status, len: t.length};

  // 出现次数
  rec.key_occurrences = (t.match(/"inputPricePerMillion"/g) || []).length;

  // 花括号配对抽出每个 modelKey 对象，统计「带非空 inputPricePerMillion」的
  const rows = [];
  const RE = /\{\\?"modelKey\\?":\\?"([^"\\]+)\\?"/g;
  let m;
  while ((m = RE.exec(t)) !== null) {
    // 从这个位置向后取 1600 字符，找该对象内的价格
    const seg = t.slice(m.index, m.index + 1600);
    const inM = seg.match(/\\?"inputPricePerMillion\\?":\s*(\\?"?[\d.]+|null)/);
    const outM = seg.match(/\\?"outputPricePerMillion\\?":\s*(\\?"?[\d.]+|null)/);
    const norm = (s) => (s == null ? null : String(s).replace(/\\?"/g, ''));
    rows.push({key: m[1], in: norm(inM && inM[1]), out: norm(outM && outM[1])});
  }
  rec.modelKey_rows = rows.length;
  const uniq = new Map();
  for (const x of rows) if (!uniq.has(x.key)) uniq.set(x.key, x);
  rec.unique_keys = uniq.size;
  const priced = [...uniq.values()].filter((x) => x.in && x.in !== 'null');
  rec.priced_unique = priced.length;
  rec.priced_samples = priced.slice(0, 6);
  // 有没有我上次漏掉的（inputPrice 非空但 outputPrice 为 null 的也算）
  rec.in_only = [...uniq.values()].filter((x) => x.in && x.in !== 'null' && (!x.out || x.out === 'null')).length;
  rec.out_only = [...uniq.values()].filter((x) => x.out && x.out !== 'null' && (!x.in || x.in === 'null')).length;
  out[path] = rec;
}

// 对比随包表
try {
  const r = await fetch('/arena-pricing-table.json');
  out.bundled_status = r.status;
} catch (e) { out.bundled_status = 'n/a (页面域)'; }

return out;
