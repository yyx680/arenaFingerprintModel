// Canary reconnaissance: PostHog flags + every /api path referenced in the canary JS bundles.
const out = { flags: null, env: null, apiPaths: [], nextjsApiPaths: [] };
try {
  if (window.posthog && window.posthog.featureFlags) {
    const f = window.posthog.featureFlags.getFlags ? window.posthog.featureFlags.getFlags() : null;
    out.flags = f ? Object.keys(f).slice(0, 80) : null;
  }
} catch (e) { out.flagsErr = String(e); }
const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src).filter(u => u.includes('/_next/'));
out.chunkCount = scripts.length;
const found = new Map();
for (const url of scripts) {
  try {
    const t = await fetch(url).then(r => r.text());
    let m;
    const re = /["'`](\/(?:api|nextjs-api|ai-proxy)\/[a-zA-Z0-9_\-{}$:./\[\]]{1,80})["'`]/g;
    while ((m = re.exec(t)) !== null) {
      found.set(m[1], (found.get(m[1]) || 0) + 1);
    }
  } catch {}
}
out.apiPaths = [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([p, c]) => p + ' :' + c);
return out;
