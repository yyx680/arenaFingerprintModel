/* Shared by the MAIN-world collector and ES-module usage channel.
 * Local heuristic only: no model-specific tokenizer, network, raw-text storage,
 * or measured accuracy claim. Ranges are sensitivity bands, not confidence intervals.
 */
(() => {
  const fields = Object.freeze(['chars','cjk','other','feature_chars','latin_units','digit_units',
    'punctuation_units','space_units','newline_units','cjk_units','unicode_units']);
  const units = fields.filter(key => key.endsWith('_units'));
  const safe = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, 1e8) : 0;
  const empty = () => Object.fromEntries([['version',2], ...fields.map(key => [key,0])]);
  const legacyCjk = cp => (cp>=0x2e80&&cp<=0x9fff)||(cp>=0xf900&&cp<=0xfaff)
    ||(cp>=0xff00&&cp<=0xff60)||(cp>=0x1f200&&cp<=0x1f2ff)||(cp>=0x20000&&cp<=0x2ffff);
  function normalize(value) {
    if (!value || typeof value !== 'object') return null;
    const bucket = empty();
    for (const key of fields) bucket[key] = safe(value[key]);
    const detailed = value.version === 2 && fields.every(key => typeof value[key] === 'number'
      && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1e8)
      && bucket.feature_chars === bucket.chars && bucket.cjk + bucket.other === bucket.chars;
    bucket.version = detailed ? 2 : 1;
    if (!detailed) {
      bucket.chars = bucket.cjk + bucket.other;
      bucket.feature_chars = 0;
      for (const key of units) bucket[key] = 0;
    }
    return bucket;
  }
  function add(target, value) {
    const source = normalize(value);
    if (!source) return target;
    if (source.chars && source.version !== 2) target.version = 1;
    for (const key of fields) target[key] = safe(target[key]) + source[key];
    return target;
  }
  function count(text) {
    const source = typeof text === 'string' ? text : '';
    const result = empty();
    for (const ch of source) {
      result.chars++;
      if (legacyCjk(ch.codePointAt(0))) result.cjk++; else result.other++;
    }
    // ASCII words/digits/whitespace/punctuation are grouped; Unicode is visited by code point.
    const chunks = /[A-Za-z]+|[0-9]+|[ \t]+|\r\n|[\r\n]|[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]+|./gsu;
    for (const match of source.matchAll(chunks)) {
      const chunk = match[0];
      if (/^[A-Za-z]/.test(chunk)) {
        const segments = chunk.match(/[A-Z]+(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|[A-Z]+/g) || [chunk];
        for (const segment of segments) result.latin_units += Math.max(1, segment.length / 4);
      } else if (/^[0-9]/.test(chunk)) {
        // Many BPE families group up to three digits; this remains a heuristic, not a tokenizer.
        result.digit_units += Math.ceil(chunk.length / 3);
      } else if (/^[ \t]/.test(chunk)) {
        const previous = source[match.index - 1] || '';
        const next = source[match.index + chunk.length] || '';
        const numericSeparator = /[0-9,;]/.test(previous) && /[0-9]/.test(next);
        result.space_units += (numericSeparator ? 1 : 0.15) + Math.max(0, chunk.length - 1) / 8;
      } else if (/^[\r\n]/.test(chunk)) {
        result.newline_units += 1;
      } else if (/^[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/.test(chunk)) {
        result.punctuation_units += Math.max(1, chunk.length / 2);
      } else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(chunk)) {
        result.cjk_units += /\p{Script=Hangul}/u.test(chunk) ? 1.5 : 1.1;
      } else {
        result.unicode_units += /\p{Extended_Pictographic}/u.test(chunk) ? 2.5 : /\s/u.test(chunk) ? 0.2 : 1.3;
      }
    }
    result.feature_chars = result.chars;
    return result;
  }
  function estimate(value) {
    const bucket = normalize(value) || empty();
    const detailed = bucket.version === 2;
    const raw = detailed ? units.reduce((sum,key) => sum + bucket[key],0) : bucket.cjk + bucket.other * 0.27;
    const tokens = raw > 0 ? Math.max(1,Math.round(raw)) : 0;
    return {
      tokens,
      low: tokens ? Math.max(1,Math.floor(tokens * (detailed ? 0.6 : 0.5))) : 0,
      high: tokens ? Math.ceil(tokens * (detailed ? 1.7 : 2)) : 0,
      method: detailed ? 'chars-v2' : 'chars-v1',
      range_kind: 'heuristic-sensitivity',
      calibrated: false,
    };
  }
  globalThis.ArenaTokenEstimator = Object.freeze({method:'chars-v2',fields,empty,normalize,add,count,estimate});
})();
