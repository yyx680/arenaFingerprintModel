(async () => {
  const js = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js(\?|$)/.test(n));
  const names = js.map((n) => n.split('/').pop().split('?')[0]);
  const out = {jsCount: names.length,
    hasStableMarker: names.includes('0a9ax8-tkg7tt.js'),
    hasCanaryMarker: names.some((n) => ['02dlnsuklhfii.js', '1ayl912__p_aw.js', '1ll4pmkgrco0p.js', '1mt3g2-2-s40w.js'].includes(n)),
    sample: names.filter((n) => /^(0a|13-|1ll|02d|1ay|1mt)/.test(n)), dplAttr: document.documentElement.getAttribute('data-dpl-id')};
  const get = async (p) => { try { const r = await fetch(p); const t = await r.text(); return {s: r.status, len: t.length,
    env: (t.match(/deploymentEnv:"([a-z]+)"/) || [])[1] || null, api: (t.match(/arena-api-[a-z-]+\.arena-preview\.com/) || [])[0] || null,
    norm: (t.match(/let t="(production|canary|preview|development)";if\(t&&a\(t\)\)return t/) || [])[1] || null}; } catch (e) { return {err: String(e)}; } };
  out.stableChunk = await get('/_next/static/chunks/0a9ax8-tkg7tt.js');
  out.canaryChunk = await get('/_next/static/chunks/1ll4pmkgrco0p.js');
  return out;
})()
