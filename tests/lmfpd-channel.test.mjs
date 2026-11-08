import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  analyzeLmfpdOutputs,
  decodeLmfpdDetector,
  lmfpdBankMatches,
  lmfpdSummary,
} from '../lmfpd-channel.js';

const root = new URL('../', import.meta.url);
const bank = JSON.parse(await readFile(new URL('lmfpd-data/unified_bank.json', root), 'utf8'));
const detector = decodeLmfpdDetector(new Uint8Array(await readFile(new URL('lmfpd-data/shared_detector.bin', root))));

/* 定种子 PRNG：保证序列形状（model_like 门）在每次运行一致。 */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const alternating = (rnd, n) => Array.from({length: n}, (_, i) =>
  i % 2 ? 40 + Math.floor(rnd() * 50) : 260 + Math.floor(rnd() * 60));
const text = numbers => numbers.join(',');

test('bundled lmfpd data decodes and matches its detector', () => {
  assert.equal(bank.schema, 'lmfpd-data-v1');
  assert.equal(bank.models.length, 66);
  assert.equal(detector.schema, 'shared-detector-v2');
  assert.equal(lmfpdBankMatches(bank, detector), true);
});

test('uniform noise is rejected as not model-like', () => {
  const rnd = mulberry32(7);
  const outputs = [297, 315, 331].map(n => ({text: text(Array.from({length: n}, () => 1 + Math.floor(rnd() * 355))), expected_count: n}));
  const analysis = analyzeLmfpdOutputs(outputs, bank, detector);
  assert.equal(analysis.decision, 'not_model');
  assert.equal(analysis.results.length, 0);
  assert.equal(analysis.sequence.model_like, false);
});

test('model-like alternating sequences produce a calibrated ranking', () => {
  const rnd = mulberry32(42);
  const outputs = [297, 315, 331].map(n => ({text: text(alternating(rnd, n)), expected_count: n}));
  const analysis = analyzeLmfpdOutputs(outputs, bank, detector);
  assert.equal(analysis.decision, 'scored');
  assert.equal(analysis.used_outputs, 3);
  assert.equal(analysis.results.length, 66);
  assert.equal(analysis.probability_status, 'reference_calibrated');
  assert.ok(analysis.probability > 0 && analysis.probability <= 1);
  assert.ok(analysis.results[0].score >= analysis.results[1].score);
});

test('single valid reply yields a partial ranking without probability', () => {
  const rnd = mulberry32(11);
  const numbers = alternating(rnd, 297);
  const analysis = analyzeLmfpdOutputs([{text: text(numbers), expected_count: 297}], bank, detector);
  assert.equal(analysis.decision, 'partial');
  assert.equal(analysis.used_outputs, 1);
  assert.equal(analysis.probability, null);
  assert.equal(analysis.results.length, 66);
  assert.ok(analysis.results[0].score > analysis.results[1].score);
});

test('empty and malformed inputs are rejected or unscorable', () => {
  assert.throws(() => analyzeLmfpdOutputs([], bank, detector));
  assert.throws(() => analyzeLmfpdOutputs([{text: '1,2,3', expected_count: 0}], bank, detector));
  const analysis = analyzeLmfpdOutputs([{text: 'no numbers here', expected_count: 297}], bank, detector);
  assert.equal(analysis.decision, 'unscorable');
  assert.equal(analysis.used_outputs, 0);
});

test('lmfpdSummary normalizes model ids for agreement', () => {
  const fake = {
    decision: 'scored', prediction: 'claude-opus-5.5', prediction_name: 'Claude Opus 5.5',
    probability: 0.72, probability_status: 'reference_calibrated', used_outputs: 3,
    results: [{model: 'claude-opus-5.5', display_name: 'Claude Opus 5.5', family: 'claude', family_name: 'Claude', score: 1, probability: 0.72}],
    sequence: {model_like: true},
  };
  assert.equal(lmfpdSummary(fake, {id: 'claude-opus-5-5', family: 'claude'}).agreement, 'lmfpd 一致');
  assert.equal(lmfpdSummary(fake, {id: 'claude-sonnet-5', family: 'claude'}).agreement, 'lmfpd 同族');
  assert.equal(lmfpdSummary(fake, {id: 'gpt-6-astra', family: 'gpt'}).agreement, 'lmfpd 不一致');
  assert.equal(lmfpdSummary({...fake, decision: 'not_model', results: []}, {id: 'x'}).agreement, 'lmfpd 判非模型序列');
  assert.equal(lmfpdSummary({...fake, decision: 'unscorable', results: []}, {id: 'x'}).agreement, '无有效排名');
  const summary = lmfpdSummary(fake, null);
  assert.equal(summary.probability, 0.72);
  assert.equal(summary.top3.length, 1);
});
