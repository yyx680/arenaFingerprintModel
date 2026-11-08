// Does the canary agent UI surface any token/cost/usage text or controls?
const out = { textHits: [], attrHits: [], flagCheck: {} };
const body = document.body.innerText || '';
const lines = body.split('\n');
for (const ln of lines) {
  if (/token|usage|cost|credit|\$|spend|quota|计费|用量/i.test(ln) && ln.trim().length < 160) out.textHits.push(ln.trim());
  if (out.textHits.length > 30) break;
}
// attributes (aria-label/title/data-*) mentioning tokens/cost
const all = document.querySelectorAll('[aria-label],[title],[data-testid]');
for (const el of all) {
  const s = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid')].filter(Boolean).join(' ');
  if (/token|usage|cost|credit|spend/i.test(s)) out.attrHits.push(s.slice(0, 100));
  if (out.attrHits.length > 20) break;
}
// posthog known flags
try {
  const names = ['credit-system-m1', 'credit-system-m2', 'cost-visibility', 'agent-usage', 'usage-display', 'token-usage'];
  for (const n of names) {
    try { out.flagCheck[n] = window.posthog ? window.posthog.getFeatureFlag(n) : 'no-posthog'; } catch (e) { out.flagCheck[n] = 'err'; }
  }
} catch {}
out.href = location.href;
return out;
