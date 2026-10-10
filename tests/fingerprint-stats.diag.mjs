/* 诊断（临时）：4 种条件下统计层的数字。node tests/fingerprint-stats.diag.mjs */
import { readFileSync } from 'node:fs';
import { identifyPrepared, prepareOutputs } from '../model-probe-engine.js';

const bank = JSON.parse(readFileSync(new URL('../modeltrace-bank.json', import.meta.url), 'utf8'));
const DIM = bank.models[0].counts.length;
let state = 0x77aa11ee;
const rnd = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };

function sampleFrom(counts, size) {
  const total = counts.reduce((a, c) => a + c, 0);
  const cum = []; let run = 0;
  for (const c of counts) { run += (c + 0.5) / (total + 0.5 * counts.length); cum.push(run); }
  const out = [];
  for (let i = 0; i < size; i += 1) {
    const t = rnd() * run; let lo = 0, hi = counts.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < t) lo = mid + 1; else hi = mid; }
    out.push(lo + 1);
  }
  return out;
}
const uniform = size => Array.from({ length: size }, () => 1 + Math.floor(rnd() * DIM));
const bare = id => String(id).split('@', 1)[0];

function run(answers) {
  const outputs = answers.map(({ values, expected }) => ({ text: values.join(', '), expected_count: expected }));
  const result = identifyPrepared(prepareOutputs(outputs), bank);
  const t = result.signals.tests;
  return {
    nearest: bare(result.nearest.id),
    fit: result.signals.fit,
    floor: result.signals.fit_floor,
    status: result.status + '/' + result.reason,
    best: t ? t.best : null,
    best_z: t ? t.best_z : null,
    p_adj: t ? t.best_p_adjusted : null,
    set: t ? t.set_size : null,
    rejected: t ? t.rejected_all : null,
    verify: result.signals.verification && result.signals.verification.applicable ? result.signals.verification.verified : null,
    spread: result.signals.homogeneity && result.signals.homogeneity.applicable ? Number(result.signals.homogeneity.spread.toFixed(2)) : null,
  };
}
const show = (label, row) => console.log(label.padEnd(10), JSON.stringify(row));

for (let trial = 0; trial < 5; trial += 1) {
  const model = bank.models[Math.floor(rnd() * bank.models.length)];
  show('1a-true', {target: bare(model.id), ...run([{ values: sampleFrom(model.counts, 315), expected: 315 }])});
}
for (let trial = 0; trial < 5; trial += 1) {
  show('1a-noi', run([{ values: uniform(315), expected: 315 }]));
}
for (let trial = 0; trial < 5; trial += 1) {
  const model = bank.models[Math.floor(rnd() * bank.models.length)];
  show('3a-true', {target: bare(model.id), ...run([297, 315, 331].map(expected => ({ values: sampleFrom(model.counts, expected), expected })))});
}
for (let trial = 0; trial < 5; trial += 1) {
  show('3a-noi', run([297, 315, 331].map(expected => ({ values: uniform(expected), expected }))));
}
