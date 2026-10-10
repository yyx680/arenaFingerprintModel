/* 冒烟（不是全量测试）：统计层方向性验证 —— 同模型抽样应相容、均匀噪声应被整体拒绝、
   留出验证与同质性应分别对「真/假模型」和「同源/混源证据」做出区分。
   node tests/fingerprint-tests.smoke.mjs [trueTrials] [noiseTrials] */
import { readFileSync } from 'node:fs';
import { identifyPrepared, prepareOutputs, TUNING } from '../model-probe-engine.js';

const bank = JSON.parse(readFileSync(new URL('../modeltrace-bank.json', import.meta.url), 'utf8'));
const DIM = bank.models[0].counts.length;
let state = 0x5eed1234;
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

function identify(answers) {
  const outputs = answers.map(({ values, expected }) => ({ text: values.join(', '), expected_count: expected }));
  return identifyPrepared(prepareOutputs(outputs), bank);
}

const TRUE_TRIALS = Number(process.argv[2] || 12);
const NOISE_TRIALS = Number(process.argv[3] || 30);

console.log(`bank: ${bank.models.length} models | statMode=${TUNING.statMode} statDraws=${TUNING.statDraws} statAlpha=${TUNING.statAlpha}`);

let hits = 0, compatible = 0, rejectedTrue = 0;
const started = Date.now();
for (let trial = 0; trial < TRUE_TRIALS; trial += 1) {
  const model = bank.models[Math.floor(rnd() * bank.models.length)];
  const result = identify([{ values: sampleFrom(model.counts, 315), expected: 315 }]);
  const target = bare(model.id);
  if (bare(result.nearest.id) === target) hits += 1;
  if (result.signals.tests && result.signals.tests.set_ids.includes(target)) compatible += 1;
  if (result.signals.tests && result.signals.tests.rejected_all) rejectedTrue += 1;
}
const trueMs = Date.now() - started;
console.log(`true draws (1 answer, ${TRUE_TRIALS}): nearest-hit ${(hits / TRUE_TRIALS * 100).toFixed(0)}% | true model compatible ${(compatible / TRUE_TRIALS * 100).toFixed(0)}% | rejected-all ${(rejectedTrue / TRUE_TRIALS * 100).toFixed(0)}%  [${(trueMs / TRUE_TRIALS).toFixed(0)} ms/run]`);

let verifyPass = 0, homoPass = 0, threeClear = 0, threeSepSig = 0;
const THREE = Math.min(6, TRUE_TRIALS);
for (let trial = 0; trial < THREE; trial += 1) {
  const model = bank.models[Math.floor(rnd() * bank.models.length)];
  const result = identify([297, 315, 331].map(expected => ({ values: sampleFrom(model.counts, expected), expected })));
  if (result.signals.verification && result.signals.verification.verified) verifyPass += 1;
  if (result.signals.homogeneity && result.signals.homogeneity.homogeneous) homoPass += 1;
  if (result.status === 'clear') threeClear += 1;
  if (result.signals.separation_test && result.signals.separation_test.significant) threeSepSig += 1;
}
console.log(`true draws (3 answers, ${THREE}): held-out verified ${verifyPass}/${THREE} | homogeneous ${homoPass}/${THREE} | clear ${threeClear}/${THREE} | separation significant ${threeSepSig}/${THREE}`);

let noiseRejected = 0, noiseWeak = 0, noiseClear = 0;
const noiseStatus = new Map();
for (let trial = 0; trial < NOISE_TRIALS; trial += 1) {
  const result = identify([{ values: uniform(315), expected: 315 }]);
  if (result.signals.tests && result.signals.tests.rejected_all) noiseRejected += 1;
  if (result.status === 'weak') noiseWeak += 1;
  if (result.status === 'clear') noiseClear += 1;
  noiseStatus.set(result.reason, (noiseStatus.get(result.reason) || 0) + 1);
}
console.log(`uniform noise (${NOISE_TRIALS}): rejected-all ${(noiseRejected / NOISE_TRIALS * 100).toFixed(0)}% | weak ${(noiseWeak / NOISE_TRIALS * 100).toFixed(0)}% | clear ${noiseClear} | reasons ${JSON.stringify([...noiseStatus])}`);

let noise3Rejected = 0, noise3SepSig = 0;
const NOISE3 = Math.min(12, NOISE_TRIALS);
for (let trial = 0; trial < NOISE3; trial += 1) {
  const result = identify([297, 315, 331].map(expected => ({ values: uniform(expected), expected })));
  if (result.signals.tests && result.signals.tests.rejected_all) noise3Rejected += 1;
  if (result.signals.separation_test && result.signals.separation_test.significant) noise3SepSig += 1;
}
console.log(`uniform noise (3 answers, ${NOISE3}): rejected-all ${noise3Rejected}/${NOISE3} | separation significant ${noise3SepSig}/${NOISE3}`);

let mixedFlagged = 0;
const MIXED = Math.min(8, TRUE_TRIALS);
for (let trial = 0; trial < MIXED; trial += 1) {
  const first = bank.models[Math.floor(rnd() * bank.models.length)];
  const second = bank.models[Math.floor(rnd() * bank.models.length)];
  const result = identify([
    { values: sampleFrom(first.counts, 297), expected: 297 },
    { values: sampleFrom(second.counts, 315), expected: 315 },
  ]);
  if (result.signals.homogeneity && result.signals.homogeneity.applicable && !result.signals.homogeneity.homogeneous) mixedFlagged += 1;
}
console.log(`mixed-source evidence (${MIXED}): flagged heterogeneous ${mixedFlagged}/${MIXED}`);
