/* 校验（简洁版）：数清 /leaderboard RSC 里带价的模型行。 */
const out = {};
const r = await fetch('/leaderboard', {headers: {'RSC': '1'}, credentials: 'include'});
const t = await r.text();
out.len = t.length;

// 1) 两种形态都数
out.forms = {
  plain_in: (t.match(/"inputPricePerMillion"/g) || []).length,
  escaped_in: (t.match(/\\"inputPricePerMillion\\"/g) || []).length,
  plain_modelKey: (t.match(/"modelKey"/g) || []).length,
  escaped_modelKey: (t.match(/\\"modelKey\\"/g) || []).length,
  plain_display: (t.match(/"modelDisplayName"/g) || []).length,
};

// 2) 值分布：inputPricePerMillion 后面跟的值
const vals = [...t.matchAll(/inputPricePerMillion\\?":\s*(null|-?\d+(?:\.\d+)?)/g)].map((m) => m[1]);
out.value_hits = vals.length;
out.non_null = vals.filter((v) => v !== 'null').length;
out.null_count = vals.filter((v) => v === 'null').length;
out.uniq_values = [...new Set(vals)].slice(0, 25);

// 3) 抽 modelKey
const keys = [...t.matchAll(/modelKey\\?":\s*\\?"([^"\\]+)\\?"/g)].map((m) => m[1]);
out.key_hits = keys.length;
out.uniq_keys = new Set(keys).size;
out.sample_keys = [...new Set(keys)].slice(0, 12);

// 4) 逐行配对：用 modelKey 位置与下一个 inputPrice 位置配对
const rows = [];
const kpos = [...t.matchAll(/modelKey\\?":\s*\\?"([^"\\]+)\\?"/g)];
for (const km of kpos) {
  const seg = t.slice(km.index, km.index + 1200);
  const im = seg.match(/inputPricePerMillion\\?":\s*(null|-?\d+(?:\.\d+)?)/);
  const om = seg.match(/outputPricePerMillion\\?":\s*(null|-?\d+(?:\.\d+)?)/);
  rows.push({key: km[1], in: im ? im[1] : 'MISSING', out: om ? om[1] : 'MISSING'});
}
const uniq = new Map();
for (const x of rows) if (!uniq.has(x.key)) uniq.set(x.key, x);
out.rows_total = rows.length;
out.rows_unique = uniq.size;
const priced = [...uniq.values()].filter((x) => x.in !== 'null' && x.in !== 'MISSING');
out.priced_unique = priced.length;
out.priced_sample = priced.slice(0, 8);
out.in_null_unique = [...uniq.values()].filter((x) => x.in === 'null').length;
out.in_missing_unique = [...uniq.values()].filter((x) => x.in === 'MISSING').length;
// 输出价缺失但输入价有的
out.output_null_unique = [...uniq.values()].filter((x) => x.out === 'null').length;

return out;
