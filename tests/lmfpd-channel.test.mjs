import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {zstdCompressSync, zstdDecompressSync} from 'node:zlib';
import {decompress as fzstdDecompress} from '../fzstd.js';
import {
  LMFPD_ASTRA_SHARED_ID,
  LMFPD_LOW_CONFIDENCE_THRESHOLD,
  analyzeLmfpdOutputs,
  decodeLmfpdDetector,
  detectAnomalousSamples,
  identifyWithLmfpd,
  lmfpdBankMatches,
  lmfpdSummary,
  refreshLmfpdChannel,
  validateBundleMeta,
} from '../lmfpd-channel.js';

const root = new URL('../', import.meta.url);
const bank = JSON.parse(await readFile(new URL('lmfpd-data/unified_bank.json', root), 'utf8'));
const detectorBytes = new Uint8Array(await readFile(new URL('lmfpd-data/shared_detector.bin', root)));
const detector = decodeLmfpdDetector(detectorBytes);
const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

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

test('bundled lmfpd data decodes and matches latest 75-model detector', () => {
  assert.equal(bank.schema, 'lmfpd-data-v1');
  assert.equal(bank.models.length, 75);
  assert.equal(detector.schema, 'shared-detector-v2');
  assert.equal(lmfpdBankMatches(bank, detector), true);
  assert.ok(bank.models.some(m => m.id === 'gpt-6.2-sol'));
  assert.ok(bank.models.some(m => m.id === 'gemini-4-neon'));
});

test('fzstd.js pure-JS decompression matches Node zlib.zstdDecompressSync', () => {
  const sample = new TextEncoder().encode(JSON.stringify({models: bank.models.slice(0, 5), check: 'zstd-parity'}));
  const compressed = new Uint8Array(zstdCompressSync(sample));
  const byJs = fzstdDecompress(compressed);
  const byNode = new Uint8Array(zstdDecompressSync(compressed));
  assert.deepEqual(byJs, byNode);
  assert.deepEqual(byJs, sample);
});

test('uniform noise is rejected as not model-like', () => {
  const rnd = mulberry32(7);
  const outputs = [297, 315, 331].map(n => ({text: text(Array.from({length: n}, () => 1 + Math.floor(rnd() * 355))), expected_count: n}));
  const analysis = analyzeLmfpdOutputs(outputs, bank, detector);
  assert.equal(analysis.decision, 'not_model');
  assert.equal(analysis.results.length, 0);
  assert.equal(analysis.sequence.model_like, false);
});

test('nearby_pair_share <= 0.07 accepts model-like sequence even when autocorrelation and small_step_share exceed limits', () => {
  const seq = [];
  for (let i = 0; i < 19; i += 1) seq.push(10 + i * 10);
  const cycle = [5, 40, 75, 110, 145, 350, 315, 280, 245, 210];
  while (seq.length < 297) seq.push(cycle[seq.length % cycle.length]);
  const outputs = [297, 315, 331].map(n => {
    const s = seq.slice();
    while (s.length < n) s.push(cycle[s.length % cycle.length]);
    return {text: text(s), expected_count: n};
  });
  const analysis = analyzeLmfpdOutputs(outputs, bank, detector);
  assert.equal(analysis.decision, 'scored');
  assert.ok(analysis.sequence.autocorrelation > -0.23);
  assert.ok(analysis.sequence.small_step_share > 0.05);
  assert.ok(analysis.sequence.nearby_pair_share <= 0.07);
  assert.equal(analysis.sequence.model_like, true);
});

test('model-like alternating sequences produce a calibrated ranking across 75 models', () => {
  const rnd = mulberry32(42);
  const outputs = [297, 315, 331].map(n => ({text: text(alternating(rnd, n)), expected_count: n}));
  const analysis = analyzeLmfpdOutputs(outputs, bank, detector);
  assert.equal(analysis.decision, 'scored');
  assert.equal(analysis.used_outputs, 3);
  assert.equal(analysis.results.length, 75);
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
  assert.equal(analysis.results.length, 75);
  assert.ok(analysis.results[0].score > analysis.results[1].score);
});

test('detectAnomalousSamples flags accepted replies whose minimum value is >= 200', () => {
  const high = Array.from({length: 297}, (_, i) => 200 + (i % 150)).join(',');
  const normal = Array.from({length: 315}, (_, i) => 1 + (i % 355)).join(',');
  const outputs = [
    {text: high, expected_count: 297},
    {text: normal, expected_count: 315},
    {text: high, expected_count: 331},
  ];
  const diagnostics = [{accepted: true}, {accepted: true}, {accepted: false}];
  assert.deepEqual(detectAnomalousSamples(outputs, diagnostics), [0]);
});

test('identifyWithLmfpd maps confident clear, low confidence, partial, not_model, and astra shared-base notes', () => {
  const channel = {bank, detector, builtAt: bank.built_at, sha256: sha256Hex(detectorBytes), origin: 'bundled'};
  const rnd = mulberry32(42);
  const outputs = [297, 315, 331].map(n => ({text: text(alternating(rnd, n)), expected_count: n}));

  const highTauDetector = {
    ...detector,
    calibration: {...detector.calibration, tau: 50},
  };
  const confident = identifyWithLmfpd(outputs, {...channel, detector: highTauDetector});
  assert.equal(confident.decision, 'scored');
  assert.ok(confident.signals.probability >= LMFPD_LOW_CONFIDENCE_THRESHOLD);
  assert.equal(confident.status, 'clear');
  assert.equal(confident.reason, 'lmfpd_calibrated_confident');
  assert.equal(confident.bank_models, 75);
  assert.equal(confident.bank_source, 'Fingerpoint Detector（lm.ikale.io）');

  const lowTauDetector = {
    ...detector,
    calibration: {...detector.calibration, tau: 0.002},
  };
  const lowConf = identifyWithLmfpd(outputs, {...channel, detector: lowTauDetector});
  assert.equal(lowConf.decision, 'scored');
  assert.ok(lowConf.signals.probability < LMFPD_LOW_CONFIDENCE_THRESHOLD);
  assert.equal(lowConf.status, 'close');
  assert.equal(lowConf.reason, 'lmfpd_low_confidence');
  assert.equal(lowConf.signals.low_confidence, true);

  const partial = identifyWithLmfpd([{text: text(alternating(mulberry32(11), 297)), expected_count: 297}], channel);
  assert.equal(partial.decision, 'partial');
  assert.equal(partial.status, 'close');
  assert.equal(partial.reason, 'lmfpd_partial_samples');

  const noise = [297, 315, 331].map(n => ({text: text(Array.from({length: n}, () => 1 + Math.floor(rnd() * 355))), expected_count: n}));
  const notModel = identifyWithLmfpd(noise, channel);
  assert.equal(notModel.decision, 'not_model');
  assert.equal(notModel.status, 'weak');
  assert.equal(notModel.reason, 'lmfpd_not_model');

  const astraIdx = bank.models.findIndex(m => m.id === LMFPD_ASTRA_SHARED_ID);
  assert.ok(astraIdx >= 0);
  const astraDetector = {
    ...detector,
    ranker: {
      ...detector.ranker,
      positional: {
        ...detector.ranker.positional,
        bias: detector.ranker.positional.bias.map((b, i) => (i === astraIdx ? b + 1e6 : b)),
      },
    },
  };
  const astraResult = identifyWithLmfpd(outputs, {...channel, detector: astraDetector});
  assert.equal(astraResult.nearest.id, LMFPD_ASTRA_SHARED_ID);
  assert.match(astraResult.signals.shared_base_note, /gpt-6-astra.*gpt-6\.1-sol/);
});

test('refreshLmfpdChannel short-circuits when remote matches current sha256/built_at', async () => {
  const currentSha = sha256Hex(detectorBytes);
  const current = {bank, detector, builtAt: bank.built_at, sha256: currentSha, origin: 'bundled'};
  const calls = [];
  const res = await refreshLmfpdChannel({
    current,
    sources: ['https://lm.ikale.io/data/'],
    persist: () => { throw new Error('should not persist'); },
    fetchImpl: async url => {
      calls.push(url);
      if (url.endsWith('bundle.json')) {
        return {ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(bank)).buffer};
      }
      throw new Error('should not fetch chunks when already up to date');
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.updated, false);
  assert.equal(res.up_to_date, true);
  assert.equal(calls.length, 1);
});

test('refreshLmfpdChannel downloads chunks, verifies SHA-256, decompresses via fzstd, and persists', async () => {
  const nextBuiltAt = '2026-11-25T00:00:00+00:00';
  const nextDetectorObj = {...detector, bank_built_at: nextBuiltAt};
  const headerBuf = new TextEncoder().encode(JSON.stringify(nextDetectorObj));
  const paddedStart = Math.ceil((4 + headerBuf.length) / 4) * 4;
  const binBuf = new Uint8Array(paddedStart);
  new DataView(binBuf.buffer).setUint32(0, headerBuf.length, true);
  binBuf.set(headerBuf, 4);
  const nextSha = sha256Hex(binBuf);
  const packed = new Uint8Array(zstdCompressSync(binBuf));
  const nextBundle = {
    ...bank,
    built_at: nextBuiltAt,
    files: {'shared_detector.bin': {parts: ['chunk0.zst', 'chunk1.zst'], bytes: packed.length, sha256: nextSha}},
  };
  const mid = Math.floor(packed.length / 2);
  let persistedRecord = null;
  const res = await refreshLmfpdChannel({
    current: {bank, detector, builtAt: bank.built_at, sha256: sha256Hex(detectorBytes), origin: 'bundled'},
    sources: ['https://lm.ikale.io/data/'],
    persist: async rec => { persistedRecord = rec; return true; },
    fetchImpl: async url => {
      if (url.endsWith('bundle.json')) {
        return {ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(nextBundle)).buffer};
      }
      if (url.endsWith('chunks/chunk0.zst')) return {ok: true, status: 200, arrayBuffer: async () => packed.slice(0, mid).buffer};
      if (url.endsWith('chunks/chunk1.zst')) return {ok: true, status: 200, arrayBuffer: async () => packed.slice(mid).buffer};
      return {ok: false, status: 404};
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.updated, true);
  assert.equal(res.persisted, true);
  assert.equal(res.info.built_at, nextBuiltAt);
  assert.equal(res.info.sha256, nextSha);
  assert.equal(res.info.origin, 'remote');
  assert.ok(persistedRecord);
  assert.deepEqual(persistedRecord.detectorBytes, binBuf);
});

test('refreshLmfpdChannel rejects path traversal parts and sha256 mismatches', async () => {
  assert.throws(() => validateBundleMeta({
    ...bank,
    files: {'shared_detector.bin': {parts: ['../evil.zst'], bytes: 100, sha256: '0'.repeat(64)}},
  }), /非法的分片文件名/);

  const badBundle = {
    ...bank,
    built_at: '2026-11-26T00:00:00+00:00',
    files: {'shared_detector.bin': {parts: ['bad.zst'], bytes: 100, sha256: 'f'.repeat(64)}},
  };
  const packed = new Uint8Array(zstdCompressSync(new Uint8Array([1, 2, 3, 4])));
  await assert.rejects(() => refreshLmfpdChannel({
    current: null,
    sources: ['https://lm.ikale.io/data/'],
    persist: false,
    fetchImpl: async url => {
      if (url.endsWith('bundle.json')) return {ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(badBundle)).buffer};
      return {ok: true, status: 200, arrayBuffer: async () => packed.buffer};
    },
  }), /SHA-256 校验失败/);
});

test('empty and malformed inputs are rejected or unscorable', () => {
  assert.throws(() => analyzeLmfpdOutputs([], bank, detector));
  assert.throws(() => analyzeLmfpdOutputs([{text: '1,2,3', expected_count: 0}], bank, detector));
  const analysis = analyzeLmfpdOutputs([{text: 'no numbers here', expected_count: 297}], bank, detector);
  assert.equal(analysis.decision, 'unscorable');
  assert.equal(analysis.used_outputs, 0);
});

test('lmfpdSummary normalizes model ids for agreement and supports primary mode', () => {
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
  assert.equal(summary.agreement, '');
});
