// Scan embedded RSC flight payload for any usage/token/cost fields (server-rendered data).
const out = { chunks: 0, hits: [] };
if (Array.isArray(window.__next_f)) {
  out.chunks = window.__next_f.length;
  const re = /[A-Za-z_]{0,12}(usage|inputTokens|outputTokens|totalTokens|cacheRead|cacheWrite|reasoningTokens|totalCostUsd|actualTotalUsd|chargedTotalUsd|costMultiplier|totalChargedCredits|basePriceUsd)[A-Za-z_]{0,12}\s*"?\s*:\s*"?[0-9]/g;
  let total = 0;
  for (const [, chunk] of window.__next_f) {
    if (typeof chunk !== 'string') continue;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(chunk)) !== null && out.hits.length < 30) {
      out.hits.push(chunk.slice(Math.max(0, m.index - 60), m.index + 120).replace(/\\n/g, ' '));
    }
  }
}
return out;
